// patch-abj.js — replaces verify.et integration with self-hosted ethio-pay-verify
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'api', '_lib.js');
if (!fs.existsSync(file)) {
  console.error('ERROR: api/_lib.js not found in ' + __dirname);
  process.exit(1);
}

let src = fs.readFileSync(file, 'utf8');
let changeCount = 0;

function replace(label, oldStr, newStr) {
  if (!src.includes(oldStr)) {
    console.log('  SKIP (already patched or not found): ' + label);
    return;
  }
  src = src.replace(oldStr, newStr);
  console.log('  OK: ' + label);
  changeCount++;
}

// ------------------------------------------------------------
// Change 1 — buildVerifyPayload: only support our 5 banks, drop settlementAccount
// ------------------------------------------------------------
const oldBuild = `function buildVerifyPayload(bankKey, { reference, suffix, phone, settlementAccount }) {
  const base = {};
  if (settlementAccount) base.settlementAccount = settlementAccount;

  switch (bankKey) {
    case 'cbe':
      return { bank: 'cbe', referenceNumber: reference, accountSuffix: suffix || undefined, ...base };
    case 'boa':
      return { bank: 'boa', referenceNumber: reference, accountSuffix: suffix || undefined, ...base };
    case 'telebirr':
      return { bank: 'telebirr', transactionNumber: reference, ...base };
    case 'mpesa':
      return { bank: 'mpesa', transactionNumber: reference, ...base };
    case 'cbebirr':
      return { bank: 'cbebirr', receiptNumber: reference, phone: phone || undefined, ...base };
    case 'dashen':
      return { bank: 'dashen', referenceNumber: reference, ...base };
    case 'awash':
      return { bank: 'awash', referenceNumber: reference, ...base };
    case 'siinqee':
      return { bank: 'siinqee', referenceNumber: reference, ...base };
    case 'kaafiebirr':
      return { bank: 'kaafiebirr', referenceNumber: reference, phone: phone || undefined, ...base };
    case 'zemen':
      return null;
    default:
      const universal = { reference };
      if (suffix) universal.suffix = suffix;
      if (phone) universal.phoneNumber = phone;
      return universal;
  }
}`;

const newBuild = `function buildVerifyPayload(bankKey, { reference, suffix, phone }) {
  switch (bankKey) {
    case 'cbe':
      return { bank: 'cbe', referenceNumber: reference, accountSuffix: suffix || undefined };
    case 'boa':
      return { bank: 'boa', referenceNumber: reference, accountSuffix: suffix || undefined };
    case 'telebirr':
      return { bank: 'telebirr', referenceNumber: reference };
    case 'mpesa':
      return { bank: 'mpesa', referenceNumber: reference };
    case 'dashen':
      return { bank: 'dashen', referenceNumber: reference };
    default:
      return null;
  }
}`;

replace('buildVerifyPayload rewritten for 5 supported banks', oldBuild, newBuild);

// ------------------------------------------------------------
// Change 2 — _pollStatus: use the configured API base instead of verify.et
// ------------------------------------------------------------
const oldPollStatus = `async function _pollStatus(statusUrl, apiKey) {
  try {
    const url = statusUrl.startsWith('http') ? statusUrl : \`https://verify.et\${statusUrl}\`;
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });`;

const newPollStatus = `async function _pollStatus(statusUrl, apiKey, apiBaseUrl) {
  try {
    const base = String(apiBaseUrl || '').replace(/\\/api\\/verify.*$/, '');
    const url = statusUrl.startsWith('http') ? statusUrl : \`\${base}\${statusUrl}\`;
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });`;

replace('_pollStatus takes apiBaseUrl and no longer hardcodes verify.et', oldPollStatus, newPollStatus);

// ------------------------------------------------------------
// Change 2b — pass cfg.verifyApiUrl to _pollStatus at call sites
// ------------------------------------------------------------
replace(
  '_pollStatus call sites pass apiBaseUrl',
  'const poll = await _pollStatus(statusUrl, cfg.verifyApiKey);',
  'const poll = await _pollStatus(statusUrl, cfg.verifyApiKey, cfg.verifyApiUrl);'
);

// ------------------------------------------------------------
// Change 3 — _interpret: drop settlementAccountMatch block
// ------------------------------------------------------------
const oldSettleBlock = `  const settle = item.settlementAccountMatch || {};
  if (settle.ambiguous) {
    return { result: 'mismatch', message: "We couldn't confirm the recipient account. Upload a screenshot for manual review." };
  }
  if (settle.matched === false) {
    return { result: 'mismatch', message: 'This payment was sent to a different account than the one shown. Upload a screenshot for manual review.' };
  }`;

const newSettleBlock = `  // Recipient verification is handled inside the bank's API when accountSuffix is provided.
  // No settlementAccountMatch object is returned by ethio-pay-verify.`;

replace('_interpret: settlementAccountMatch block removed', oldSettleBlock, newSettleBlock);

// ------------------------------------------------------------
// Change 3b — _interpret: success return no longer references settle
// ------------------------------------------------------------
replace(
  '_interpret success return',
  "return { result: 'success', message: 'Verified', amount, receiver: settle.receiverAccount || item.receiverAccount || null };",
  "return { result: 'success', message: 'Verified', amount, receiver: item.receiverAccount || null };"
);

// ------------------------------------------------------------
// Change 4 — verifyPayment: remove settlementAccount from payload + add bank guard
// ------------------------------------------------------------
const oldVerifyPay = `  const bankKey = getBankKey(bankName);
  const suffix = deriveAccountSuffix(bankKey, bankAccount);
  const payload = buildVerifyPayload(bankKey, {
    reference: String(reference).trim(),
    suffix,
    phone: phone ? String(phone).trim() : null,
    settlementAccount: bankAccount ? String(bankAccount).trim() : null,
  });`;

const newVerifyPay = `  const bankKey = getBankKey(bankName);
  const SUPPORTED = ['cbe', 'telebirr', 'boa', 'dashen', 'mpesa'];
  if (!SUPPORTED.includes(bankKey)) {
    return {
      result: 'service_error',
      message: 'This payment method is not supported for auto-verification. Please upload a screenshot for manual review.',
    };
  }

  const suffix = deriveAccountSuffix(bankKey, bankAccount);
  const payload = buildVerifyPayload(bankKey, {
    reference: String(reference).trim(),
    suffix,
    phone: phone ? String(phone).trim() : null,
  });`;

replace('verifyPayment: bank guard + payload without settlementAccount', oldVerifyPay, newVerifyPay);

// ------------------------------------------------------------
// Change 5 — idempotency key prefix (avoid clashing with verify.et cache)
// ------------------------------------------------------------
replace(
  'idempotency key prefix',
  'const idemKey = `abj-${String(reference).trim()}-${bankKey || \'uni\'}-${suffix || \'x\'}`;',
  'const idemKey = `abj-ethio-${String(reference).trim()}-${bankKey || \'uni\'}-${suffix || \'x\'}`;'
);

// ------------------------------------------------------------
// Save
// ------------------------------------------------------------
fs.writeFileSync(file, src, 'utf8');
console.log('\nWrote api/_lib.js (' + changeCount + ' edits applied).');
console.log('\nNext steps:');
console.log('  1. Set System → API URL and API Key in the ABJ admin panel');
console.log('  2. Run: npx vercel dev --listen 3001');
console.log('  3. Test registration at http://localhost:3001');
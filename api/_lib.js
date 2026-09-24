const crypto = require('crypto');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  JWT_SECRET,
  ADMIN_PASSWORD,
} = process.env;

// All uploaded files (payment screenshots + chat media) live in this bucket.
// The bucket is PRIVATE — direct /object/public/ URLs now return 404.
// Access is granted only via short-lived signed URLs.
const STORAGE_BUCKET = 'screenshots';

// MIME types that are safe to serve inline in a signed URL.
// Anything outside this list is served as a downloadable octet-stream.
const SAFE_MIME = new Set([
  'image/jpeg','image/jpg','image/png','image/webp','image/gif',
  'application/pdf',
  'audio/webm','audio/ogg','audio/mpeg','audio/mp4',
]);

/* ============================================================
   Supabase REST
   ============================================================ */
async function supabaseQuery(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function supabaseInsert(table, record) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(record),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function supabaseUpdate(path, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function supabaseDelete(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  return { ok: res.ok, status: res.status };
}

async function supabaseRpc(fnName, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data, raw: text };
}

/* ============================================================
   Settings helpers
   ============================================================ */
async function getSetting(key, fallback = null) {
  const q = await supabaseQuery(`app_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  const row = q.data?.[0];
  if (!row || row.value == null) return fallback;
  const v = String(row.value);
  return v.trim() === '' ? fallback : v;
}

async function setSetting(key, value) {
  const existing = await supabaseQuery(`app_settings?key=eq.${encodeURIComponent(key)}&select=key`);
  if (existing.data && existing.data.length) {
    return supabaseUpdate(`app_settings?key=eq.${encodeURIComponent(key)}`,
      { value: String(value), updated_at: new Date().toISOString() });
  }
  return supabaseInsert('app_settings', { key, value: String(value) });
}

async function getFee() {
  const v = await getSetting('fee', null);
  if (v == null) return null;
  const n = parseFloat(v);
  if (isNaN(n) || n <= 0) return null;
  return n;
}

/* ============================================================
   Custom Banks
   ============================================================ */
async function getCustomBanks() {
  try {
    const q = await supabaseQuery(
      'banks?order=display_order.asc,created_at.asc&select=id,name,account_number,account_holder'
    );
    if (!q.ok || !Array.isArray(q.data)) return [];
    return q.data.map(b => ({
      id: b.id,
      name: String(b.name || '').trim().slice(0, 40),
      account: String(b.account_number || '').trim().slice(0, 40),
      holder: String(b.account_holder || '').trim().slice(0, 60),
    })).filter(b => b.name && b.account);
  } catch {
    return [];
  }
}

const STAT_KEYS = {
  students: { value: 'stat_students', label: 'stat_students_label' },
  gpa:      { value: 'stat_gpa',      label: 'stat_gpa_label' },
  scorers:  { value: 'stat_scorers',  label: 'stat_scorers_label' },
  views:    { value: 'stat_views',    label: 'stat_views_label' },
};

async function getPublicSettings() {
  const q = await supabaseQuery('app_settings?select=key,value');
  const s = {};
  (q.data || []).forEach(r => { s[r.key] = r.value; });

  const customBanks = await getCustomBanks();

  const feeNum = parseFloat(s.fee);
  const fee = (isNaN(feeNum) || feeNum <= 0) ? null : feeNum;

  const stats = {};
  for (const [id, k] of Object.entries(STAT_KEYS)) {
    const val = s[k.value];
    const lbl = s[k.label];
    if (val != null && String(val).trim() !== '' && lbl != null && String(lbl).trim() !== '') {
      stats[id] = {
        value: String(val).trim().slice(0, 20),
        label: String(lbl).trim().slice(0, 60),
      };
    }
  }

  return {
    fee,
    custom_banks: customBanks,
    stats,
    updated_at: new Date().toISOString(),
  };
}

/* ============================================================
   DYNAMIC CONFIG
   ============================================================ */
let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_MS = 60 * 1000;

async function getConfig() {
  const now = Date.now();
  if (_configCache && (now - _configCacheTime) < CONFIG_CACHE_MS) return _configCache;

  let s = {};
  try {
    const q = await supabaseQuery('app_settings?select=key,value');
    (q.data || []).forEach(r => { s[r.key] = r.value; });
  } catch {}

  _configCache = {
    tgChannelId:  s.tg_channel_id || '',
    tgBotToken:   s.tg_bot_token  || '',
    verifyApiUrl: s.verify_api_url || '',
    verifyApiKey: s.verify_api_key || '',
  };
  _configCacheTime = now;
  return _configCache;
}

function invalidateConfigCache() {
  _configCache = null;
  _configCacheTime = 0;
}

/* ============================================================
   RATE LIMIT MASTER SWITCH
   ============================================================ */
let _rlEnabledCache = null;
let _rlEnabledCacheTime = 0;
const RL_ENABLED_CACHE_MS = 30 * 1000;

async function isRateLimitEnabled() {
  const now = Date.now();
  if (_rlEnabledCache !== null && (now - _rlEnabledCacheTime) < RL_ENABLED_CACHE_MS) {
    return _rlEnabledCache;
  }
  try {
    const v = await getSetting('rate_limit_enabled', 'true');
    _rlEnabledCache = String(v).toLowerCase().trim() !== 'false';
  } catch {
    _rlEnabledCache = true;
  }
  _rlEnabledCacheTime = now;
  return _rlEnabledCache;
}

function invalidateRateLimitCache() {
  _rlEnabledCache = null;
  _rlEnabledCacheTime = 0;
}

/* ============================================================
   Password hashing (scrypt)
   ============================================================ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(test, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/* ============================================================
   JWT
   ============================================================ */
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function signJWT(payload, expiresInSec = 3600 * 4) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat: now, exp: now + expiresInSec };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(full));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}
function verifyJWT(token) {
  try {
    const [h, p, s] = String(token).split('.');
    if (!h || !p || !s) return null;
    const expected = b64url(crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest());
    const a = Buffer.from(s);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
function requireAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = verifyJWT(token);
  return payload && (payload.role === 'admin' || payload.role === 'super') ? payload : null;
}
function requireSuper(req) {
  const payload = requireAdmin(req);
  return payload && payload.role === 'super' ? payload : null;
}

/* ============================================================
   BANK DETECTION & PAYLOAD BUILDERS
   ============================================================ */
function getBankKey(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return null;

  if (n.includes('cbe birr') || n.includes('cbebirr') || n.includes('cbe-birr')) return 'cbebirr';

  if (n === 'cbe') return 'cbe';
  if (/\bcbe\b/.test(n)) return 'cbe';
  if (n.includes('commercial bank of ethiopia')) return 'cbe';

  if (n.includes('abyssinia') || /\bboa\b/.test(n)) return 'boa';
  if (n.includes('telebirr') || n.includes('tele birr') || n.includes('tele-birr')) return 'telebirr';
  if (n.includes('m-pesa') || n.includes('mpesa') || n.includes('m pesa')) return 'mpesa';
  if (n.includes('dashen')) return 'dashen';
  if (n.includes('awash')) return 'awash';
  if (n.includes('siinqee') || n.includes('sinqee')) return 'siinqee';
  if (n.includes('kaafie') || n.includes('kaafi')) return 'kaafiebirr';
  if (n.includes('zemen')) return 'zemen';
  return null;
}

function deriveAccountSuffix(bankKey, accountNumber) {
  const digits = String(accountNumber || '').replace(/\D/g, '');
  if (!digits) return null;
  if (bankKey === 'cbe') return digits.length >= 8 ? digits.slice(-8) : null;
  if (bankKey === 'boa') return digits.length >= 5 ? digits.slice(-5) : null;
  return null;
}

function buildVerifyPayload(bankKey, { reference, suffix, phone }) {
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
}

/* ============================================================
   Verify.ET
   ============================================================ */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _pollStatus(statusUrl, apiKey, apiBaseUrl) {
  try {
    const base = String(apiBaseUrl || '').replace(/\/api\/verify.*$/, '');
    const url = statusUrl.startsWith('http') ? statusUrl : `${base}${statusUrl}`;
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, data };
  } catch { return { status: 0, data: null }; }
}

function _interpret(body) {
  if (!body || typeof body !== 'object') {
    return {
      result: 'service_error',
      message: "We couldn't read the bank's response. You can upload a screenshot for manual review.",
    };
  }
  const items = body.data;
  const verification = body.verification || {};
  const item = Array.isArray(items) ? (items[0] || {}) : (items && typeof items === 'object' ? items : {});
  let verified = item.verified;
  if (verified == null) verified = verification.verified;
  const txStatus = item.status || verification.status;
  const pstatus = item.processingStatus || verification.processingStatus;

  if (pstatus === 'failed' || txStatus === 'failed' || txStatus === 'not_found') {
    if (txStatus === 'not_found' || !item || Object.keys(item).length === 0) {
      return {
        result: 'not_found',
        message: "We couldn't find a payment with that Transaction ID at the bank. Double-check the ID, or upload a screenshot for manual review.",
      };
    }
    return {
      result: 'failed',
      message: 'The bank reports this transaction as unsuccessful. If you believe this is wrong, upload a screenshot for manual review.',
    };
  }
  if (!verified) {
    return {
      result: 'pending',
      message: "The bank hasn't finished confirming this payment yet. Upload a screenshot to speed up review.",
    };
  }

  // Recipient verification is handled inside the bank's API when accountSuffix is provided.
  // No settlementAccountMatch object is returned by ethio-pay-verify.

  const amountRaw = item.amount;
  let amount = null;
  if (amountRaw != null) {
    const cleaned = String(amountRaw).replace(/,/g, '').trim();
    const n = parseFloat(cleaned);
    if (!isNaN(n)) amount = n;
  }
  if (amount == null) {
    return { result: 'service_error', message: "We couldn't read the amount from the receipt. Upload a screenshot for manual review." };
  }

  return { result: 'success', message: 'Verified', amount, receiver: item.receiverAccount || null };
}

async function verifyPayment({ reference, bankName, bankAccount, phone }) {
  const cfg = await getConfig();
  if (!cfg.verifyApiKey) return { result: 'service_error', message: 'Verification service not configured. Please set it in the admin System tab.' };
  if (!cfg.verifyApiUrl) return { result: 'service_error', message: 'Verification URL not configured. Please set it in the admin System tab.' };

  const bankKey = getBankKey(bankName);
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
  });

  if (!payload) {
    return {
      result: 'service_error',
      message: 'This payment method is not supported for auto-verification. Please upload a screenshot for manual review.',
    };
  }

  if ((bankKey === 'cbe' || bankKey === 'boa') && !suffix) {
    return {
      result: 'service_error',
      message: 'The receiving bank account is not configured correctly. Please contact ABJ support.',
    };
  }

  const idemKey = `abj-ethio-${String(reference).trim()}-${bankKey || 'uni'}-${suffix || 'x'}`;

  const attempt = async (waitMs, timeoutMs) => {
    const url = `${cfg.verifyApiUrl}?waitMs=${waitMs}`;
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': cfg.verifyApiKey,
      'Idempotency-Key': idemKey,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, body };
  };

  try {
    const r1 = await attempt(10000, 14000);

    if (r1.status === 401 || r1.status === 402 || r1.status === 403) {
      return { result: 'service_error', message: 'Verification service unavailable. Upload a screenshot for manual review.' };
    }
    if (r1.status === 409) return { result: 'duplicate', message: 'This transaction reference has already been verified.' };
    if (r1.status === 422) {
      return {
        result: 'invalid',
        message: "We couldn't read your transaction details. Please double-check the Transaction ID, or upload a screenshot.",
      };
    }

    if (r1.status === 429 || r1.status === 503) {
      await sleep(2000);
      const r2 = await attempt(8000, 10000);
      if (r2.status === 200 || r2.status === 202) return await _handleSuccess(r2, cfg);
      return { result: 'service_error', message: 'Bank service is busy. Please upload a screenshot for manual review.' };
    }

    if (r1.status !== 200 && r1.status !== 202) {
      return { result: 'service_error', message: 'Could not verify your payment. Please upload a screenshot for manual review.' };
    }

    return await _handleSuccess(r1, cfg);
  } catch (err) {
    return { result: 'service_error', message: 'Network error reaching the bank. Please upload a screenshot for manual review.' };
  }
}

async function _handleSuccess(res, cfg) {
  if (res.status === 200) {
    return _interpret(res.body);
  }

  const rid = res.body?.requestId;
  const links = res.body?.links || {};
  const statusUrl = links.statusUrl || (rid ? `/api/verify/${rid}` : null);

  if (statusUrl) {
    for (let i = 0; i < 8; i++) {
      await sleep(1200 + i * 150);
      const poll = await _pollStatus(statusUrl, cfg.verifyApiKey, cfg.verifyApiUrl);
      if (poll.status !== 200 || !poll.data) continue;
      let it = poll.data.data;
      if (Array.isArray(it)) it = it[0];
      if (!it || typeof it !== 'object') continue;
      if (it.processingStatus === 'completed') return _interpret({ data: [it] });
      if (it.processingStatus === 'failed') return { result: 'failed', message: 'The bank reports this transaction as unsuccessful. Upload a screenshot for manual review if you believe this is wrong.' };
    }
  }
  return { result: 'pending', message: 'The bank is still confirming your payment. Upload a screenshot to speed up review.' };
}

/* ============================================================
   Telegram Bot invite
   ============================================================ */
async function createBotInvite(cfg, { channelId, title, expireDate }, attempt = 1) {
  if (!cfg.tgBotToken) throw new Error('Bot token not configured.');
  if (!channelId) throw new Error('Channel ID not configured.');

  const chatId = String(channelId).trim();

  const res = await fetch(`https://api.telegram.org/bot${cfg.tgBotToken}/createChatInviteLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      name: title,
      expire_date: expireDate,
      member_limit: 1,
    }),
    signal: AbortSignal.timeout(8000),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok || !data || !data.ok) {
    const desc = (data && data.description) || `HTTP ${res.status}`;

    if (/too many requests/i.test(desc) && attempt < 3) {
      const m = desc.match(/retry after (\d+)/i);
      const wait = Math.min(15, parseInt(m?.[1] || '3', 10));
      await sleep(wait * 1000);
      return await createBotInvite(cfg, { channelId, title, expireDate }, attempt + 1);
    }
    if (/not enough rights/i.test(desc)) {
      throw new Error('Bot is not an admin in the channel. Add it as admin with "Invite Users" permission.');
    }
    if (/chat not found/i.test(desc)) {
      throw new Error('Channel ID is wrong or bot is not in the channel.');
    }
    if (/too many requests/i.test(desc)) {
      throw new Error('Telegram rate limit hit — retry in a moment.');
    }
    throw new Error('Bot invite failed: ' + desc);
  }

  return {
    invite_link: data.result.invite_link,
    expire_date: data.result.expire_date,
    member_limit: 1,
    via: 'bot',
  };
}

async function createTelegramInvite(linkName) {
  const cfg = await getConfig();
  if (!cfg.tgChannelId) throw new Error('Telegram channel ID not configured. Set it in the admin System tab.');
  if (!cfg.tgBotToken) throw new Error('Bot token not configured. Set it in the admin System tab.');

  const title = String(linkName || 'ABJ').slice(0, 32);
  const expireDate = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

  return await createBotInvite(cfg, { channelId: cfg.tgChannelId, title, expireDate });
}

/* ============================================================
   Screenshot + chat upload → Supabase Storage
   Uploads via service key so they work whether the bucket is public
   or private. The returned URL is now only used as a **reference** —
   the storage path inside it is what we later sign.
   ============================================================ */
async function uploadScreenshotToStorage(publicId, base64Data, mimeType) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, error: 'Storage not configured.' };
  const safeId = String(publicId).replace(/[^A-Za-z0-9_-]/g, '');
  const ext = (mimeType || 'image/jpeg').split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  const path = `${safeId}-${Date.now()}.${ext}`;

  let buffer;
  try {
    buffer = Buffer.from(String(base64Data).replace(/^data:[^,]+,/, ''), 'base64');
  } catch {
    return { ok: false, error: 'Invalid image data.' };
  }

  if (buffer.length > 3.5 * 1024 * 1024) {
    return { ok: false, error: 'Screenshot too large (max 3.5 MB).' };
  }

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': mimeType || 'image/jpeg',
      'x-upsert': 'true',
    },
    body: buffer,
  });

  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: 'Storage upload failed: ' + t.slice(0, 120) };
  }

  return {
    ok: true,
    // Reference URL. Actual access goes through /api/admin-sign.
    url: `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`,
    path,
  };
}

async function uploadChatMedia(sessionId, base64Data, mimeType, fileName) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, error: 'Storage not configured.' };
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const ext = (fileName && fileName.split('.').pop()) ||
              (mimeType || 'image/jpeg').split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
  const path = `chat/${safe}-${Date.now()}.${ext}`;

  let buffer;
  try {
    buffer = Buffer.from(String(base64Data).replace(/^data:[^,]+,/, ''), 'base64');
  } catch { return { ok: false, error: 'Invalid file data.' }; }

  if (buffer.length > 4 * 1024 * 1024) return { ok: false, error: 'File too large (max 4 MB).' };

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': mimeType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: buffer,
  });

  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: 'Upload failed: ' + t.slice(0, 120) };
  }
  return {
    ok: true,
    url: `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`,
    path,
  };
}

function randomSessionId() {
  return 'chat-' + crypto.randomBytes(12).toString('hex');
}

/* ============================================================
   STORAGE PATH + SIGNED URL HELPERS
   ============================================================ */

/**
 * Extract a clean storage path from either a full public/signed URL
 * or a raw relative path. Returns null on anything suspicious.
 *
 * Accepted inputs:
 *   "chat/chat-abc-123.jpg"
 *   "RU0562-15-1790104158479.jpg"
 *   "https://xyz.supabase.co/storage/v1/object/public/screenshots/chat/chat-abc-123.jpg"
 *   "https://xyz.supabase.co/storage/v1/object/sign/screenshots/chat/abc.jpg?token=..."
 */
function extractStoragePath(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  let path = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const m = u.pathname.match(/\/storage\/v1\/object\/(?:public\/|sign\/)?[^/]+\/(.+)$/);
      if (!m) return null;
      path = decodeURIComponent(m[1]);
    } catch { return null; }
  }

  path = path.replace(/^\/+/, '');
  if (path.includes('..') || path.includes('\0')) return null;
  if (!/^[A-Za-z0-9_\-\/.]+$/.test(path)) return null;
  if (path.length > 300) return null;
  return path;
}

/**
 * Create a short-lived signed URL for a file in the private storage bucket.
 * Returns the full URL string, or null on failure.
 */
async function createSignedUrl(pathOrUrl, expiresIn = 3600) {
  const path = extractStoragePath(pathOrUrl);
  if (!path) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.signedURL) return null;
    return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
  } catch {
    return null;
  }
}

/**
 * Is the given MIME type on our whitelist of inline-safe types?
 */
function isSafeMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return SAFE_MIME.has(m);
}

/* ============================================================
   Rate limiting — ATOMIC via Postgres RPC
   ============================================================ */
async function checkRateLimit(ip, maxPerMinute = 10, opts = {}) {
  const failOpen = opts.failOpen !== false;

  if (!ip || ip === 'unknown') return true;

  try {
    const enabled = await isRateLimitEnabled();
    if (!enabled) return true;
  } catch {}

  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setSeconds(0, 0);

  try {
    const r = await supabaseRpc('increment_rate_limit', {
      p_ip: ip,
      p_window: windowStart.toISOString(),
      p_max: maxPerMinute,
    });

    if (!r.ok) {
      console.error('[rate-limit] RPC failed:', r.status, r.raw?.slice(0, 200));
      return failOpen;
    }

    const raw = String(r.raw || '').trim();
    if (raw !== 'true' && raw !== 'false') {
      console.error('[rate-limit] unexpected RPC return:', raw.slice(0, 100));
      return failOpen;
    }
    return raw === 'true';
  } catch (e) {
    console.error('[rate-limit] exception:', e.message);
    return failOpen;
  }
}

/* ============================================================
   Validation
   ============================================================ */
const NAME_RE = /^[A-Za-z][A-Za-z'\-]{1,}\s+[A-Za-z][A-Za-z'\-]{1,}$/;
const ID_RE = /^[A-Za-z]{2,4}\d{4}\/\d{2}$/;
const VALID_SEMESTERS = ['First Semester', 'Second Semester'];
const VALID_STREAMS = ['Social Science', 'Natural Science', 'Pre-Engineering & Computing', 'Other Natural Science'];

function isCBEBank(name) {
  return getBankKey(name) === 'cbe';
}

function validateRegistration(input, validMethods = []) {
  const { full_name, id_number, semester, stream, gender, payment_method, transaction_ref } = input;

  if (!full_name || typeof full_name !== 'string' || !NAME_RE.test(full_name.trim())) return 'Invalid full name.';
  if (!id_number || typeof id_number !== 'string' || !ID_RE.test(id_number.trim().toUpperCase())) return 'Invalid Student ID. Format: RU0562/15';
  if (!VALID_SEMESTERS.includes(semester)) return 'Invalid semester.';
  if (!VALID_STREAMS.includes(stream)) return 'Invalid stream.';
  if (gender !== 'Male' && gender !== 'Female') return 'Invalid gender.';

  const methods = Array.isArray(validMethods) ? validMethods : [];
  if (!methods.includes(payment_method)) return 'Invalid payment method.';

  if (!transaction_ref || typeof transaction_ref !== 'string' || transaction_ref.trim().length < 3) return 'Transaction ID is required.';
  if (transaction_ref.trim().length > 64) return 'Transaction ID is too long.';

  return null;
}

function randomPublicId() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
  return 'ABJ-' + out;
}

/* ============================================================
   SECURITY: trusted client IP
   ============================================================ */
function isIpLike(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 3 || t.length > 45) return false;
  return /^[0-9a-fA-F:.]+$/.test(t);
}

function getClientIp(req) {
  const vercelFwd = req.headers['x-vercel-forwarded-for'];
  if (vercelFwd) {
    const first = String(vercelFwd).split(',')[0].trim();
    if (isIpLike(first)) return first;
  }
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    const t = String(realIp).trim();
    if (isIpLike(t)) return t;
  }
  if (req.socket?.remoteAddress && isIpLike(req.socket.remoteAddress)) {
    return req.socket.remoteAddress;
  }
  const fwd = req.headers['x-forwarded-for'] || '';
  const first = String(fwd).split(',')[0].trim();
  if (isIpLike(first)) return first;
  return 'unknown';
}

/* ============================================================
   SECURITY: HTTP response headers
   ============================================================ */
function applySecurityHeaders(res) {
  try {
    if (res.headersSent) return;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  } catch {}
}

function enforceSameOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return false;

  try {
    const u = new URL(origin);
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (host && u.host === host) return false;
    if (/\.vercel\.app$/.test(u.host) && u.host.startsWith('abj-miniapp')) return false;
  } catch {}

  applySecurityHeaders(res);
  res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  return true;
}

/* ============================================================
   Output helpers
   ============================================================ */
function json(res, status, body) {
  applySecurityHeaders(res);
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  res.status(status).json(body);
}

function sendCsv(res, filename, csv) {
  applySecurityHeaders(res);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(csv);
}

/* ============================================================
   PII masking
   ============================================================ */
function maskName(fullName) {
  if (!fullName) return '';
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length <= 1) return parts[0] || '';
  const first = parts[0];
  const initials = parts.slice(1).map(p => p.charAt(0).toUpperCase() + '.').join(' ');
  return `${first} ${initials}`;
}

function maskIdNumber(id) {
  if (!id) return '';
  const s = String(id);
  if (s.length <= 5) return s;
  return s.slice(0, 3) + '*'.repeat(Math.max(2, s.length - 5)) + s.slice(-2);
}

/* Lightweight audit log for invite reveals (fire-and-forget) */
async function logInviteReveal(publicId, ip) {
  try {
    await supabaseInsert('admin_actions', {
      admin_id:       null,
      admin_username: 'public:' + (ip || 'unknown'),
      action:         'invite_reveal',
      target_type:    'registration',
      target_id:      String(publicId).slice(0, 120),
      details:        { ip: ip || 'unknown', at: new Date().toISOString() },
    });
  } catch (e) {
    console.error('[invite-reveal] log failed:', e.message);
  }
}

module.exports = {
  supabaseQuery, supabaseInsert, supabaseUpdate, supabaseDelete, supabaseRpc,
  getSetting, setSetting, getFee, getPublicSettings, getCustomBanks,
  getConfig, invalidateConfigCache,
  isRateLimitEnabled, invalidateRateLimitCache,
  hashPassword, verifyPassword,
  signJWT, verifyJWT, requireAdmin, requireSuper,
  verifyPayment, createTelegramInvite, uploadScreenshotToStorage, uploadChatMedia, randomSessionId,
  checkRateLimit, validateRegistration, randomPublicId, isCBEBank,
  getBankKey, deriveAccountSuffix, buildVerifyPayload,
  getClientIp, json, sendCsv,
  applySecurityHeaders, enforceSameOrigin,
  maskName, maskIdNumber,
  logInviteReveal,
  // Storage / signed URL helpers
  STORAGE_BUCKET,
  SAFE_MIME,
  extractStoragePath,
  createSignedUrl,
  isSafeMime,
  STAT_KEYS,
  ADMIN_PASSWORD,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
};

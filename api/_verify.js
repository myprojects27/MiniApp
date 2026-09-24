// Inlined Ethiopian bank verification — no external API.
// Handles: CBE (PDF), BOA (JSON), Telebirr (SMS/HTML), Dashen (HTML), M-Pesa (SMS).

const cheerio = require('cheerio');
let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch {}

const T = 20000;

module.exports = { verifyBankPayment };

async function verifyBankPayment({ bankKey, reference, suffix }) {
  try {
    if (bankKey === 'cbe')      return await cbe(reference, suffix);
    if (bankKey === 'boa')      return await boa(reference, suffix);
    if (bankKey === 'telebirr') return await telebirr(reference);
    if (bankKey === 'dashen')   return await dashen(reference);
    if (bankKey === 'mpesa')    return await mpesa(reference);
    return { status: 'failed', source: 'none', error: 'Unsupported bank: ' + bankKey };
  } catch (e) {
    return { status: 'failed', source: 'none', error: e.message || 'Verification error' };
  }
}

// ---------- CBE ----------
async function cbe(reference, suffix) {
  if (!suffix || !/^\d{8}$/.test(suffix)) return { status: 'failed', source: 'none', error: 'CBE requires an 8-digit account suffix.' };
  const ref = String(reference).trim().toUpperCase();
  const url = 'https://apps.cbe.com.et:100/?id=' + encodeURIComponent(ref + suffix);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(T) });
  if (!res.ok) return { status: 'failed', source: 'none', error: 'CBE HTTP ' + res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf.slice(0, 5).toString() !== '%PDF-') return { status: 'not_found', source: 'none' };
  if (!pdfParse) return { status: 'failed', source: 'pdf', error: 'pdf-parse unavailable' };
  let text = '';
  try { text = String((await pdfParse(buf)).text || '').replace(/\s+/g, ' ').trim(); }
  catch (e) { return { status: 'failed', source: 'pdf', error: 'PDF parse error: ' + e.message }; }
  const sec = text.split(/Payment\s*\/\s*Transaction\s*Information/i)[1] || text;
  const payer = sec.match(/Payer\s*(.+?)\s*Account\s*([\d*]+)\s*Receiver/i);
  const recv  = sec.match(/Receiver\s*(.+?)\s*Account\s*([\d*]+)\s*(?:Payment\s*Date|Reference)/i);
  const date  = sec.match(/Payment\s*Date\s*&\s*Time\s*([\d]{1,2}\/[\d]{1,2}\/[\d]{2,4},?\s*[\d:]+\s*(?:AM|PM)?)/i);
  const refM  = sec.match(/Reference\s*No\.?\s*(?:\(VAT Invoice No\))?\s*(FT[A-Z0-9]{6,})/i);
  const amt   = sec.match(/Transferred\s*Amount\s*([\d,]+\.?\d*)\s*ETB/i);
  if (!payer && !recv && !amt) return { status: 'not_found', source: 'pdf' };
  const nm = (s) => s ? s.replace(/^(Mr|Mrs|Ms|Dr|Prof)\.?\s+/i, '').replace(/\s+/g, ' ').trim() : undefined;
  return {
    status: 'success', source: 'pdf',
    referenceNumber: refM ? refM[1] : ref,
    amount: amt ? num(amt[1]) : undefined,
    currency: 'ETB',
    senderName: payer ? nm(payer[1]) : undefined,
    senderAccount: payer ? payer[2] : undefined,
    receiverName: recv ? nm(recv[1]) : undefined,
    receiverAccount: recv ? recv[2] : undefined,
    date: date ? date[1] : undefined,
  };
}

// ---------- BOA ----------
async function boa(reference, suffix) {
  if (!suffix || !/^\d{5}$/.test(suffix)) return { status: 'failed', source: 'none', error: 'BOA requires a 5-digit account suffix.' };
  const ref = String(reference).trim().toUpperCase();
  const url = 'https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id=' + encodeURIComponent(ref + suffix);
  const res = await fetch(url, { signal: AbortSignal.timeout(T) });
  if (!res.ok) return { status: 'failed', source: 'none', error: 'BOA HTTP ' + res.status };
  let j;
  try { j = await res.json(); } catch { return { status: 'failed', source: 'json', error: 'Invalid JSON' }; }
  const item = Array.isArray(j && j.body) ? j.body[0] : (j && j.body) || j;
  if (!item || typeof item !== 'object') return { status: 'not_found', source: 'json' };
  const flat = {};
  for (const [k, v] of Object.entries(item)) flat[k.toLowerCase().replace(/[\s']+/g, ' ').trim()] = v;
  const g = (...keys) => { for (const k of keys) { const v = flat[k.toLowerCase().replace(/[\s']+/g, ' ').trim()]; if (v !== undefined && v !== null && v !== '') return v; } };
  const r = {
    status: 'success', source: 'json',
    referenceNumber: String(g('transaction reference', 'reference') ?? ref),
    amount: num(g('transferred amount', 'amount')),
    currency: 'ETB',
    senderName: g("payer's name", 'source account name'),
    senderAccount: g('source account'),
    receiverName: g("receiver's name"),
    receiverAccount: g("receiver's account"),
    date: g('transaction date'),
  };
  if ([r.senderName, r.receiverName, r.amount].filter(Boolean).length < 2) return { status: 'not_found', source: 'json' };
  return r;
}

// ---------- Telebirr ----------
async function telebirr(input) {
  const t = String(input || '').trim();
  if (/You have transferred|Thank you for using telebirr/i.test(t)) return smsTelebirr(t);
  const ref = t.toUpperCase();
  const url = 'https://transactioninfo.ethiotelecom.et/receipt/' + encodeURIComponent(ref);
  const res = await fetch(url, { signal: AbortSignal.timeout(T) });
  if (!res.ok) return { status: 'failed', source: 'none', error: 'Telebirr HTTP ' + res.status, geoBlocked: true };
  const html = await res.text();
  if (!html || html.length < 100) return { status: 'not_found', source: 'none' };
  return htmlTelebirr(html, ref);
}

function smsTelebirr(text) {
  const f = text.replace(/\s+/g, ' ').trim();
  const r = { status: 'success', source: 'sms', currency: 'ETB' };
  const s = f.match(/^Dear\s+([A-Za-z][A-Za-z\s]+?)\s+You have transferred/i); if (s) r.senderName = s[1].trim();
  const t1 = f.match(/transaction number is\s+([A-Z0-9]+)/i); if (t1) r.referenceNumber = t1[1];
  if (!r.referenceNumber) { const u = f.match(/https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]+)/i); if (u) r.referenceNumber = u[1]; }
  const a = f.match(/transferred\s+ETB\s*([\d,]+\.?\d*)/i); if (a) r.amount = num(a[1]);
  const to = f.match(/to\s+(.+?)\s+\((\d{4}\*+\d{4})\)/i); if (to) { r.receiverName = to[1].trim(); r.receiverAccount = to[2]; }
  const fee = f.match(/service fee is\s+ETB\s*([\d,]+\.?\d*)/i); if (fee) r.serviceCharge = num(fee[1]);
  const vat = f.match(/VAT on the service fee is ETB\s*([\d,]+\.?\d*)/i); if (vat) r.vat = num(vat[1]);
  const d = f.match(/on\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/i); if (d) r.date = d[1];
  if ([r.referenceNumber, r.amount, r.receiverName].filter(Boolean).length < 2) return { status: 'not_found', source: 'sms' };
  return r;
}

function htmlTelebirr(html, fallbackRef) {
  const $ = cheerio.load(html);
  const b = $('body').text().replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  if (/not found|invalid|no record|does not exist/i.test(b) && b.length < 500) return { status: 'not_found', source: 'html' };
  const get = (label) => {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc + '[\\s.:\\u00A0]*([^]*?)(?=[\\u1200-\\u137F]|$)', 'i');
    const m = b.match(re); if (!m) return undefined;
    const v = m[1].replace(/\s+/g, ' ').trim(); return v || undefined;
  };
  const r = { status: 'success', source: 'html', currency: 'ETB' };
  r.senderName = get('Payer Name');
  r.senderAccount = get('Payer telebirr no.');
  r.receiverName = get('Credited Party name');
  r.receiverAccount = get('Credited party account no');
  r.referenceNumber = get('Invoice No.') || fallbackRef;
  const d = b.match(/(\d{2}[-\/]\d{2}[-\/]\d{4}\s+\d{2}:\d{2}:\d{2})/); if (d) r.date = d[1];
  const amt = b.match(/\d{2}[-\/]\d{2}[-\/]\d{4}\s+\d{2}:\d{2}:\d{2}\s+([\d,]+\.?\d*)\s*Birr/); if (amt) r.amount = num(amt[1]);
  const fee = b.match(/Service fee(?![^]*?VAT)[\s\u00A0]+([\d,]+\.?\d*)\s*Birr/i); if (fee) r.serviceCharge = num(fee[1]);
  const vat = b.match(/Service fee VAT[\s\u00A0]*([\d,]+\.?\d*)\s*Birr/i); if (vat) r.vat = num(vat[1]);
  const tot = b.match(/Total Paid Amount[\s\u00A0]+([\d,]+\.?\d*)\s*Birr/i); if (tot) r.totalAmount = num(tot[1]);
  if ([r.senderName, r.receiverName, r.amount, r.referenceNumber].filter(Boolean).length < 2) return { status: 'not_found', source: 'html' };
  return r;
}

// ---------- Dashen ----------
async function dashen(reference) {
  const ref = String(reference).trim().toUpperCase();
  const url = 'https://receipts.dashenbanksc.com/receipt/' + encodeURIComponent(ref);
  const res = await fetch(url, { signal: AbortSignal.timeout(T) });
  if (!res.ok) return { status: 'failed', source: 'none', error: 'Dashen HTTP ' + res.status };
  const html = await res.text();
  if (!html || html.length < 100) return { status: 'not_found', source: 'none' };
  return htmlDashen(html, ref);
}

function htmlDashen(html, fallbackRef) {
  const $ = cheerio.load(html);
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  if (/not found|invalid|no record|does not exist/i.test(body) && body.length < 500) return { status: 'not_found', source: 'html' };
  const fields = {};
  $('p, div, li').each((_, el) => {
    const $el = $(el); const strong = $el.find('strong, b').first();
    if (!strong.length) return;
    const label = strong.text().replace(/:\s*$/, '').trim().toLowerCase();
    const value = $el.text().trim().replace(strong.text(), '').replace(/^[:\s]+/, '').trim();
    if (label && value) fields[label] = value;
  });
  $('tr').each((_, row) => {
    const cells = $(row).find('td, th'); if (cells.length < 2) return;
    const label = cells.eq(0).text().trim().toLowerCase();
    const value = cells.eq(1).text().trim();
    if (label && value && !fields[label]) fields[label] = value;
  });
  const pick = (...keys) => {
    for (const k of keys) {
      const kk = k.toLowerCase(); if (fields[kk]) return fields[kk];
      for (const [fk, fv] of Object.entries(fields)) if (fk.includes(kk)) return fv;
    }
  };
  const nm = (s) => s ? s.replace(/^(Mr|Mrs|Ms|Dr|Prof)\.?\s+/i, '').replace(/\s+/g, ' ').trim() : undefined;
  const r = {
    status: 'success', source: 'html', currency: 'ETB',
    referenceNumber: pick('transaction reference', 'ft ref', 'reference') || fallbackRef,
    senderName: nm(pick('sender name')),
    senderAccount: (pick('sender account number', 'sender account') || '').replace(/\s+/g, '') || undefined,
    receiverName: nm(pick('receiver name')),
    receiverAccount: (pick('receiver account number', 'receiver account', 'recipient account') || '').replace(/\s+/g, '') || undefined,
    amount: num(pick('transaction amount', 'amount')),
    serviceCharge: num(pick('service charge')),
    vat: num(pick('vat (15%)', 'vat')),
    totalAmount: num(pick('total')),
    date: pick('transaction date', 'date'),
  };
  if ([r.senderName, r.receiverName, r.amount, r.referenceNumber].filter(Boolean).length < 2) return { status: 'not_found', source: 'html' };
  return r;
}

// ---------- M-Pesa ----------
async function mpesa(input) {
  const t = String(input || '').trim();
  if (/ልከዋል|M-PESA ቀሪ|transaction id|You have transferred/i.test(t)) {
    const f = t.replace(/\s+/g, ' ').trim();
    const r = { status: 'success', source: 'sms', currency: 'ETB' };
    const tx = f.match(/(?:transaction\s+id|መለያ\s+ቁጥር)[^\w]*([A-Z0-9]{10})/i); if (tx) r.referenceNumber = tx[1];
    if (!r.referenceNumber) { const u = f.match(/https:\/\/m-pesabusiness\.safaricom\.et\/receipt\/([A-Z0-9]+)/i); if (u) r.referenceNumber = u[1]; }
    const a = f.match(/([\d,]+\.?\d*)\s*ብር\s*(?:ለ|to)/i) || f.match(/ETB\s*([\d,]+\.?\d*)/i); if (a) r.amount = num(a[1]);
    const to = f.match(/ለ\s*([A-Za-z\s]+?)\s*(\d{6}\*+\d{3})/i); if (to) { r.receiverName = to[1].trim(); r.receiverAccount = to[2]; }
    const fee = f.match(/የአገልግሎት\s*ክፍያ\s*([\d,]+\.?\d*)/i); if (fee) r.serviceCharge = num(fee[1]);
    const d = f.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*በ(\d{1,2}:\d{2}\s*(?:AM|PM))/i); if (d) r.date = d[1] + ' ' + d[2];
    if ([r.referenceNumber, r.amount, r.receiverName].filter(Boolean).length < 2) return { status: 'not_found', source: 'sms' };
    return r;
  }
  return { status: 'failed', source: 'none', error: 'M-Pesa URL lookup not supported — paste the SMS text instead.' };
}

// ---------- helpers ----------
function num(s) {
  if (s == null) return undefined;
  const n = Number(String(s).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}
const {
  signJWT, getClientIp, checkRateLimit,
  supabaseQuery, supabaseInsert, supabaseUpdate, supabaseDelete,
  hashPassword, verifyPassword,
  requireAdmin, requireSuper,
  getPublicSettings, getSetting, setSetting, getConfig,
  invalidateConfigCache,
  isRateLimitEnabled, invalidateRateLimitCache,
  createTelegramInvite,
  uploadChatMedia,
  json, sendCsv,
  enforceSameOrigin,
  getFee, getCustomBanks,
  extractStoragePath, createSignedUrl,
  ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_KEY,
} = require('./_lib');

const ROUTES = {
  login:        handleLogin,
  list:         handleList,
  approve:      handleApprove,
  bulk:         handleBulkAction,
  export:       handleExport,
  reject:       handleReject,
  settings:     handleSettings,
  admins:       handleAdmins,
  videos:       handleVideos,
  testimonials: handleTestimonials,
  chats:        handleChats,
  stats:        handleStats,
  logs:         handleLogs,
  'rate-limits': handleRateLimits,
  sign:         handleSign,
  announcements:        handleAnnouncements,
  'admin-announcements': handleAdminAnnouncements,
};

module.exports = async (req, res) => {
  try {
    if (enforceSameOrigin(req, res)) return;
    const route = String(req.query.route || '').toLowerCase();
    const fn = ROUTES[route];
    if (!fn) return json(res, 404, { error: 'Unknown admin route: ' + route });
    return await fn(req, res);
  } catch (err) {
    console.error('[admin] unhandled:', err);
    return json(res, 500, { error: 'Server error: ' + (err.message || String(err)) });
  }
};

/* ============================================================
   Helper: audit log
   ============================================================ */
async function logAction(admin, action, targetType, targetId, details) {
  try {
    await supabaseInsert('admin_actions', {
      admin_id:       admin.admin_id || null,
      admin_username: admin.username  || 'unknown',
      action:         String(action).slice(0, 60),
      target_type:    targetType ? String(targetType).slice(0, 40) : null,
      target_id:      targetId ? String(targetId).slice(0, 120) : null,
      details:        details || {},
    });
  } catch (e) { console.error('[audit] log failed:', e.message); }
}

/* ============================================================
   Helper: precise count
   ============================================================ */
async function countRows(table, filter = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=id${filter ? '&' + filter : ''}&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Prefer: 'count=exact',
    },
  });
  const cr = res.headers.get('content-range') || '';
  const total = parseInt(cr.split('/')[1] || '0', 10);
  return isNaN(total) ? 0 : total;
}

/* ============================================================
   Helper: enrich a pending record for approval.
   ============================================================ */
async function buildApprovalEnrichment(row) {
  const patch = {};

  const currentAmount = parseFloat(row.amount) || 0;
  if (currentAmount <= 0) {
    try {
      const fee = await getFee();
      if (fee != null && fee > 0) patch.amount = fee;
    } catch (e) {
      console.error('[approve-enrich] getFee failed:', e.message);
    }
  }

  if (!row.receiver_account) {
    try {
      const banks = await getCustomBanks();
      const target = String(row.payment_method || '').toLowerCase().trim();
      const match = banks.find(b => String(b.name || '').toLowerCase().trim() === target);
      if (match && match.account) patch.receiver_account = match.account;
    } catch (e) {
      console.error('[approve-enrich] getCustomBanks failed:', e.message);
    }
  }

  return patch;
}

/* ============================================================
   STUDENT COURSES — kept in sync with index.html CURRICULUM.
   ============================================================ */
const STUDENT_COURSES = {
  'First Semester': {
    'Social Science':  ['MATH 1011','PSCH 1011','FLEN 1011','GEES 1011','LOCT 1011','ECON 1011'],
    'Natural Science': ['MATH 1011','PSCH 1011','FLEN 1011','GEES 1011','LOCT 1011','PHYS 1011'],
  },
  'Second Semester': {
    'Pre-Engineering & Computing': ['MATH 1041','ANTH 1012','ECEG 2052','EMTE 1012','MCIE 1012','SNIE 1012','MGMT 1012','FLEN 1012'],
    'Other Natural Science':       ['CHEM 2061','ANTH 1012','BIOL 1011','EMTE 1012','MCIE 1012','SNIE 1012','ECON 1011','FLEN 1012'],
    'Social Science':              ['MGMT 1012','ANTH 1012','EMTE 1012','MCIE 1012','SNIE 1012','GLTR 2012','FLEN 1012'],
  },
};
function coursesForStudent(semester, stream) {
  if (!semester || !stream) return [];
  return STUDENT_COURSES[semester]?.[stream] || [];
}

/* ============================================================
   SIGNED URL — for payment screenshots and chat media.
   ============================================================ */
async function handleSign(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const admin = requireAdmin(req);
  if (!admin) return json(res, 401, { error: 'Unauthorized' });

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(ip, 120);
  if (!allowed) return json(res, 429, { error: 'Too many requests.' });

  const pathRaw = String(req.query.path || '').trim();
  if (!pathRaw) return json(res, 400, { error: 'Missing path.' });

  const path = extractStoragePath(pathRaw);
  if (!path) return json(res, 400, { error: 'Invalid path.' });

  const url = await createSignedUrl(path, 3600);
  if (!url) return json(res, 502, { error: 'Could not create signed URL.' });

  return json(res, 200, { url, path, expires_in: 3600 });
}

/* ============================================================
   1. LOGIN
   ============================================================ */
async function bootstrapSuperAdmin() {
  const q = await supabaseQuery('admins?role=eq.super&select=id&limit=1');
  if (q.data && q.data.length) return;
  if (!ADMIN_PASSWORD) return;

  await supabaseInsert('admins', {
    username: 'super',
    password_hash: hashPassword(ADMIN_PASSWORD),
    full_name: 'Super Admin',
    role: 'super',
    created_by: 'bootstrap',
  });
}

async function handleLogin(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(ip, 5);
  if (!allowed) return json(res, 429, { error: 'Too many attempts. Please wait a minute.' });

  const { username, password } = req.body || {};
  const user = String(username || 'super').trim().toLowerCase();
  const pass = String(password || '');

  await bootstrapSuperAdmin();

  const q = await supabaseQuery(
    `admins?username=eq.${encodeURIComponent(user)}&select=id,username,password_hash,full_name,role`
  );
  const row = q.data?.[0];
  if (!row) {
    await new Promise(r => setTimeout(r, 700));
    return json(res, 401, { error: 'Invalid credentials.' });
  }

  const ok = verifyPassword(pass, row.password_hash);
  if (!ok) {
    await new Promise(r => setTimeout(r, 700));
    return json(res, 401, { error: 'Invalid credentials.' });
  }

  const role = row.role === 'super' ? 'super' : 'admin';
  const token = signJWT({
    role,
    username:  row.username,
    full_name: row.full_name || '',
    admin_id:  row.id,
  }, 3600 * 4);

  await logAction(
    { admin_id: row.id, username: row.username },
    'login',
    'admin',
    row.id,
    { ip }
  );

  return json(res, 200, {
    token,
    role,
    username: row.username,
    full_name: row.full_name || '',
  });
}

/* ============================================================
   2. LIST
   ============================================================ */
async function handleList(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const payload = requireAdmin(req);
  if (!payload) return json(res, 401, { error: 'Unauthorized' });

  const status = String(req.query.status || 'pending');
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return json(res, 400, { error: 'Invalid status.' });
  }

  const search = String(req.query.search || '').trim().slice(0, 60);
  const method = String(req.query.method || '').trim().slice(0, 40);
  const semester = String(req.query.semester || '').trim().slice(0, 40);
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);

  let filter = `status=eq.${status}`;
  if (search) {
    const s = encodeURIComponent(`*${search}*`);
    filter += `&or=(full_name.ilike.${s},id_number.ilike.${s},public_id.ilike.${s},transaction_ref.ilike.${s})`;
  }
  if (method)   filter += `&payment_method=eq.${encodeURIComponent(method)}`;
  if (semester) filter += `&semester=eq.${encodeURIComponent(semester)}`;

  const q = await supabaseQuery(
    `registrations?${filter}&order=created_at.desc&limit=${limit}` +
    `&select=id,public_id,full_name,id_number,semester,stream,gender,payment_method,` +
    `transaction_ref,transaction_suffix,amount,status,invite_link,approved_at,approved_by,rejection_reason,created_at,` +
    `auto_approved,verification_status,screenshot_url,verify_error,receiver_account,` +
    `client_ip,invite_link_created_at,updated_at`
  );

  return json(res, 200, { items: q.data || [] });
}

/* ============================================================
   3. APPROVE
   ============================================================ */
async function handleApprove(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const admin = requireAdmin(req);
  if (!admin) return json(res, 401, { error: 'Unauthorized' });

  const { id } = req.body || {};
  if (!id) return json(res, 400, { error: 'Missing registration id.' });

  const q = await supabaseQuery(`registrations?id=eq.${encodeURIComponent(id)}&select=*`);
  const row = q.data?.[0];
  if (!row) return json(res, 404, { error: 'Registration not found.' });
  if (row.status !== 'pending') {
    return json(res, 400, { error: `Already ${row.status}.` });
  }

  let invite;
  try {
    invite = await createTelegramInvite(`ABJ-${row.public_id}`);
  } catch (err) {
    return json(res, 500, { error: 'Failed to create invite link: ' + err.message });
  }

  const now = new Date().toISOString();
  const enrichment = await buildApprovalEnrichment(row);

  const upd = await supabaseUpdate(
    `registrations?id=eq.${encodeURIComponent(id)}`,
    {
      status: 'approved',
      invite_link: invite.invite_link,
      invite_link_created_at: now,
      approved_at: now,
      approved_by: 'admin:' + admin.username,
      updated_at: now,
      ...enrichment,
    }
  );

  if (!upd.ok) return json(res, 500, { error: 'Failed to update registration.' });

  await logAction(admin, 'approve', 'registration', row.public_id, {
    student: row.full_name,
    id_number: row.id_number,
    enriched: Object.keys(enrichment),
  });

  return json(res, 200, {
    success: true,
    invite_link: invite.invite_link,
    public_id: row.public_id,
    enriched: enrichment,
  });
}

/* ============================================================
   4. REJECT
   ============================================================ */
async function handleReject(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const admin = requireAdmin(req);
  if (!admin) return json(res, 401, { error: 'Unauthorized' });

  const { id, reason } = req.body || {};
  if (!id) return json(res, 400, { error: 'Missing registration id.' });

  const q = await supabaseQuery(`registrations?id=eq.${encodeURIComponent(id)}&select=id,status,public_id,full_name`);
  const row = q.data?.[0];
  if (!row) return json(res, 404, { error: 'Not found.' });
  if (row.status !== 'pending') return json(res, 400, { error: `Already ${row.status}.` });

  const now = new Date().toISOString();
  const upd = await supabaseUpdate(
    `registrations?id=eq.${encodeURIComponent(id)}`,
    {
      status: 'rejected',
      rejection_reason: reason ? String(reason).slice(0, 500) : null,
      approved_by: 'admin:' + admin.username,
      updated_at: now,
    }
  );

  if (!upd.ok) return json(res, 500, { error: 'Failed to update.' });

  await logAction(admin, 'reject', 'registration', row.public_id, {
    student: row.full_name,
    reason: reason || null,
  });

  return json(res, 200, { success: true });
}

/* ============================================================
   5. BULK
   ============================================================ */
async function handleBulkAction(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const admin = requireAdmin(req);
  if (!admin) return json(res, 401, { error: 'Unauthorized' });

  const { ids, action, reason } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return json(res, 400, { error: 'No registrations selected.' });
  }
  if (ids.length > 25) {
    return json(res, 400, { error: 'Maximum 25 records per batch (frontend splits larger sets).' });
  }
  if (!['approve', 'reject'].includes(action)) {
    return json(res, 400, { error: 'Invalid action. Use "approve" or "reject".' });
  }

  const results = { success: [], failed: [] };
  const now = new Date().toISOString();
  const safeReason = reason ? String(reason).slice(0, 500) : null;

  if (action === 'approve') {
    const cfg = await getConfig();
    if (!cfg.tgBotToken || !cfg.tgChannelId) {
      return json(res, 400, {
        error: 'Telegram bot is not configured. Please set it in the admin System tab first.'
      });
    }
  }

  for (const rawId of ids) {
    const id = String(rawId);
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      results.failed.push({ id, error: 'Invalid id' });
      continue;
    }

    try {
      const q = await supabaseQuery(`registrations?id=eq.${encodeURIComponent(id)}&select=*`);
      const row = q.data?.[0];
      if (!row) { results.failed.push({ id, error: 'Not found' }); continue; }
      if (row.status !== 'pending') { results.failed.push({ id, error: `Already ${row.status}` }); continue; }

      if (action === 'approve') {
        let invite;
        try {
          invite = await createTelegramInvite(`ABJ-${row.public_id}`);
        } catch (err) {
          results.failed.push({ id, error: err.message });
          continue;
        }
        const enrichment = await buildApprovalEnrichment(row);
        const upd = await supabaseUpdate(`registrations?id=eq.${encodeURIComponent(id)}`, {
          status: 'approved',
          invite_link: invite.invite_link,
          invite_link_created_at: now,
          approved_at: now,
          approved_by: 'admin:' + admin.username,
          updated_at: now,
          ...enrichment,
        });
        if (!upd.ok) { results.failed.push({ id, error: 'DB update failed' }); continue; }
        results.success.push({ id, public_id: row.public_id, invite_link: invite.invite_link });
      } else {
        const upd = await supabaseUpdate(`registrations?id=eq.${encodeURIComponent(id)}`, {
          status: 'rejected',
          rejection_reason: safeReason,
          approved_by: 'admin:' + admin.username,
          updated_at: now,
        });
        if (!upd.ok) { results.failed.push({ id, error: 'DB update failed' }); continue; }
        results.success.push({ id, public_id: row.public_id });
      }
    } catch (e) {
      results.failed.push({ id, error: e.message || 'Unknown error' });
    }
  }

  await logAction(admin, 'bulk_' + action, 'registration', null, {
    requested: ids.length,
    succeeded: results.success.length,
    failed: results.failed.length,
    reason: safeReason,
  });

  return json(res, 200, {
    success: true,
    action,
    succeeded: results.success.length,
    failed: results.failed.length,
    results,
  });
}

/* ============================================================
   6. CSV EXPORT
   ============================================================ */
async function handleExport(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const admin = requireAdmin(req);
  if (!admin) return json(res, 401, { error: 'Unauthorized' });

  const status = String(req.query.status || '').trim();
  const search = String(req.query.search || '').trim().slice(0, 60);
  const from   = String(req.query.from || '').trim().slice(0, 30);
  const to     = String(req.query.to || '').trim().slice(0, 30);

  let filter = '';
  const parts = [];
  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    parts.push(`status=eq.${status}`);
  }
  if (search) {
    const s = encodeURIComponent(`*${search}*`);
    parts.push(`or=(full_name.ilike.${s},id_number.ilike.${s},public_id.ilike.${s})`);
  }
  if (from) parts.push(`created_at=gte.${encodeURIComponent(from)}`);
  if (to)   parts.push(`created_at=lte.${encodeURIComponent(to)}`);
  if (parts.length) filter = '&' + parts.join('&');

  const q = await supabaseQuery(
    `registrations?select=id,public_id,full_name,id_number,semester,stream,gender,payment_method,` +
    `transaction_ref,transaction_suffix,amount,status,invite_link,approved_at,approved_by,` +
    `rejection_reason,created_at,auto_approved,verification_status,receiver_account&order=created_at.desc&limit=10000` +
    filter
  );

  const rows = q.data || [];

  const header = [
    'Public ID','Student ID','Full Name','Gender','Semester','Stream',
    'Payment Method','Transaction Ref','Suffix','Amount (ETB)',
    'Status','Auto Approved','Verification','Receiver Account',
    'Invite Link','Approved At','Approved By','Rejection Reason',
    'Submitted At'
  ];

  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      csvEscape(r.public_id),
      csvEscape(r.id_number),
      csvEscape(r.full_name),
      csvEscape(r.gender),
      csvEscape(r.semester),
      csvEscape(r.stream),
      csvEscape(r.payment_method),
      csvEscape(r.transaction_ref),
      csvEscape(r.transaction_suffix),
      csvEscape(r.amount),
      csvEscape(r.status),
      csvEscape(r.auto_approved ? 'yes' : 'no'),
      csvEscape(r.verification_status),
      csvEscape(r.receiver_account),
      csvEscape(r.invite_link),
      csvEscape(r.approved_at),
      csvEscape(r.approved_by),
      csvEscape(r.rejection_reason),
      csvEscape(r.created_at),
    ].join(','));
  }

  const csv = '\uFEFF' + lines.join('\r\n');
  sendCsv(res, `abj-registrations-${Date.now()}.csv`, csv);

  await logAction(admin, 'export_csv', 'registration', null, {
    status: status || 'all',
    search: search || null,
    rows: rows.length,
  });
}

/* ============================================================
   7. SETTINGS
   ============================================================ */
const SYSTEM_KEYS = [
  'tg_channel_id',
  'tg_bot_token',
  'verify_api_url',
  'verify_api_key',
];

const STAT_SETTING_KEYS = [
  'stat_students', 'stat_students_label',
  'stat_gpa',      'stat_gpa_label',
  'stat_scorers',  'stat_scorers_label',
  'stat_views',    'stat_views_label',
];

async function handleSettings(req, res) {
  if (req.method === 'GET' && !req.headers.authorization) {
    try {
      const s = await getPublicSettings();
      return json(res, 200, s);
    } catch {
      return json(res, 200, { fee: null, custom_banks: [], stats: {} });
    }
  }

  const payload = requireAdmin(req);
  if (!payload) return json(res, 401, { error: 'Unauthorized' });

  const action = String(req.query.action || '');

  if (action === 'banks-list') {
    const q = await supabaseQuery('banks?order=display_order.asc,created_at.asc&select=id,name,account_number,account_holder,display_order,created_at');
    return json(res, 200, { items: q.data || [] });
  }

  if (action === 'banks-add') {
    if (payload.role !== 'super') return json(res, 403, { error: 'Super admin only.' });
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    const { name, account, holder } = req.body || {};
    const n = String(name || '').trim().slice(0, 40);
    const a = String(account || '').trim().slice(0, 40);
    const h = String(holder || '').trim().slice(0, 60);

    if (!n || !a || !h) return json(res, 400, { error: 'Bank name, account number, and account holder name are required.' });

    const dup = await supabaseQuery(`banks?name=eq.${encodeURIComponent(n)}&select=id`);
    if (dup.data && dup.data.length) return json(res, 409, { error: 'A bank with that name already exists.' });

    const ins = await supabaseInsert('banks', { name: n, account_number: a, account_holder: h });
    if (!ins.ok) return json(res, 500, { error: 'Could not save bank account.' });

    await logAction(payload, 'bank_add', 'bank', n, { account: a, holder: h });
    return json(res, 200, { success: true, item: ins.data?.[0] });
  }

  if (action === 'banks-update') {
    if (payload.role !== 'super') return json(res, 403, { error: 'Super admin only.' });
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    const { id, name, account, holder } = req.body || {};
    if (!id || !/^[0-9a-f-]{36}$/.test(String(id))) return json(res, 400, { error: 'Invalid bank id.' });

    const n = String(name || '').trim().slice(0, 40);
    const a = String(account || '').trim().slice(0, 40);
    const h = String(holder || '').trim().slice(0, 60);
    if (!n || !a || !h) return json(res, 400, { error: 'All three fields are required.' });

    const upd = await supabaseUpdate(`banks?id=eq.${encodeURIComponent(id)}`, {
      name: n, account_number: a, account_holder: h, updated_at: new Date().toISOString(),
    });
    if (!upd.ok) return json(res, 500, { error: 'Could not update bank account.' });

    await logAction(payload, 'bank_update', 'bank', id, { name: n, account: a, holder: h });
    return json(res, 200, { success: true, item: upd.data?.[0] });
  }

  if (action === 'banks-delete') {
    if (payload.role !== 'super') return json(res, 403, { error: 'Super admin only.' });
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    const { id } = req.body || {};
    if (!id || !/^[0-9a-f-]{36}$/.test(String(id))) return json(res, 400, { error: 'Invalid bank id.' });

    const del = await supabaseDelete(`banks?id=eq.${encodeURIComponent(id)}`);
    if (!del.ok) return json(res, 500, { error: 'Could not delete bank account.' });

    await logAction(payload, 'bank_delete', 'bank', id, {});
    return json(res, 200, { success: true });
  }

  if (req.method === 'GET' && action === 'bot-info') {
    const cfg = await getConfig();
    if (!cfg.tgBotToken) {
      return json(res, 200, { configured: false, valid: false, error: 'No token saved' });
    }
    try {
      const r = await fetch(`https://api.telegram.org/bot${cfg.tgBotToken.trim()}/getMe`, {
        signal: AbortSignal.timeout(6000),
      });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}

      if (!r.ok || !data || !data.ok) {
        return json(res, 200, {
          configured: true,
          valid: false,
          error: (data && data.description) || ('HTTP ' + r.status),
        });
      }

      let channelInfo = null;
      if (cfg.tgChannelId) {
        try {
          const cr = await fetch(`https://api.telegram.org/bot${cfg.tgBotToken.trim()}/getChat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: cfg.tgChannelId }),
            signal: AbortSignal.timeout(6000),
          });
          const ctext = await cr.text();
          let cdata = null;
          try { cdata = ctext ? JSON.parse(ctext) : null; } catch {}
          if (cdata && cdata.ok) {
            channelInfo = {
              id: cdata.result.id,
              title: cdata.result.title,
              username: cdata.result.username || null,
              type: cdata.result.type,
            };
            try {
              const mr = await fetch(`https://api.telegram.org/bot${cfg.tgBotToken.trim()}/getChatMember`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: cfg.tgChannelId, user_id: data.result.id }),
                signal: AbortSignal.timeout(6000),
              });
              const mtext = await mr.text();
              let mdata = null;
              try { mdata = mtext ? JSON.parse(mtext) : null; } catch {}
              if (mdata && mdata.ok) {
                channelInfo.bot_status = mdata.result.status;
                channelInfo.can_invite = mdata.result.can_invite_users === true || mdata.result.status === 'creator';
              }
            } catch {}
          } else {
            channelInfo = { error: (cdata && cdata.description) || 'Channel not reachable' };
          }
        } catch {
          channelInfo = { error: 'Network error reaching channel' };
        }
      }

      return json(res, 200, {
        configured: true,
        valid: true,
        id: data.result.id,
        name: data.result.first_name,
        username: data.result.username,
        can_join_groups: !!data.result.can_join_groups,
        can_read_all_group_messages: !!data.result.can_read_all_group_messages,
        channel: channelInfo,
      });
    } catch (e) {
      return json(res, 200, {
        configured: true,
        valid: false,
        error: 'Network error — could not reach Telegram API',
      });
    }
  }

  if (req.method === 'GET') {
    const q = await supabaseQuery('app_settings?select=key,value');
    const raw = {};
    (q.data || []).forEach(r => { raw[r.key] = r.value; });
    return json(res, 200, { settings: raw, role: payload.role });
  }

  if (req.method === 'POST') {
    if (payload.role !== 'super') return json(res, 403, { error: 'Super admin only.' });

    const body = req.body || {};

    if (body.fee != null) {
      if (body.fee === '') {
        await setSetting('fee', '');
        await logAction(payload, 'fee_update', 'settings', 'fee', { value: null });
      } else {
        const n = parseFloat(body.fee);
        if (isNaN(n) || n <= 0) return json(res, 400, { error: 'Invalid fee amount.' });
        await setSetting('fee', String(Math.round(n)));
        await logAction(payload, 'fee_update', 'settings', 'fee', { value: Math.round(n) });
      }
    }

    let systemTouched = false;
    for (const key of SYSTEM_KEYS) {
      if (key in body) {
        const val = body[key];
        if (val === undefined || val === null) continue;
        const clean = String(val).trim().slice(0, 4096);
        await setSetting(key, clean);
        systemTouched = true;
      }
    }

    if (systemTouched) {
      invalidateConfigCache();
      await logAction(payload, 'system_settings_update', 'settings', null, {
        keys: SYSTEM_KEYS.filter(k => k in body),
      });
    }

    let statsTouched = false;
    for (const key of STAT_SETTING_KEYS) {
      if (key in body) {
        const raw = body[key];
        const clean = raw == null ? '' : String(raw).trim().slice(0, 60);
        await setSetting(key, clean);
        statsTouched = true;
      }
    }
    if (statsTouched) {
      await logAction(payload, 'stats_update', 'settings', null, {
        keys: STAT_SETTING_KEYS.filter(k => k in body),
      });
    }

    return json(res, 200, { success: true, system_updated: systemTouched, stats_updated: statsTouched });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

/* ============================================================
   8. ADMINS
   ============================================================ */
async function handleAdmins(req, res) {
  const action = String(req.query.action || '');

  if (action === 'profile') {
    const me = requireAdmin(req);
    if (!me) return json(res, 401, { error: 'Unauthorized' });

    if (req.method === 'GET') {
      const q = await supabaseQuery(
        `admins?id=eq.${encodeURIComponent(me.admin_id)}&select=id,username,full_name,role,created_at`
      );
      const row = q.data?.[0];
      if (!row) return json(res, 404, { error: 'Profile not found.' });
      return json(res, 200, { profile: row });
    }

    if (req.method === 'POST') {
      const { username, full_name, current_password, new_password } = req.body || {};

      const q = await supabaseQuery(`admins?id=eq.${encodeURIComponent(me.admin_id)}&select=*`);
      const row = q.data?.[0];
      if (!row) return json(res, 404, { error: 'Profile not found.' });

      const patch = {};

      if (username && String(username).trim().toLowerCase() !== row.username) {
        const u = String(username).trim().toLowerCase();
        if (!/^[a-z0-9_]{3,24}$/.test(u)) {
          return json(res, 400, { error: 'Username must be 3–24 chars (lowercase a-z, 0-9, _).' });
        }
        const exists = await supabaseQuery(`admins?username=eq.${encodeURIComponent(u)}&select=id`);
        if (exists.data && exists.data.length) {
          return json(res, 409, { error: 'Username already taken.' });
        }
        patch.username = u;
      }

      if (full_name != null) {
        patch.full_name = String(full_name).trim().slice(0, 64);
      }

      if (new_password) {
        if (!current_password) {
          return json(res, 400, { error: 'Enter your current password to change it.' });
        }
        if (!verifyPassword(String(current_password), row.password_hash)) {
          return json(res, 401, { error: 'Current password is incorrect.' });
        }
        if (String(new_password).length < 6) {
          return json(res, 400, { error: 'New password must be at least 6 characters.' });
        }
        patch.password_hash = hashPassword(String(new_password));
      }

      if (!Object.keys(patch).length) {
        return json(res, 400, { error: 'Nothing to update.' });
      }

      const upd = await supabaseUpdate(`admins?id=eq.${encodeURIComponent(me.admin_id)}`, patch);
      if (!upd.ok) return json(res, 500, { error: 'Update failed.' });

      const updated = upd.data?.[0] || {};
      const reauth = !!patch.username || !!patch.password_hash;

      await logAction(me, 'profile_update', 'admin', me.admin_id, {
        fields: Object.keys(patch),
      });

      return json(res, 200, {
        success: true,
        profile: {
          id: updated.id,
          username: updated.username,
          full_name: updated.full_name,
          role: updated.role,
        },
        reauth_required: reauth,
      });
    }

    return json(res, 405, { error: 'Method not allowed' });
  }

  const superAdmin = requireSuper(req);
  if (!superAdmin) return json(res, 403, { error: 'Super admin only.' });

  if (req.method === 'GET') {
    const q = await supabaseQuery(
      'admins?order=role.desc,created_at.desc&select=id,username,full_name,role,created_at'
    );
    return json(res, 200, { admins: q.data || [] });
  }

  if (req.method === 'POST') {
    const { username, password, full_name, role } = req.body || {};
    const u = String(username || '').trim().toLowerCase();
    const p = String(password || '');
    const n = String(full_name || '').trim().slice(0, 64);
    const r = role === 'super' ? 'super' : 'admin';

    if (!/^[a-z0-9_]{3,24}$/.test(u)) {
      return json(res, 400, { error: 'Username must be 3–24 chars (lowercase a-z, 0-9, _).' });
    }
    if (p.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters.' });

    const exists = await supabaseQuery(`admins?username=eq.${encodeURIComponent(u)}&select=id`);
    if (exists.data && exists.data.length) return json(res, 409, { error: 'Username already exists.' });

    const ins = await supabaseInsert('admins', {
      username: u,
      password_hash: hashPassword(p),
      full_name: n || null,
      role: r,
      created_by: superAdmin.username,
    });
    if (!ins.ok) return json(res, 500, { error: 'Could not create admin.' });

    await logAction(superAdmin, 'admin_create', 'admin', u, { role: r, full_name: n });
    return json(res, 200, { success: true, admin: ins.data?.[0] });
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '');
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, { error: 'Invalid id.' });

    const q = await supabaseQuery(`admins?id=eq.${encodeURIComponent(id)}&select=role,username`);
    const row = q.data?.[0];
    if (!row) return json(res, 404, { error: 'Not found.' });
    if (row.role === 'super') return json(res, 400, { error: 'Cannot delete a super admin.' });

    const del = await supabaseDelete(`admins?id=eq.${encodeURIComponent(id)}`);
    if (!del.ok) return json(res, 500, { error: 'Could not delete.' });

    await logAction(superAdmin, 'admin_delete', 'admin', row.username, {});
    return json(res, 200, { success: true });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

/* ============================================================
   9. VIDEOS
   ============================================================ */
async function handleVideos(req, res) {
  if (req.method === 'GET' && !req.headers.authorization) {
    const q = await supabaseQuery(
      'videos?order=created_at.asc&select=id,title,url,tag,semester,stream,course_code,course_name'
    );
    return json(res, 200, { items: q.data || [] });
  }

  const admin = requireSuper(req);
  if (!admin) return json(res, 403, { error: 'Super admin only.' });

  if (req.method === 'GET') {
    const q = await supabaseQuery(
      'videos?order=created_at.desc&select=id,title,url,tag,semester,stream,course_code,course_name,display_order,created_at'
    );
    return json(res, 200, { items: q.data || [] });
  }

  if (req.method === 'POST') {
    const { title, url, tag, semester, stream, course_code, course_name } = req.body || {};
    if (!title || !url) return json(res, 400, { error: 'Title and YouTube URL are required.' });
    if (String(title).length > 200) return json(res, 400, { error: 'Title too long.' });
    if (String(url).length > 500) return json(res, 400, { error: 'URL too long.' });

    const record = {
      title: String(title).trim(),
      url: String(url).trim(),
      tag: String(tag || 'Lesson').trim().slice(0, 40),
      created_by: admin.username,
    };
    if (semester)    record.semester    = String(semester).slice(0, 40);
    if (stream)      record.stream      = String(stream).slice(0, 60);
    if (course_code) record.course_code = String(course_code).slice(0, 40);
    if (course_name) record.course_name = String(course_name).slice(0, 120);

    const ins = await supabaseInsert('videos', record);
    if (!ins.ok) {
      console.error('[admin] video insert failed:', JSON.stringify(ins));
      return json(res, 500, { error: 'Could not save video.', detail: ins.data });
    }
    await logAction(admin, 'video_add', 'video', null, { title, semester, stream, course_code });
    return json(res, 200, { success: true, item: ins.data?.[0] });
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '');
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, { error: 'Invalid id.' });
    const del = await supabaseDelete(`videos?id=eq.${encodeURIComponent(id)}`);
    if (del.ok) await logAction(admin, 'video_delete', 'video', id, {});
    return json(res, del.ok ? 200 : 500, { success: del.ok });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

/* ============================================================
   10. TESTIMONIALS
   ============================================================ */
async function handleTestimonials(req, res) {
  if (req.method === 'GET' && !req.headers.authorization) {
    const q = await supabaseQuery('testimonials?order=display_order.asc,created_at.asc&select=id,student_name,subject,text,stars');
    return json(res, 200, { items: q.data || [] });
  }

  const admin = requireSuper(req);
  if (!admin) return json(res, 403, { error: 'Super admin only.' });

  if (req.method === 'GET') {
    const q = await supabaseQuery('testimonials?order=display_order.asc,created_at.asc&select=id,student_name,subject,text,stars,created_at');
    return json(res, 200, { items: q.data || [] });
  }

  if (req.method === 'POST') {
    const { student_name, subject, text, stars } = req.body || {};
    if (!student_name || !subject || !text) return json(res, 400, { error: 'Name, subject, and text are required.' });
    if (String(text).length > 1000) return json(res, 400, { error: 'Text too long (max 1000 chars).' });
    const starVal = Math.min(5, Math.max(1, parseInt(stars, 10) || 5));
    const ins = await supabaseInsert('testimonials', {
      student_name: String(student_name).trim().slice(0, 64),
      subject: String(subject).trim().slice(0, 64),
      text: String(text).trim(),
      stars: starVal,
      created_by: admin.username,
    });
    if (!ins.ok) return json(res, 500, { error: 'Could not save testimonial.' });
    await logAction(admin, 'testimonial_add', 'testimonial', null, { student_name, subject });
    return json(res, 200, { success: true, item: ins.data?.[0] });
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '');
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, { error: 'Invalid id.' });
    const del = await supabaseDelete(`testimonials?id=eq.${encodeURIComponent(id)}`);
    if (del.ok) await logAction(admin, 'testimonial_delete', 'testimonial', id, {});
    return json(res, del.ok ? 200 : 500, { success: del.ok });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

/* ============================================================
   Helper: admin presence upsert (chat)
   ============================================================ */
async function upsertAdminPresence(sessionId, patch) {
  const now = new Date().toISOString();
  const rows = [
    { session_id: sessionId, who: 'admin' },
    { session_id: '__global__', who: 'admin' },
  ];
  for (const r of rows) {
    const existing = await supabaseQuery(
      `chat_presence?session_id=eq.${encodeURIComponent(r.session_id)}&who=eq.admin&select=session_id&limit=1`
    );
    if (existing.ok && existing.data && existing.data.length) {
      await supabaseUpdate(
        `chat_presence?session_id=eq.${encodeURIComponent(r.session_id)}&who=eq.admin`,
        { ...patch, last_seen_at: now }
      );
    } else {
      await supabaseInsert('chat_presence', {
        session_id: r.session_id, who: 'admin', ...patch, last_seen_at: now,
      });
    }
  }
}

/* ============================================================
   11. CHATS
   ============================================================ */
async function handleChats(req, res) {
  const admin = requireAdmin(req);
  if (!admin) return json(res, 401, { error: 'Unauthorized' });

  const action = String(req.query.action || '');

  if (req.method === 'GET' && !action) {
    const sessionId = String(req.query.session_id || '').trim();

    if (sessionId) {
      upsertAdminPresence(sessionId, {}).catch(() => {});

      const q = await supabaseQuery(
        `chat_messages?session_id=eq.${encodeURIComponent(sessionId)}` +
        `&order=created_at.desc&limit=100` +
        `&select=id,sender,sender_name,message_type,content,file_url,file_name,is_read,created_at`
      );
      const items = (q.data || []).slice().reverse();

      await supabaseUpdate(
        `chat_messages?session_id=eq.${encodeURIComponent(sessionId)}&sender=eq.user&is_read=eq.false`,
        { is_read: true }
      );

      const userPres = await supabaseQuery(
        `chat_presence?session_id=eq.${encodeURIComponent(sessionId)}&who=eq.user&select=typing_at,last_seen_at&limit=1`
      );
      const row = userPres.data?.[0];
      const now = Date.now();
      const userOnline = row?.last_seen_at ? (now - new Date(row.last_seen_at).getTime() < 60000) : false;
      const userTyping = row?.typing_at ? (now - new Date(row.typing_at).getTime() < 5000) : false;

      return json(res, 200, { items, user_online: userOnline, user_typing: userTyping });
    }

    const q = await supabaseQuery(
      `chat_messages?order=created_at.desc&limit=300` +
      `&select=session_id,registration_id,sender,sender_name,content,message_type,is_read,created_at,file_name`
    );
    const rows = q.data || [];
    const seen = new Map();
    for (const r of rows) {
      if (!seen.has(r.session_id)) {
        seen.set(r.session_id, {
          session_id: r.session_id,
          registration_id: r.registration_id,
          sender_name: r.sender_name,
          last_message: r.message_type === 'text' ? (r.content || '') : `[${r.message_type}]`,
          last_sender: r.sender,
          last_at: r.created_at,
          unread: 0,
        });
      }
      if (r.sender === 'user' && !r.is_read) seen.get(r.session_id).unread++;
    }
    const sessions = [...seen.values()].sort((a,b) => (b.last_at||'').localeCompare(a.last_at||''));

    return json(res, 200, { sessions });
  }

  if (req.method === 'GET' && action === 'unread-count') {
    const q = await supabaseQuery(
      `chat_messages?sender=eq.user&is_read=eq.false&select=session_id`
    );
    const rows = q.data || [];
    const sessions = new Set(rows.map(r => r.session_id));
    return json(res, 200, { count: rows.length, sessions: sessions.size });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const sessionId = String(body.session_id || '').trim();
    if (!sessionId) return json(res, 400, { error: 'session_id required.' });

    if (body.action === 'typing') {
      await upsertAdminPresence(sessionId, { typing_at: new Date().toISOString() });
      return json(res, 200, { ok: true });
    }

    const type = ['text','image','pdf','voice'].includes(body.message_type) ? body.message_type : 'text';
    const content = body.content ? String(body.content).slice(0, 4000) : null;

    let fileUrl = null, fileName = null, fileSize = null;

    if (type !== 'text') {
      if (!body.file_base64) return json(res, 400, { error: 'Missing file data.' });
      fileName = body.file_name ? String(body.file_name).slice(0, 100) : (type + '.bin');
      const up = await uploadChatMedia('admin-' + sessionId, body.file_base64, body.mime_type || 'application/octet-stream', fileName);
      if (!up.ok) return json(res, 500, { error: up.error || 'Upload failed.' });
      fileUrl = up.url;
      try { fileSize = Buffer.from(String(body.file_base64).replace(/^data:[^,]+,/, ''), 'base64').length; } catch {}
    } else if (!content) {
      return json(res, 400, { error: 'Empty message.' });
    }

    const ins = await supabaseInsert('chat_messages', {
      session_id: sessionId,
      sender: 'admin',
      sender_name: admin.full_name || admin.username,
      message_type: type,
      content,
      file_url: fileUrl,
      file_name: fileName,
      file_size: fileSize,
      is_read: true,
    });
    if (!ins.ok) return json(res, 500, { error: 'Could not save reply.' });

    await upsertAdminPresence(sessionId, { typing_at: null });

    return json(res, 200, { success: true, item: ins.data?.[0] });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

/* ============================================================
   12. STATS
   ============================================================ */
async function handleStats(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const payload = requireAdmin(req);
  if (!payload) return json(res, 401, { error: 'Unauthorized' });

  if (String(req.query.action || '') === 'counts') {
    const [p, a, r] = await Promise.all([
      countRows('registrations', 'status=eq.pending'),
      countRows('registrations', 'status=eq.approved'),
      countRows('registrations', 'status=eq.rejected'),
    ]);
    return json(res, 200, { pending: p, approved: a, rejected: r });
  }

  const q = await supabaseQuery(
    'registrations?select=id,status,amount,created_at,approved_at,payment_method,semester,stream&limit=50000'
  );
  const rows = q.data || [];

  const now = new Date();
  const startOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWeek  = now.getTime() - 7 * 86400000;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let totalUsers = 0, totalRevenue = 0;
  let todayUsers = 0, todayRevenue = 0;
  let weekUsers = 0, weekRevenue = 0;
  let monthUsers = 0, monthRevenue = 0;
  let pending = 0, approved = 0, rejected = 0;
  const byMethod = {};
  const bySemester = {};

  for (const r of rows) {
    const amt = parseFloat(r.amount) || 0;
    const createdMs = r.created_at ? new Date(r.created_at).getTime() : 0;

    if (r.status === 'approved') {
      approved++;
      totalUsers++;
      totalRevenue += amt;

      if (createdMs >= startOfDay)   { todayUsers++; todayRevenue += amt; }
      if (createdMs >= startOfWeek)  { weekUsers++;  weekRevenue  += amt; }
      if (createdMs >= startOfMonth) { monthUsers++; monthRevenue += amt; }

      const m = r.payment_method || 'Unknown';
      byMethod[m] = byMethod[m] || { count: 0, revenue: 0 };
      byMethod[m].count++;
      byMethod[m].revenue += amt;

      const s = r.semester || 'Unknown';
      bySemester[s] = (bySemester[s] || 0) + 1;
    } else if (r.status === 'pending') {
      pending++;
    } else if (r.status === 'rejected') {
      rejected++;
    }
  }

  return json(res, 200, {
    totalRecords: rows.length,
    totalUsers, totalRevenue,
    todayUsers, todayRevenue,
    weekUsers, weekRevenue,
    monthUsers, monthRevenue,
    pending, approved, rejected,
    byMethod,
    bySemester,
    generated_at: new Date().toISOString(),
  });
}

/* ============================================================
   13. ACTIVITY LOG
   ============================================================ */
async function handleLogs(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const payload = requireSuper(req);
  if (!payload) return json(res, 403, { error: 'Super admin only.' });

  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const action = String(req.query.action || '').trim().slice(0, 40);
  const username = String(req.query.username || '').trim().slice(0, 40);

  let filter = '';
  const parts = [];
  if (action) parts.push(`action=ilike.*${encodeURIComponent(action)}*`);
  if (username) parts.push(`admin_username=ilike.*${encodeURIComponent(username)}*`);
  if (parts.length) filter = '&' + parts.join('&');

  const q = await supabaseQuery(
    `admin_actions?order=created_at.desc&limit=${limit}&select=id,admin_username,action,target_type,target_id,details,created_at${filter}`
  );

  return json(res, 200, { items: q.data || [] });
}

/* ============================================================
   14. RATE LIMITS
   ============================================================ */
async function handleRateLimits(req, res) {
  const admin = requireAdmin(req);
  if (!admin) return json(res, 401, { error: 'Unauthorized' });

  if (req.method === 'GET') {
    const enabled = await isRateLimitEnabled();
    let q = await supabaseQuery('rate_limits?order=window_start.desc&limit=1000&select=*');
    if (!q.ok) q = await supabaseQuery('rate_limits?order=created_at.desc&limit=1000&select=*');
    if (!q.ok) q = await supabaseQuery('rate_limits?limit=1000&select=*');
    if (!q.ok) {
      return json(res, 200, {
        items: [], enabled,
        warning: `Could not read rate_limits table (HTTP ${q.status}).`,
      });
    }
    return json(res, 200, { items: q.data || [], enabled });
  }

  if (req.method === 'POST') {
    const { action, ips, enabled: enabledBody } = req.body || {};

    if (action === 'toggle' || action === 'set-enabled') {
      if (admin.role !== 'super') return json(res, 403, { error: 'Super admin only.' });
      let newValue;
      if (action === 'toggle') newValue = !(await isRateLimitEnabled());
      else newValue = !!enabledBody;
      const setRes = await setSetting('rate_limit_enabled', newValue ? 'true' : 'false');
      if (!setRes.ok) return json(res, 500, { error: 'Could not update rate-limit setting.' });
      invalidateRateLimitCache();
      await logAction(admin, 'rate_limit_' + (newValue ? 'enabled' : 'disabled'), 'settings', 'rate_limit_enabled', { value: newValue });
      return json(res, 200, { success: true, enabled: newValue });
    }

    if (action === 'reset-all') {
      const all = await supabaseQuery('rate_limits?select=*&limit=10000');
      if (!all.ok || !all.data) return json(res, 500, { error: 'Could not read rate_limits.' });

      const uniqueIps = new Set();
      for (const row of all.data) {
        const ip = row.ip || row.ip_address || row.client_ip;
        if (ip) uniqueIps.add(ip);
      }

      let deleted = 0;
      for (const ip of uniqueIps) {
        const del = await supabaseDelete(`rate_limits?ip=eq.${encodeURIComponent(ip)}`);
        if (del.ok) deleted++;
      }

      await logAction(admin, 'rate_limit_reset_all', 'rate_limit', null, {
        ips_cleared: deleted,
        rows_seen:   all.data.length,
      });
      return json(res, 200, { success: true, deleted });
    }

    if (action === 'reset' && Array.isArray(ips) && ips.length) {
      let deleted = 0;
      for (const ip of ips) {
        const del = await supabaseDelete(`rate_limits?ip=eq.${encodeURIComponent(ip)}`);
        if (del.ok) deleted++;
      }
      await logAction(admin, 'rate_limit_reset', 'rate_limit', null, {
        requested: ips.length,
        deleted,
      });
      return json(res, 200, { success: true, deleted });
    }

    return json(res, 400, { error: 'Invalid action.' });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

/* ============================================================
   15. ANNOUNCEMENTS — PUBLIC (visitor + registered student)
   ============================================================ */
async function handleAnnouncements(req, res) {
  const ip = getClientIp(req);

  /* ---------- GET: fetch announcements visible to this visitor ---------- */
  if (req.method === 'GET') {
    const allowed = await checkRateLimit(ip, 120);
    if (!allowed) return json(res, 429, { error: 'Too many requests.' });

    const raw = String(req.query.id || '').trim().toUpperCase();
    const pubId = raw ? raw.replace(/\s+/g, '').replace(/\//g, '-') : null;

    const visitorRaw = String(req.query.visitor || '').trim().slice(0, 80);
    const visitorKey = visitorRaw ? ('v:' + visitorRaw) : null;

    let reg = null;
    if (pubId) {
      let regQ = await supabaseQuery(
        `registrations?public_id=eq.${encodeURIComponent(pubId)}&select=public_id,semester,stream,status&limit=1`
      );
      reg = regQ.data?.[0];
      if (!reg) {
        regQ = await supabaseQuery(
          `registrations?id_number=eq.${encodeURIComponent(raw)}&select=public_id,semester,stream,status&order=created_at.desc&limit=1`
        );
        reg = regQ.data?.[0];
      }
    }

    const sem = reg?.semester || null;
    const str = reg?.stream || null;
    const myCourses = reg ? coursesForStudent(sem, str) : [];

    const aq = await supabaseQuery(
      `announcements?order=is_pinned.desc,created_at.desc&limit=300&select=*`
    );
    const all = aq.data || [];

    const visible = all.filter(a => {
      if (!reg) {
        return !a.semester && !a.stream && !a.course_code;
      }
      if (a.semester && a.semester !== sem) return false;
      if (a.stream && a.stream !== str) return false;
      if (a.course_code && !myCourses.includes(a.course_code)) return false;
      return true;
    });

    /* Use the registration's public_id if available, otherwise the visitor key.
       This is what makes read-state persist for unregistered visitors. */
    const readKey = reg ? reg.public_id : visitorKey;

    let readSet = new Set();
    if (readKey) {
      const readQ = await supabaseQuery(
        `announcement_reads?public_id=eq.${encodeURIComponent(readKey)}&select=announcement_id`
      );
      readSet = new Set((readQ.data || []).map(r => r.announcement_id));
    }

    const items = visible.map(a => ({
      id: a.id,
      title: a.title,
      body: a.body,
      preview: String(a.body || '').replace(/\s+/g, ' ').slice(0, 140),
      priority: a.priority || 'normal',
      is_pinned: !!a.is_pinned,
      semester: a.semester || null,
      stream: a.stream || null,
      course_code: a.course_code || null,
      created_at: a.created_at,
      is_read: readSet.has(a.id),
    }));

    return json(res, 200, { items });
  }

  /* ---------- POST: mark one / all as read ---------- */
  if (req.method === 'POST') {
    const allowed = await checkRateLimit(ip, 120);
    if (!allowed) return json(res, 429, { error: 'Too many requests.' });

    const body = req.body || {};
    const action = String(body.action || '');
    const rawId = String(body.public_id || '').trim().toUpperCase();
    const visitorRaw = String(body.visitor_id || '').trim().slice(0, 80);

    /* Resolve the read-tracking key:
       - registered student → their registrations.public_id
       - unregistered visitor → 'v:' + their persistent visitor ID */
    let readKey = null;

    if (rawId) {
      const pubId = rawId.replace(/\s+/g, '').replace(/\//g, '-');
      const vq = await supabaseQuery(
        `registrations?public_id=eq.${encodeURIComponent(pubId)}&select=public_id&limit=1`
      );
      if (vq.ok && vq.data?.length) {
        readKey = vq.data[0].public_id;
      } else {
        const vq2 = await supabaseQuery(
          `registrations?id_number=eq.${encodeURIComponent(rawId)}&select=public_id&order=created_at.desc&limit=1`
        );
        if (vq2.ok && vq2.data?.length) readKey = vq2.data[0].public_id;
      }
    }

    if (!readKey && visitorRaw) {
      readKey = 'v:' + visitorRaw;
    }

    if (!readKey) {
      return json(res, 200, { success: true, skipped: true });
    }

    if (action === 'mark-read') {
      const aid = String(body.announcement_id || '').trim();
      if (!/^[0-9a-f-]{36}$/.test(aid)) return json(res, 400, { error: 'Invalid announcement id.' });
      try {
        const exists = await supabaseQuery(
          `announcement_reads?announcement_id=eq.${encodeURIComponent(aid)}&public_id=eq.${encodeURIComponent(readKey)}&select=announcement_id&limit=1`
        );
        if (!exists.data?.length) {
          await supabaseInsert('announcement_reads', {
            announcement_id: aid,
            public_id: readKey,
          });
        }
      } catch (e) {
        console.error('[announcements] mark-read failed:', e.message);
      }
      return json(res, 200, { success: true });
    }

    if (action === 'mark-all-read') {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 300) : [];
      const existing = await supabaseQuery(
        `announcement_reads?public_id=eq.${encodeURIComponent(readKey)}&select=announcement_id`
      );
      const have = new Set((existing.data || []).map(r => r.announcement_id));
      for (const id of ids) {
        if (!/^[0-9a-f-]{36}$/.test(String(id))) continue;
        if (have.has(id)) continue;
        try {
          await supabaseInsert('announcement_reads', {
            announcement_id: id,
            public_id: readKey,
          });
        } catch (e) {
          console.error('[announcements] mark-all-read failed:', e.message);
        }
      }
      return json(res, 200, { success: true });
    }

    return json(res, 400, { error: 'Unknown action.' });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

/* ============================================================
   16. ADMIN ANNOUNCEMENTS — CRUD (auth required)
   ============================================================ */
async function handleAdminAnnouncements(req, res) {
  const admin = requireAdmin(req);
  if (!admin) return json(res, 401, { error: 'Unauthorized' });

  if (req.method === 'GET') {
    const q = await supabaseQuery(
      `announcements?order=is_pinned.desc,created_at.desc&limit=500&select=*`
    );
    return json(res, 200, { items: q.data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const t = String(body.title || '').trim().slice(0, 200);
    const b = String(body.body || '').trim().slice(0, 5000);
    if (!t || !b) return json(res, 400, { error: 'Title and body are required.' });

    const priority = ['normal','important','urgent'].includes(body.priority) ? body.priority : 'normal';
    const record = {
      title: t,
      body: b,
      priority,
      is_pinned: !!body.is_pinned,
      created_by: admin.username,
    };
    if (body.semester)     record.semester    = String(body.semester).slice(0, 40);
    if (body.stream)       record.stream      = String(body.stream).slice(0, 60);
    if (body.course_code)  record.course_code = String(body.course_code).slice(0, 40);

    const ins = await supabaseInsert('announcements', record);
    if (!ins.ok) {
      console.error('[announcements] insert failed:', JSON.stringify(ins));
      return json(res, 500, { error: 'Could not save announcement.' });
    }
    await logAction(admin, 'announcement_add', 'announcement', null, {
      title: t,
      semester: record.semester || 'all',
      stream: record.stream || 'all',
      course_code: record.course_code || null,
      priority,
      is_pinned: record.is_pinned,
    });
    return json(res, 200, { success: true, item: ins.data?.[0] });
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '');
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 400, { error: 'Invalid id.' });
    const del = await supabaseDelete(`announcements?id=eq.${encodeURIComponent(id)}`);
    if (del.ok) await logAction(admin, 'announcement_delete', 'announcement', id, {});
    return json(res, del.ok ? 200 : 500, { success: del.ok });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

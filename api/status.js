const {
  supabaseQuery, getClientIp, checkRateLimit, json,
  enforceSameOrigin, maskName, logInviteReveal,
} = require('./_lib');

module.exports = async (req, res) => {
  // Security: block cross-origin requests
  if (enforceSameOrigin(req, res)) return;

  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  const ip = getClientIp(req);
  const reveal = String(req.query.reveal || '') === '1';

  // Two tiers: normal status lookups are 30/min; reveal requests are
  // tightly limited to 5/min so scripted ID enumeration can't scrape links.
  const limit = reveal ? 5 : 30;
  const allowed = await checkRateLimit(ip, limit);
  if (!allowed) {
    return json(res, 429, {
      error: reveal
        ? 'Too many invite-link requests. Please wait a minute.'
        : 'Too many requests. Please slow down.',
    });
  }

  const raw = String(req.query.id || '').trim().toUpperCase();
  if (!raw) return json(res, 400, { error: 'Registration ID required.' });

  const public_id = raw.replace(/\s+/g, '').replace(/\//g, '-');
  if (public_id.length < 3 || public_id.length > 32) {
    return json(res, 400, { error: 'Invalid registration ID format.' });
  }
  if (!/^[A-Z0-9-]+$/.test(public_id)) {
    return json(res, 400, { error: 'Invalid registration ID format.' });
  }

  const select = `public_id,id_number,status,full_name,semester,stream,created_at,approved_at,` +
                 `invite_link,invite_link_created_at,rejection_reason,auto_approved,` +
                 `verification_status,screenshot_url`;

  // Lookup order: public_id → id_number exact → id_number slash variant
  let row = null;

  let q = await supabaseQuery(
    `registrations?public_id=eq.${encodeURIComponent(public_id)}&select=${select}&limit=1`
  );
  row = q.data?.[0];

  if (!row) {
    q = await supabaseQuery(
      `registrations?id_number=eq.${encodeURIComponent(raw)}&select=${select}&order=created_at.desc&limit=1`
    );
    row = q.data?.[0];
  }

  if (!row) {
    const idWithSlash = public_id.replace('-', '/');
    q = await supabaseQuery(
      `registrations?id_number=eq.${encodeURIComponent(idWithSlash)}&select=${select}&order=created_at.desc&limit=1`
    );
    row = q.data?.[0];
  }

  if (!row) return json(res, 404, { error: 'No registration found for this Student ID.' });

  const out = {
    public_id: row.public_id,
    id_number: row.id_number || row.public_id,
    status: row.status,
    // SECURITY: mask the name so an attacker enumerating IDs cannot scrape full names.
    full_name: maskName(row.full_name),
    semester: row.semester,
    stream: row.stream,
    created_at: row.created_at,
    approved_at: row.approved_at,
    auto_approved: row.auto_approved || false,
    verification_status: row.verification_status || 'auto_verified',
    screenshot_uploaded: !!row.screenshot_url,
  };

  if (row.status === 'approved' && row.invite_link) {
    // Only expose the actual URL when the caller explicitly asks to reveal it.
    // Otherwise send a redacted marker so the frontend knows a link exists.
    if (reveal) {
      out.invite_link = row.invite_link;
      out.invite_link_created_at = row.invite_link_created_at;
      // Audit every reveal (fire-and-forget).
      logInviteReveal(row.public_id, ip).catch(() => {});
    } else {
      out.invite_link_available = true;
    }
  }

  if (row.status === 'rejected' && row.rejection_reason) {
    out.rejection_reason = row.rejection_reason;
  }

  return json(res, 200, out);
};

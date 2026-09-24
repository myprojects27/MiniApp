const {
  supabaseQuery, supabaseInsert, supabaseUpdate,
  uploadChatMedia, checkRateLimit, getClientIp, json, enforceSameOrigin,
  extractStoragePath, createSignedUrl,
} = require('./_lib');

/* ---------- presence helpers ---------- */
async function upsertPresence(sessionId, who, patch) {
  const existing = await supabaseQuery(
    `chat_presence?session_id=eq.${encodeURIComponent(sessionId)}&who=eq.${encodeURIComponent(who)}&select=session_id&limit=1`
  );
  const now = new Date().toISOString();
  if (existing.ok && existing.data && existing.data.length) {
    return await supabaseUpdate(
      `chat_presence?session_id=eq.${encodeURIComponent(sessionId)}&who=eq.${encodeURIComponent(who)}`,
      { ...patch, last_seen_at: now }
    );
  }
  return await supabaseInsert('chat_presence', {
    session_id: sessionId, who, ...patch, last_seen_at: now,
  });
}

async function readAdminPresence(sessionId) {
  const [globalRow, typingRow] = await Promise.all([
    supabaseQuery(`chat_presence?session_id=eq.__global__&who=eq.admin&select=last_seen_at&limit=1`),
    supabaseQuery(`chat_presence?session_id=eq.${encodeURIComponent(sessionId)}&who=eq.admin&select=typing_at&limit=1`),
  ]);
  const now = Date.now();
  const lastSeen = globalRow.data?.[0]?.last_seen_at;
  const typing   = typingRow.data?.[0]?.typing_at;
  return {
    admin_online: lastSeen ? (now - new Date(lastSeen).getTime() < 60000) : false,
    admin_typing: typing   ? (now - new Date(typing).getTime()   < 5000)  : false,
  };
}

module.exports = async (req, res) => {
  if (enforceSameOrigin(req, res)) return;
  const ip = getClientIp(req);
  const route = String(req.query.route || '').toLowerCase();

  /* ----------------------------------------------------------
     SIGN — issue a signed URL for a chat attachment.
     Student-scoped: the requested path must belong to the
     caller's session_id (as `chat/{session}-...` or
     `chat/admin-{session}-...`).
     ---------------------------------------------------------- */
  if (route === 'sign') {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

    const allowed = await checkRateLimit(ip, 120);
    if (!allowed) return json(res, 429, { error: 'Too many requests.' });

    const sessionId = String(req.query.session_id || '').trim();
    if (!sessionId || sessionId.length > 64) return json(res, 400, { error: 'Invalid session.' });

    const pathRaw = String(req.query.path || '').trim();
    if (!pathRaw) return json(res, 400, { error: 'Missing path.' });

    const path = extractStoragePath(pathRaw);
    if (!path) return json(res, 400, { error: 'Invalid path.' });

    // Must be inside the chat/ prefix
    if (!path.startsWith('chat/')) return json(res, 403, { error: 'Not allowed.' });

    const rel = path.slice('chat/'.length);
    const expected1 = `${sessionId}-`;
    const expected2 = `admin-${sessionId}-`;
    if (!rel.startsWith(expected1) && !rel.startsWith(expected2)) {
      return json(res, 403, { error: 'Not allowed.' });
    }

    // Short-lived: chat files change often and polling refreshes anyway.
    const url = await createSignedUrl(path, 3600);
    if (!url) return json(res, 502, { error: 'Could not create signed URL.' });

    return json(res, 200, { url, path, expires_in: 3600 });
  }

  /* ---------- GET: messages + presence ---------- */
  if (req.method === 'GET') {
    const allowed = await checkRateLimit(ip, 120);
    if (!allowed) return json(res, 429, { error: 'Too many requests.' });

    const sessionId = String(req.query.session_id || '').trim();
    if (!sessionId || sessionId.length > 64) return json(res, 400, { error: 'Invalid session.' });

    upsertPresence(sessionId, 'user', {}).catch(() => {});

    const q = `chat_messages?session_id=eq.${encodeURIComponent(sessionId)}` +
              `&order=created_at.asc&limit=50` +
              `&select=id,sender,sender_name,message_type,content,file_url,file_name,is_read,created_at`;

    const [messages, presence] = await Promise.all([
      supabaseQuery(q),
      readAdminPresence(sessionId),
    ]);

    return json(res, 200, {
      items: messages.data || [],
      admin_online: presence.admin_online,
      admin_typing: presence.admin_typing,
    });
  }

  /* ---------- POST: send message or typing update ---------- */
  if (req.method === 'POST') {
    const allowed = await checkRateLimit(ip, 30);
    if (!allowed) return json(res, 429, { error: 'Too many messages. Slow down.' });

    const body = req.body || {};
    const sessionId = String(body.session_id || '').trim();
    if (!sessionId || sessionId.length > 64) return json(res, 400, { error: 'Invalid session.' });

    if (body.action === 'typing') {
      await upsertPresence(sessionId, 'user', { typing_at: new Date().toISOString() });
      return json(res, 200, { ok: true });
    }

    const type = ['text','image','pdf','voice'].includes(body.message_type) ? body.message_type : 'text';
    const content = body.content ? String(body.content).slice(0, 8000) : null;
    const registrationId = body.registration_id ? String(body.registration_id).slice(0, 32) : null;
    const senderName = body.sender_name ? String(body.sender_name).slice(0, 64) : (registrationId || 'Guest');

    let fileUrl = null, fileName = null, fileSize = null;

    if (type !== 'text') {
      if (!body.file_base64) return json(res, 400, { error: 'Missing file data.' });
      fileName = body.file_name ? String(body.file_name).slice(0, 100) : (type + '.bin');
      const up = await uploadChatMedia(sessionId, body.file_base64, body.mime_type || 'application/octet-stream', fileName);
      if (!up.ok) return json(res, 500, { error: up.error || 'Upload failed.' });
      fileUrl = up.url;
      try { fileSize = Buffer.from(String(body.file_base64).replace(/^data:[^,]+,/, ''), 'base64').length; } catch {}
    } else if (!content) {
      return json(res, 400, { error: 'Empty message.' });
    }

    const ins = await supabaseInsert('chat_messages', {
      session_id: sessionId,
      registration_id: registrationId,
      sender: 'user',
      sender_name: senderName,
      message_type: type,
      content,
      file_url: fileUrl,
      file_name: fileName,
      file_size: fileSize,
      is_read: false,
    });
    if (!ins.ok) return json(res, 500, { error: 'Could not save message.' });

    upsertPresence(sessionId, 'user', { typing_at: null }).catch(() => {});

    return json(res, 200, { success: true, item: ins.data?.[0] });
  }

  return json(res, 405, { error: 'Method not allowed' });
};

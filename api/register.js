const {
  supabaseQuery, supabaseInsert, supabaseDelete, verifyPayment, createTelegramInvite,
  checkRateLimit, validateRegistration, getPublicSettings,
  getClientIp, getFee, json, enforceSameOrigin,
} = require('./_lib');

/* ============================================================
   Safe insert — auto-heals missing columns
   ============================================================ */
async function safeInsert(table, record) {
  let attempt = { ...record };
  const stripped = [];

  for (let i = 0; i < 20; i++) {
    const res = await supabaseInsert(table, attempt);
    if (res.ok) {
      if (stripped.length) console.warn(`[register] inserted after stripping columns: ${stripped.join(', ')}`);
      return res;
    }

    const errText = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data || '');

    const m = errText.match(/find the '([^']+)' column/i);
    if (m && m[1] && Object.prototype.hasOwnProperty.call(attempt, m[1])) {
      console.warn(`[register] column '${m[1]}' missing, stripping`);
      stripped.push(m[1]);
      delete attempt[m[1]];
      // Fire-and-forget audit trail so schema drift is visible in production.
      (async () => {
        try {
          await supabaseInsert('admin_actions', {
            admin_id:       null,
            admin_username: 'system',
            action:         'schema_drift',
            target_type:    table,
            target_id:      m[1],
            details:        { stripped_column: m[1] },
          });
        } catch {}
      })();
      continue;
    }

    return res;
  }
  return { ok: false, status: 500, data: { error: 'Schema mismatch after many retries' } };
}

function interpretInsertError(ins) {
  const d = ins.data || {};
  const code = d.code || '';
  const msg  = String(d.message || '');
  const details = String(d.details || '');

  if (code === '23514' || /check constraint/i.test(msg)) {
    return {
      error: 'Payment method is not accepted by the server. Please contact ABJ support.',
      code: 'payment_method_rejected',
      hint: 'The database has a CHECK constraint that rejects this bank name.',
    };
  }
  if (code === '23505' || /duplicate key/i.test(msg)) {
    return { error: 'This registration already exists.', code: 'duplicate' };
  }
  if (code === '23502' || /null value in column/i.test(msg)) {
    const m = msg.match(/column "([^"]+)"/);
    return {
      error: 'Registration is missing a required field. Please contact ABJ support.',
      code: 'missing_field',
      hint: m ? `Required column: ${m[1]}` : details,
    };
  }
  return { error: 'Could not save your registration. Please try again.', code: 'insert_failed', hint: details || msg };
}

module.exports = async (req, res) => {
  try {
    if (enforceSameOrigin(req, res)) return;

    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    const ip = getClientIp(req);
    // Fail closed: if the rate-limit RPC errors we still block registration
    // rather than letting attackers hammer the verify API.
    const allowed = await checkRateLimit(ip, 3, { failOpen: false });
    if (!allowed) return json(res, 429, { error: 'Too many attempts from this network. Please try again in a minute.' });

    const body = req.body || {};

    // Load public settings once: contains the fee and the list of banks
    let publicSettings = { fee: null, custom_banks: [] };
    try {
      publicSettings = await getPublicSettings();
    } catch {}

    const banks = Array.isArray(publicSettings.custom_banks) ? publicSettings.custom_banks : [];
    const validMethods = banks.map(b => b.name);

    if (!validMethods.length) {
      return json(res, 400, { error: 'No payment methods are configured yet. Please contact ABJ support.' });
    }

    // Registration is disabled unless admin has set a fee
    if (publicSettings.fee == null || publicSettings.fee <= 0) {
      return json(res, 400, {
        error: 'Registration is not yet configured. Please contact ABJ support.',
        code: 'not_configured',
      });
    }

    const validationError = validateRegistration(body, validMethods);
    if (validationError) return json(res, 400, { error: validationError });

    const {
      full_name, id_number, semester, stream, gender,
      payment_method, transaction_ref,
    } = body;

    const ref = String(transaction_ref).trim();
    const rawId = id_number.trim().toUpperCase().replace(/\s+/g, '');
    const public_id = rawId.replace(/\//g, '-');

    // Find the chosen bank record so we can extract the receiving account number
    const bank = banks.find(b => String(b.name).toLowerCase() === String(payment_method).toLowerCase());
    if (!bank || !bank.account) {
      return json(res, 400, { error: 'The selected payment method is not properly configured. Please contact ABJ support.' });
    }

    const bankAccount = bank.account;

    /* 1. Duplicate Student ID check */
    const existingUni = await supabaseQuery(
      `registrations?public_id=eq.${encodeURIComponent(public_id)}&select=public_id,status,id_number,verification_status&limit=1`
    );
    if (existingUni.ok && existingUni.data && existingUni.data.length > 0) {
      const prev = existingUni.data[0];

      if (prev.status === 'pending' && prev.verification_status === 'needs_manual') {
        return json(res, 200, {
          success: true,
          public_id: prev.public_id,
          id_number: prev.id_number,
          status: 'pending',
          needs_screenshot: true,
          verify_message: 'Please upload a screenshot of your payment receipt.',
          message: 'Automated verification could not confirm your payment. Please upload a screenshot to complete your registration.',
        });
      }

      if (prev.status === 'pending' || prev.status === 'approved') {
        return json(res, 409, {
          error: 'This Student ID is already registered. Use "Check My Status" to see your registration.',
          code: 'already_registered',
          public_id: prev.public_id,
        });
      }
      if (prev.status === 'rejected') {
        await supabaseDelete(`registrations?public_id=eq.${encodeURIComponent(prev.public_id)}`);
      }
    }

    /* 2. Reference uniqueness (allow reuse if the prior attempt was rejected) */
    const existingRef = await supabaseQuery(
      `registrations?transaction_ref=eq.${encodeURIComponent(ref)}&select=public_id,status,verification_status&limit=1`
    );
    if (existingRef.ok && existingRef.data && existingRef.data.length > 0) {
      const prev = existingRef.data[0];

      // Same public_id was already handled above (student-ID block).
      // Here we only care about a DIFFERENT public_id reusing the same ref.
      if (prev.public_id !== public_id) {
        if (prev.status === 'rejected') {
          // Free up the ref so the student can retry.
          await supabaseDelete(`registrations?public_id=eq.${encodeURIComponent(prev.public_id)}`);
        } else {
          return json(res, 409, { error: 'This transaction reference has already been used.' });
        }
      }
    }

    /* 3. Verify with Verify.ET */
    let verify;
    try {
      verify = await verifyPayment({
        reference: ref,
        bankName: bank.name,
        bankAccount,
        phone: null,
      });
    } catch (e) {
      console.error('[register] verifyPayment threw:', e);
      verify = { result: 'service_error', message: 'Verification service error. Please upload a screenshot.' };
    }
    const result = verify.result;

    const baseRecord = {
      public_id,
      full_name: full_name.trim().split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' '),
      id_number: rawId,
      semester,
      stream,
      gender,
      payment_method,
      transaction_ref: ref,
      receiver_account: verify.receiver || null,
      client_ip: ip,
      verify_error: verify.message || null,
    };

    /* ---------- CASE A — DUPLICATE reference ---------- */
    if (result === 'duplicate') {
      const ins = await safeInsert('registrations', {
        ...baseRecord,
        amount: 0,
        status: 'rejected',
        verification_status: 'auto_failed',
        auto_approved: false,
        rejection_reason: verify.message || 'This transaction reference has already been verified.',
      });
      if (!ins.ok && ins.status === 409) {
        return json(res, 409, { error: 'This transaction reference has already been used.' });
      }
      return json(res, 400, {
        error: verify.message || 'This transaction reference has already been used.',
        code: 'duplicate',
      });
    }

    /* ---------- CASE B — VERIFIED SUCCESS ---------- */
    if (result === 'success') {
      const expected = await getFee();
      if (expected == null) {
        return json(res, 500, {
          error: 'Registration is not yet configured. Please contact ABJ support.',
          code: 'not_configured',
        });
      }
      const received = parseFloat(verify.amount);

      if (Math.abs(received - expected) > 0.01) {
        const diff = Math.abs(received - expected);
        const reason = `Payment amount does not match. Received ETB ${received.toLocaleString()}, required exactly ETB ${expected.toLocaleString()} (${received < expected ? 'short by' : 'over by'} ETB ${diff.toLocaleString()}).`;
        const ins = await safeInsert('registrations', {
          ...baseRecord,
          amount: received,
          status: 'rejected',
          verification_status: 'auto_failed',
          auto_approved: false,
          rejection_reason: reason,
        });
        if (!ins.ok && ins.status === 409) {
          return json(res, 409, { error: 'This transaction reference has already been used.' });
        }
        return json(res, 400, {
          error: `Payment amount does not match. Received ETB ${received.toLocaleString()}, required exactly ETB ${expected.toLocaleString()}.`,
          code: 'amount_mismatch',
        });
      }

      let invite = null, inviteErr = null;
      try {
        invite = await createTelegramInvite(`ABJ-${public_id}`);
      } catch (e) {
        inviteErr = e.message || 'Invite creation failed';
      }

      const now = new Date().toISOString();
      const record = {
        ...baseRecord,
        amount: received,
        status: invite ? 'approved' : 'pending',
        verification_status: invite ? 'auto_verified' : 'auto_verified_invite_pending',
        auto_approved: true,
        approved_at: invite ? now : null,
        invite_link: invite ? invite.invite_link : null,
        invite_link_created_at: invite ? now : null,
        approved_by: 'auto:verify.et',
        rejection_reason: inviteErr ? `Auto-approved but invite failed: ${inviteErr}` : null,
      };

      const insert = await safeInsert('registrations', record);
      if (!insert.ok) {
        if (insert.status === 409) {
          return json(res, 409, { error: 'This transaction reference has already been used.' });
        }
        const info = interpretInsertError(insert);
        console.error('[register] insert failed (success path):', JSON.stringify(insert));
        return json(res, 500, info);
      }

      return json(res, 200, {
        success: true,
        public_id,
        id_number: rawId,
        status: record.status,
        auto_approved: true,
        invite_link: invite ? invite.invite_link : null,
        message: invite
          ? 'Verified automatically. Welcome to ABJ!'
          : 'Payment verified. Invite link will be ready shortly — check status in a moment.',
      });
    }

    /* ---------- CASE C — NEEDS SCREENSHOT / MANUAL REVIEW ---------- */
    const needsScreenshot = [
      'pending', 'service_error', 'not_found', 'failed', 'mismatch', 'invalid',
    ].includes(result);

    const ins = await safeInsert('registrations', {
      ...baseRecord,
      amount: 0,
      status: 'pending',
      verification_status: needsScreenshot ? 'needs_manual' : 'auto_pending',
      auto_approved: false,
    });

    if (!ins.ok) {
      if (ins.status === 409) {
        return json(res, 409, { error: 'This transaction reference has already been used.' });
      }
      const info = interpretInsertError(ins);
      console.error('[register] insert failed (needs_manual path):', JSON.stringify(ins));
      return json(res, 500, info);
    }

    return json(res, 200, {
      success: true,
      public_id,
      id_number: rawId,
      status: 'pending',
      needs_screenshot: needsScreenshot,
      verify_message: verify.message || null,
      message: needsScreenshot
        ? 'Automated verification could not confirm your payment. Please upload a screenshot to complete your registration.'
        : 'Registration received. Awaiting manual review.',
    });
  } catch (err) {
    console.error('[register] FATAL:', err);
    return json(res, 500, { error: 'Server error: ' + (err.message || String(err)) });
  }
};

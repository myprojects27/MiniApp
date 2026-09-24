const { checkRateLimit, getClientIp } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(ip, 60);

  // Debug endpoint: /api/ping?dbg=1&ref=FT26262VQ6GV&suf=35207333
  if (req.query && req.query.dbg === '1' && req.query.ref) {
    try {
      const { verifyBankPayment } = require('./_verify');
      const out = await verifyBankPayment({
        bankKey: String(req.query.bank || 'cbe'),
        reference: String(req.query.ref),
        suffix: req.query.suf ? String(req.query.suf) : undefined,
      });
      return res.status(200).json({
        ok: true,
        bank: req.query.bank || 'cbe',
        ref: req.query.ref,
        suffix: req.query.suf || null,
        parser_result: out,
      });
    } catch (e) {
      return res.status(200).json({
        ok: false,
        error: e.message,
        stack: String(e.stack || '').slice(0, 500),
      });
    }
  }

  res.status(allowed ? 200 : 429).json({
    ok: allowed,
    timestamp: new Date().toISOString(),
    url: req.url,
    method: req.method,
    rate_limit_ok: allowed,
    env: {
      hasSupabaseUrl: !!process.env.SUPABASE_URL,
      hasSupabaseKey: !!process.env.SUPABASE_SERVICE_KEY,
      hasJwtSecret:   !!process.env.JWT_SECRET,
    },
  });
};
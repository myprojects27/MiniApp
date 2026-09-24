const { checkRateLimit, getClientIp } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(ip, 60);

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

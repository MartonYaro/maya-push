/**
 * Tiny in-memory rate limiter (per-IP token bucket).
 * No deps. Resets on process restart — fine for single-instance deploy.
 *
 * Usage:
 *   app.post('/api/auth/login', rateLimit({ windowMs: 60_000, max: 5 }), ...);
 */
const buckets = new Map();   // key → { count, reset }

function clientKey(req) {
  // Render forwards real IP via x-forwarded-for; req.ip works once trust proxy is on.
  return (req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'unknown')
    .toString().split(',')[0].trim();
}

export function rateLimit({ windowMs = 60_000, max = 30, keyName = 'ip' } = {}) {
  return function(req, res, next) {
    const key = `${keyName}:${clientKey(req)}:${req.method}:${req.path}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.reset < now) {
      buckets.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    b.count++;
    if (b.count > max) {
      const retryAfter = Math.max(1, Math.ceil((b.reset - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'rate_limited',
        message: `Слишком много запросов. Подожди ${retryAfter}с.`,
        retry_after: retryAfter,
      });
    }
    next();
  };
}

// Cleanup expired buckets periodically (low overhead).
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
}, 5 * 60_000).unref?.();

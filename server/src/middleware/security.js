/* Minimal security headers — no external deps.
   Equivalent to a stripped-down `helmet` for our setup. */

export function securityHeaders(_req, res, next) {
  // Click-jacking
  res.setHeader('X-Frame-Options', 'DENY');
  // MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Referrer
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // HSTS only meaningful on HTTPS — Render terminates TLS at edge
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Content-Security-Policy — relaxed for inline styles/scripts our HTML uses today.
  // Tighten once we extract inline JS/CSS.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self' https:",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; ')
  );
  next();
}

/* Lightweight access log: method, path, status, ms — single line per request. */
export function accessLog(req, res, next) {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    // Skip noisy SSE keep-alive
    if (req.path === '/api/stream') return;
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms ip=${ip}`);
  });
  next();
}

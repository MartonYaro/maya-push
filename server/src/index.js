import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import authRoutes from './routes/auth.js';
import appsRoutes from './routes/apps.js';
import keywordsRoutes from './routes/keywords.js';
import txRoutes from './routes/transactions.js';
import dashboardRoutes from './routes/dashboard.js';
import adminRoutes from './routes/admin.js';
import researchRoutes from './routes/research.js';
import { attachStream } from './sse.js';
import { runPositionTick } from './services/positionWorker.js';
import { runBackup } from './services/backup.js';
import { securityHeaders, accessLog } from './middleware/security.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.warn('[boot] JWT_SECRET is missing or weak — set it in .env');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me-please-32';
}

const app = express();
app.set('trust proxy', 1);          // Render terminates TLS at edge
app.use(securityHeaders);
app.use(accessLog);
app.use(cors({ origin: process.env.ALLOW_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

/* ─── Domain split: mayapush.com (marketing) vs app.mayapush.com (product) ───
   Both hosts point to this same Render service. The middleware below ensures:
     mayapush.com   → only landing + ToS/Privacy + static assets stay; everything
                      else (e.g. /dashboard, /admin) 301-redirects to app subdomain.
     app.mayapush.com → root "/" 302-redirects to /dashboard.
   API endpoints (/api/*) and SSE (/api/stream) work on BOTH hosts so password-reset
   links and OAuth callbacks remain valid even mid-migration. */
const APP_HOST       = (process.env.APP_HOST       || 'app.mayapush.com').toLowerCase();
const MARKETING_HOST = (process.env.MARKETING_HOST || 'mayapush.com').toLowerCase();
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase().split(':')[0];

  // Marketing host: keep landing-only paths, push product paths to app subdomain
  if (host === MARKETING_HOST || host === 'www.' + MARKETING_HOST) {
    const p = req.path;
    const stayOnRoot =
      p === '/' ||
      p === '/tos' || p === '/tos.html' ||
      p === '/privacy' || p === '/privacy.html' ||
      p.startsWith('/api/') ||
      /\.(png|jpg|jpeg|gif|svg|ico|webp|css|js|woff2?|ttf|map|txt|xml|json)$/i.test(p);
    if (!stayOnRoot) {
      return res.redirect(301, `https://${APP_HOST}${req.originalUrl}`);
    }
  }

  // Product host: bare root → dashboard
  if (host === APP_HOST && (req.path === '/' || req.path === '/index.html')) {
    return res.redirect(302, '/dashboard');
  }

  next();
});

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  ts: Date.now(),
  uptime: Math.round(process.uptime()),
  env: process.env.NODE_ENV || 'development',
  apptweak: !!process.env.APPTWEAK_API_KEY,
  email: !!process.env.RESEND_API_KEY,
  telegram: !!process.env.TELEGRAM_BOT_TOKEN,
}));

app.use('/api/auth', authRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/keywords', keywordsRoutes);
app.use('/api/transactions', txRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/research', researchRoutes);

app.get('/api/stream', (req, res) => attachStream(req, res));

// Static frontend
const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, '../../web');
app.use(express.static(webRoot, { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(resolve(webRoot, 'index.html')));
app.get('/dashboard', (_req, res) => res.sendFile(resolve(webRoot, 'dashboard.html')));

// JSON error handler
app.use((err, _req, res, _next) => {
  console.error('[err]', err);
  res.status(500).json({ error: 'internal', message: err.message });
});

const port = +process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`MAYA API listening on http://localhost:${port}`);
  console.log(`Static web: ${webRoot}`);
});

// Cron: position tick
const cronExpr = process.env.POSITION_CRON || '0 */6 * * *';
let cronJob = null;
if (cron.validate(cronExpr)) {
  cronJob = cron.schedule(cronExpr, () => {
    runPositionTick().catch(err => console.error('[cron] tick failed:', err));
  });
  console.log(`[cron] position tick scheduled: ${cronExpr}`);
} else {
  console.warn(`[cron] invalid POSITION_CRON: ${cronExpr}`);
}

// Daily DB backup (03:17 UTC by default — off-peak, off-the-hour to avoid spikes)
const backupExpr = process.env.BACKUP_CRON || '17 3 * * *';
let backupJob = null;
if (cron.validate(backupExpr)) {
  backupJob = cron.schedule(backupExpr, () => {
    runBackup().catch(err => console.error('[cron] backup failed:', err));
  });
  console.log(`[cron] daily backup scheduled: ${backupExpr}`);
}

// Graceful shutdown — important on paid plans where rolling deploys send SIGTERM.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[boot] ${signal} received — graceful shutdown`);
  try { cronJob?.stop(); } catch {}
  try { backupJob?.stop(); } catch {}
  server.close(() => {
    console.log('[boot] http server closed');
    process.exit(0);
  });
  // Hard exit after 15s if connections hang
  setTimeout(() => {
    console.warn('[boot] forced exit after timeout');
    process.exit(1);
  }, 15_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

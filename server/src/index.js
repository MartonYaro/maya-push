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

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.warn('[boot] JWT_SECRET is missing or weak — set it in .env');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me-please-32';
}

const app = express();
app.set('trust proxy', 1);          // Render terminates TLS at edge
app.use(cors({ origin: process.env.ALLOW_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

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
app.listen(port, () => {
  console.log(`MAYA API listening on http://localhost:${port}`);
  console.log(`Static web: ${webRoot}`);
});

// Cron: position tick
const cronExpr = process.env.POSITION_CRON || '0 */6 * * *';
if (cron.validate(cronExpr)) {
  cron.schedule(cronExpr, () => {
    runPositionTick().catch(err => console.error('[cron] tick failed:', err));
  });
  console.log(`[cron] position tick scheduled: ${cronExpr}`);
} else {
  console.warn(`[cron] invalid POSITION_CRON: ${cronExpr}`);
}

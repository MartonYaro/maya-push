import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Boot smoke test: start the server exactly as production does
 * (`node src/index.js`) and confirm it serves /api/health. This is the cheap
 * net that catches the whole class of bugs that have 502'd prod before — a TDZ
 * reference, a bad import, a syntax error in any module loaded at boot. If the
 * process can't come up and answer health, this fails and CI blocks the deploy.
 *
 * Requires the native better-sqlite3 binary, so it runs green in CI (Linux) but
 * is expected to fail on the Windows dev box where it won't compile.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(__dirname, '..');
const entry = join(serverDir, 'src', 'index.js');

let child;
let port;
let dataDir;

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function waitForHealth(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 250));
    if (child.exitCode != null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
  }
  throw new Error(`health never became ready: ${lastErr?.message || 'timeout'}`);
}

before(async () => {
  port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), 'maya-boot-'));
  child = spawn(process.execPath, [entry], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      JWT_SECRET: 'test-secret-at-least-16-chars-long',
      DB_PATH: join(dataDir, 'maya.db'),
      // Keep the boot quiet & cron-free; invalid exprs are simply skipped.
      POSITION_CRON: 'off',
      BACKUP_CRON: 'off',
      DIGEST_CRON: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
});

after(() => {
  try { child?.kill(); } catch {}
  if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }
});

test('server boots and /api/health reports ok', async () => {
  const res = await waitForHealth(`http://127.0.0.1:${port}/api/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.store, true);
  assert.equal(typeof body.uptime, 'number');
});

test('/api/config responds without auth', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.equal(res.ok, true);
  const body = await res.json();
  // shape check — keys present regardless of which integrations are configured
  assert.ok('cryptoEnabled' in body);
  assert.ok('googleClientId' in body);
});

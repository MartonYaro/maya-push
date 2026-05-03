/**
 * SQLite hot backup. Uses better-sqlite3's online backup API
 * (works while DB is in use, no locks). Keeps last N backups.
 *
 * Backup dir defaults to <DB_PATH dir>/backups, but can be overridden
 * via BACKUP_DIR — useful when you want it on a different volume.
 */
import { promises as fs } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { db } from '../db.js';

const KEEP = +process.env.BACKUP_KEEP || 7;     // last 7 daily backups by default

function backupDir() {
  if (process.env.BACKUP_DIR) return resolve(process.env.BACKUP_DIR);
  const dbPath = process.env.DB_PATH || './data/maya.db';
  return resolve(dirname(dbPath), 'backups');
}

export async function runBackup() {
  const dir = backupDir();
  await fs.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dbName = basename(process.env.DB_PATH || 'maya.db', '.db');
  const target = join(dir, `${dbName}-${stamp}.db`);

  // better-sqlite3 backup() returns a promise; non-blocking
  await db.backup(target);
  console.log(`[backup] wrote ${target}`);

  // Rotate: keep only the most recent KEEP files matching prefix
  try {
    const files = (await fs.readdir(dir))
      .filter(f => f.startsWith(`${dbName}-`) && f.endsWith('.db'))
      .sort();    // ISO stamps sort lexicographically by time
    const stale = files.slice(0, Math.max(0, files.length - KEEP));
    for (const f of stale) {
      await fs.unlink(join(dir, f)).catch(() => {});
    }
    if (stale.length) console.log(`[backup] rotated out ${stale.length} old file(s)`);
  } catch (e) {
    console.warn('[backup] rotation failed:', e.message);
  }

  return { path: target };
}

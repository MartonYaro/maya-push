/**
 * Position-tracking worker.
 *
 * Strategy: group active keywords by app, fetch ranks for each app in ONE
 * AppTweak call (cheaper than per-keyword), persist into keyword_positions
 * and broadcast SSE.
 */
import { db, now } from '../db.js';
import { appTweak } from './apptweak.js';
import { broadcast } from '../sse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickSimulatedPosition(prev, target) {
  const cur = prev || 100;
  const t = target || 10;
  if (cur <= t) {
    const j = Math.random() < 0.4 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    return Math.max(1, cur + j);
  }
  const step = 1 + Math.floor(Math.random() * 3);
  const regress = Math.random() < 0.1 ? Math.floor(Math.random() * 3) : 0;
  return Math.max(t, cur - step + regress);
}

export async function runPositionTick({ logger = console } = {}) {
  // Group active keywords by app (and country).
  const groups = db.prepare(`
    SELECT a.id AS app_id, a.user_id, a.store_id, a.country, a.status AS app_status
    FROM apps a
    WHERE a.status = 'active'
  `).all();

  const useReal = appTweak.isConfigured();
  let checked = 0;

  for (const app of groups) {
    const kws = db.prepare(
      `SELECT id, term, target_pos, current_pos FROM keywords WHERE app_id = ? AND status = 'active'`
    ).all(app.app_id);
    if (!kws.length) continue;

    let ranks = {};
    let source = useReal && app.store_id ? 'apptweak' : 'simulated';
    if (useReal && app.store_id) {
      try {
        ranks = await appTweak.fetchKeywordPositionsBulk(
          app.store_id, kws.map(k => k.term), app.country
        );
      } catch (e) {
        logger.warn('[worker] bulk failed:', e.message);
        ranks = {};
        source = 'simulated_fallback';
      }
      await sleep(300);
    }

    const ts = now();
    const insertPos = db.prepare(
      `INSERT INTO keyword_positions (keyword_id, position, checked_at, source) VALUES (?, ?, ?, ?)`
    );
    const updateKw = db.prepare(
      `UPDATE keywords SET current_pos = ?, last_checked_at = ? WHERE id = ?`
    );

    const tx = db.transaction(() => {
      for (const kw of kws) {
        let pos = ranks[kw.term];
        if (pos == null && !useReal) pos = pickSimulatedPosition(kw.current_pos, kw.target_pos);
        if (pos != null) insertPos.run(kw.id, pos, ts, source);
        updateKw.run(pos ?? null, ts, kw.id);
        broadcast(app.user_id, 'position.updated', {
          keyword_id: kw.id, app_id: app.app_id, position: pos ?? null,
          checked_at: ts, source,
        });
        checked++;
      }
    });
    tx();
  }

  logger.log(`[worker] tick done: ${checked} keywords, real=${useReal}`);
  return { checked };
}

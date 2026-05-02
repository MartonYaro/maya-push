#!/usr/bin/env node
/**
 * MAYA admin CLI — direct DB access, no HTTP.
 *
 * Usage (from maya/server):
 *   node scripts/admin.js promote <email>           # сделать пользователя админом
 *   node scripts/admin.js list-users                # все пользователи + балансы
 *   node scripts/admin.js list-pending              # все pending top-up'ы
 *   node scripts/admin.js confirm <txId>            # подтвердить транзакцию
 *   node scripts/admin.js reject <txId>             # отклонить транзакцию
 *   node scripts/admin.js credit <email> <amount> "comment"   # вручную зачислить/списать
 */
import 'dotenv/config';
import { db, getBalance, now } from '../src/db.js';

const [, , cmd, ...args] = process.argv;

function fmtTs(ts) { return new Date(ts).toISOString().replace('T', ' ').slice(0, 16); }
function fmtMoney(n) { return (n >= 0 ? '+' : '') + '$' + Number(n).toFixed(2); }
function table(rows, cols) {
  if (!rows.length) { console.log('(empty)'); return; }
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(widths.map(w => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map(c => r[c])));
}

function findUser(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
}

const cmds = {
  promote(email) {
    const u = findUser(email);
    if (!u) return console.error(`User not found: ${email}`);
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', u.id);
    console.log(`OK: ${u.email} → admin`);
  },

  'list-users'() {
    const rows = db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.created_at,
        COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = u.id AND status = 'done'), 0) AS balance,
        (SELECT COUNT(*) FROM apps WHERE user_id = u.id) AS apps
      FROM users u ORDER BY u.created_at DESC
    `).all().map(r => ({ ...r, created_at: fmtTs(r.created_at), balance: fmtMoney(r.balance) }));
    table(rows, ['id', 'email', 'name', 'role', 'balance', 'apps', 'created_at']);
  },

  'list-pending'() {
    const rows = db.prepare(`
      SELECT t.id, u.email, t.type, t.amount, t.status, t.description, t.created_at
      FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE t.status = 'pending' ORDER BY t.created_at DESC
    `).all().map(r => ({ ...r, created_at: fmtTs(r.created_at), amount: fmtMoney(r.amount) }));
    table(rows, ['id', 'email', 'type', 'amount', 'description', 'created_at']);
  },

  confirm(id) {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!tx) return console.error('Transaction not found');
    if (tx.status !== 'pending') return console.error('Not pending: ' + tx.status);
    db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('done', tx.id);
    console.log(`OK: tx#${tx.id} confirmed. New balance for user#${tx.user_id}: $${getBalance(tx.user_id).toFixed(2)}`);
  },

  reject(id) {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!tx) return console.error('Transaction not found');
    if (tx.status !== 'pending') return console.error('Not pending: ' + tx.status);
    db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('rejected', tx.id);
    console.log(`OK: tx#${tx.id} rejected`);
  },

  credit(email, amount, ...descParts) {
    const u = findUser(email);
    if (!u) return console.error(`User not found: ${email}`);
    const a = parseFloat(amount);
    if (!a) return console.error('Amount must be non-zero number');
    const desc = descParts.join(' ') || 'Manual adjustment by admin';
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount, status, description, created_at)
       VALUES (?, ?, ?, 'done', ?, ?)`
    ).run(u.id, a > 0 ? 'topup' : 'spend', a, desc, now());
    console.log(`OK: ${fmtMoney(a)} → ${u.email}. New balance: $${getBalance(u.id).toFixed(2)}`);
  },
};

if (!cmd || !cmds[cmd]) {
  console.log(`Usage:
  promote <email>
  list-users
  list-pending
  confirm <txId>
  reject <txId>
  credit <email> <amount> [comment...]`);
  process.exit(1);
}
cmds[cmd](...args);

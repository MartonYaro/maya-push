/**
 * Tiny per-user SSE broker. No deps.
 *  - clients keyed by userId, value is Set<res>
 *  - broadcast(userId, event, data) writes to all connections of that user
 */
import jwt from 'jsonwebtoken';

const clients = new Map(); // userId -> Set<res>

export function attachStream(req, res) {
  // SSE token comes from query (EventSource can't set headers)
  const token = req.query.token;
  if (!token) return res.status(401).end();
  let userId;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET).sub;
  } catch {
    return res.status(401).end();
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`: connected\n\n`);

  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);

  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 25_000);

  req.on('close', () => {
    clearInterval(ping);
    const set = clients.get(userId);
    if (set) {
      set.delete(res);
      if (!set.size) clients.delete(userId);
    }
  });
}

export function broadcast(userId, event, data) {
  const set = clients.get(userId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch {}
  }
}

export function broadcastAll(event, data) {
  for (const userId of clients.keys()) broadcast(userId, event, data);
}

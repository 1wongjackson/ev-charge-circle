import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, getMeta, setMeta } from './db.js';

const PORT = Number(process.env.PORT) || 3000;
// How long the head of the queue has the charger to themselves once it frees up.
const RESERVE_MINUTES = Number(process.env.RESERVE_MINUTES) || 15;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const nowIso = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader(
    'Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${COOKIE_SECURE ? '; Secure' : ''}`
  );
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    new Date(Date.now() + SESSION_TTL_MS).toISOString()
  );
  setSessionCookie(res, token, SESSION_TTL_MS / 1000);
}

function num(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, `${name} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  }
  return Math.round(n * 10) / 10;
}

function str(value, name, maxLen, { optional = false } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (optional) return null;
    throw new HttpError(400, `${name} is required`);
  }
  if (s.length > maxLen) throw new HttpError(400, `${name} must be at most ${maxLen} characters`);
  return s;
}

function futureTime(value) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw new HttpError(400, 'Expected end time is required');
  const diff = d.getTime() - Date.now();
  if (diff < 60_000) throw new HttpError(400, 'Expected end time must be in the future');
  if (diff > 24 * 3600_000) throw new HttpError(400, 'Expected end time must be within 24 hours');
  return d.toISOString();
}

function publicUser(u) {
  const estRange = Math.round((u.full_range_mi * u.charge_level) / 100);
  return {
    id: u.id,
    name: u.name,
    car_model: u.car_model,
    full_range_mi: u.full_range_mi,
    charge_level: u.charge_level,
    daily_miles: u.daily_miles,
    est_range_mi: estRange,
    days_of_range: u.daily_miles > 0 ? Math.round((estRange / u.daily_miles) * 10) / 10 : null,
    updated_at: u.updated_at,
  };
}

// ---------- auth middleware ----------

function auth(req, res, next) {
  const token = parseCookies(req).sid;
  const user =
    token &&
    db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(sha256(token), nowIso());
  if (!user) return next(new HttpError(401, 'Please log in'));
  req.user = user;
  next();
}

// Very small brute-force guard: 10 failed logins per IP per 15 minutes.
const failedLogins = new Map();
function checkLoginRate(ip) {
  const entry = failedLogins.get(ip);
  if (entry && entry.until > Date.now() && entry.count >= 10) {
    throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  }
}
function recordLoginFailure(ip) {
  const entry = failedLogins.get(ip);
  if (!entry || entry.until < Date.now()) failedLogins.set(ip, { count: 1, until: Date.now() + 15 * 60_000 });
  else entry.count++;
}

// ---------- live events (Server-Sent Events) ----------

const streams = new Set();

const eventSelect = `
  SELECT e.id, e.type, e.user_id, e.target_user_id, e.data, e.created_at,
         u.name AS actor, t.name AS target
  FROM events e
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN users t ON t.id = e.target_user_id`;

const formatEvent = (e) => ({ ...e, data: JSON.parse(e.data) });

function logEvent(type, userId, data = {}, targetUserId = null) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO events(type, user_id, target_user_id, data, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(type, userId, targetUserId, JSON.stringify(data), nowIso());
  const event = formatEvent(db.prepare(`${eventSelect} WHERE e.id = ?`).get(lastInsertRowid));
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of streams) res.write(payload);
}

// ---------- charger state ----------

const activeSession = () =>
  db
    .prepare(
      `SELECT c.*, u.name, u.car_model FROM charge_sessions c
       JOIN users u ON u.id = c.user_id WHERE c.ended_at IS NULL`
    )
    .get();

const queueRows = () =>
  db
    .prepare(
      `SELECT q.user_id, q.joined_at, q.note, u.name, u.car_model, u.charge_level,
              u.daily_miles, u.full_range_mi
       FROM queue q JOIN users u ON u.id = q.user_id
       ORDER BY q.joined_at, q.user_id`
    )
    .all();

// When the charger is free and someone is waiting, hold it for the head of the
// queue for RESERVE_MINUTES and tell them it's their turn.
function refreshReservation() {
  const head = queueRows()[0];
  if (activeSession() || !head) {
    setMeta('reserved_for', null);
    setMeta('reserved_until', null);
    return;
  }
  if (Number(getMeta('reserved_for')) !== head.user_id) {
    const until = new Date(Date.now() + RESERVE_MINUTES * 60_000).toISOString();
    setMeta('reserved_for', head.user_id);
    setMeta('reserved_until', until);
    logEvent('your_turn', null, { until }, head.user_id);
  }
}

function chargerState() {
  const active = activeSession();
  const reservedFor = Number(getMeta('reserved_for')) || null;
  const reservedUntil = getMeta('reserved_until');
  const reservation =
    reservedFor && reservedUntil && reservedUntil > nowIso()
      ? {
          user_id: reservedFor,
          name: db.prepare('SELECT name FROM users WHERE id = ?').get(reservedFor)?.name,
          until: reservedUntil,
        }
      : null;
  return {
    active: active && {
      id: active.id,
      user_id: active.user_id,
      name: active.name,
      car_model: active.car_model,
      started_at: active.started_at,
      expected_end: active.expected_end,
      start_level: active.start_level,
    },
    queue: queueRows(),
    reservation,
  };
}

// ---------- routes: auth ----------

app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 'Name', 60);
  const email = str(b.email, 'Email', 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const carModel = str(b.car_model, 'Car model', 60);
  const fullRange = num(b.full_range_mi, 'Full-charge range', 10, 1000);
  const charge = num(b.charge_level, 'Charge level', 0, 100, 50);
  const daily = num(b.daily_miles, 'Daily mileage', 0, 1000, 30);

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with that email already exists');
  }
  const now = nowIso();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO users(name, email, password_hash, car_model, full_range_mi, charge_level, daily_miles, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, email, hashPassword(password), carModel, fullRange, charge, daily, now, now);
  startSession(res, lastInsertRowid);
  logEvent('registered', lastInsertRowid, { car_model: carModel });
  res.status(201).json({ ok: true });
});

app.post('/api/login', (req, res) => {
  checkLoginRate(req.ip);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordLoginFailure(req.ip);
    throw new HttpError(401, 'Wrong email or password');
  }
  failedLogins.delete(req.ip);
  startSession(res, user.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

// ---------- routes: community ----------

app.get('/api/state', auth, (req, res) => {
  const drivers = db.prepare('SELECT * FROM users ORDER BY name').all().map(publicUser);
  const events = db.prepare(`${eventSelect} ORDER BY e.id DESC LIMIT 60`).all().map(formatEvent);
  res.json({
    me: publicUser(req.user),
    drivers,
    charger: chargerState(),
    events,
    reserve_minutes: RESERVE_MINUTES,
  });
});

app.put('/api/me', auth, (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const charge = num(b.charge_level, 'Charge level', 0, 100, u.charge_level);
  const daily = num(b.daily_miles, 'Daily mileage', 0, 1000, u.daily_miles);
  const fullRange = num(b.full_range_mi, 'Full-charge range', 10, 1000, u.full_range_mi);
  const carModel = b.car_model === undefined ? u.car_model : str(b.car_model, 'Car model', 60);
  db.prepare(
    'UPDATE users SET charge_level = ?, daily_miles = ?, full_range_mi = ?, car_model = ?, updated_at = ? WHERE id = ?'
  ).run(charge, daily, fullRange, carModel, nowIso(), u.id);
  logEvent('status', u.id, { charge_level: charge, daily_miles: daily });
  res.json({ ok: true });
});

app.post('/api/broadcast', auth, (req, res) => {
  const message = str(req.body?.message, 'Message', 280);
  logEvent('message', req.user.id, { message });
  res.json({ ok: true });
});

// ---------- routes: the shared charger ----------

app.post('/api/charger/start', auth, (req, res) => {
  const expectedEnd = futureTime(req.body?.expected_end);
  const me = req.user;
  if (activeSession()) throw new HttpError(409, 'The charger is already in use');
  const { reservation } = chargerState();
  if (reservation && reservation.user_id !== me.id) {
    throw new HttpError(409, `The charger is reserved for ${reservation.name} (next in the queue) for a few more minutes`);
  }
  db.prepare(
    'INSERT INTO charge_sessions(user_id, started_at, expected_end, start_level) VALUES (?, ?, ?, ?)'
  ).run(me.id, nowIso(), expectedEnd, me.charge_level);
  db.prepare('DELETE FROM queue WHERE user_id = ?').run(me.id);
  logEvent('start', me.id, { expected_end: expectedEnd, charge_level: me.charge_level });
  refreshReservation();
  res.json(chargerState());
});

app.post('/api/charger/update', auth, (req, res) => {
  const expectedEnd = futureTime(req.body?.expected_end);
  const active = activeSession();
  if (!active || active.user_id !== req.user.id) throw new HttpError(403, "You're not the one charging right now");
  db.prepare('UPDATE charge_sessions SET expected_end = ?, overdue_notified = 0 WHERE id = ?').run(expectedEnd, active.id);
  logEvent('extend', req.user.id, { expected_end: expectedEnd });
  res.json(chargerState());
});

app.post('/api/charger/end', auth, (req, res) => {
  const active = activeSession();
  if (!active || active.user_id !== req.user.id) throw new HttpError(403, "You're not the one charging right now");
  const endLevel = num(req.body?.end_level, 'Charge level', 0, 100, null);
  const now = nowIso();
  db.prepare('UPDATE charge_sessions SET ended_at = ?, end_level = ? WHERE id = ?').run(now, endLevel, active.id);
  if (endLevel !== null) {
    db.prepare('UPDATE users SET charge_level = ?, updated_at = ? WHERE id = ?').run(endLevel, now, req.user.id);
  }
  const minutes = Math.round((Date.parse(now) - Date.parse(active.started_at)) / 60_000);
  logEvent('end', req.user.id, { minutes, end_level: endLevel });
  refreshReservation();
  res.json(chargerState());
});

app.post('/api/queue/join', auth, (req, res) => {
  const note = str(req.body?.note, 'Note', 140, { optional: true });
  if (activeSession()?.user_id === req.user.id) throw new HttpError(409, "You're already charging");
  if (db.prepare('SELECT 1 FROM queue WHERE user_id = ?').get(req.user.id)) {
    throw new HttpError(409, "You're already in the queue");
  }
  db.prepare('INSERT INTO queue(user_id, joined_at, note) VALUES (?, ?, ?)').run(req.user.id, nowIso(), note);
  logEvent('queue_join', req.user.id, { note });
  refreshReservation();
  res.json(chargerState());
});

app.post('/api/queue/leave', auth, (req, res) => {
  const { changes } = db.prepare('DELETE FROM queue WHERE user_id = ?').run(req.user.id);
  if (!changes) throw new HttpError(409, "You're not in the queue");
  logEvent('queue_leave', req.user.id);
  refreshReservation();
  res.json(chargerState());
});

// Charging history for the usage view; aggregation happens client-side so
// days and hours are bucketed in the viewer's local time zone.
app.get('/api/sessions', auth, (req, res) => {
  const days = num(req.query.days, 'Days', 1, 365, 30);
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const rows = db
    .prepare(
      `SELECT c.id, c.user_id, u.name, c.started_at, c.expected_end, c.ended_at, c.start_level, c.end_level
       FROM charge_sessions c JOIN users u ON u.id = c.user_id
       WHERE COALESCE(c.ended_at, '9999') >= ? ORDER BY c.started_at`
    )
    .all(since);
  res.json({ since, sessions: rows });
});

app.get('/api/stream', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  streams.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    streams.delete(res);
  });
});

app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));

app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
});

// ---------- background jobs ----------

setInterval(() => {
  // Nudge the driver (and everyone waiting) when the promised end time passes.
  const active = activeSession();
  if (active && !active.overdue_notified && active.expected_end < nowIso()) {
    db.prepare('UPDATE charge_sessions SET overdue_notified = 1 WHERE id = ?').run(active.id);
    logEvent('overdue', null, { expected_end: active.expected_end }, active.user_id);
  }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}, 30_000);

app.listen(PORT, () => {
  console.log(`EV Charge Circle running at http://localhost:${PORT}`);
});

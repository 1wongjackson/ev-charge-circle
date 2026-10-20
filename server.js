import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { all, one, getMeta, setMeta } from './db.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { carImagesFor, modelKey, resolveCarImage } from './carPhotos.js';

const PORT = Number(process.env.PORT) || 3000;
// How long the head of the queue has the charger to themselves once it frees up.
const RESERVE_MINUTES = Number(process.env.RESERVE_MINUTES) || 15;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1); // behind Render's proxy: real client IP for the login limiter
const PHOTO_PATH = '/api/me/photo';
const smallJson = express.json({ limit: '20kb' });
// Car photo uploads get a bigger body limit than everything else.
app.use((req, res, next) => (req.path === PHOTO_PATH ? next() : smallJson(req, res, next)));
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

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await all('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    sha256(token),
    userId,
    new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  ]);
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

const UNITS = ['imperial', 'metric'];
function units(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!UNITS.includes(value)) throw new HttpError(400, 'Units must be imperial or metric');
  return value;
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
    car_color: u.car_color,
    photo_version: u.car_photo_at, // null = no photo; changes bust the browser cache
    updated_at: u.updated_at,
  };
}

// Every users column except the photo itself, which is only read by the photo route.
const userCols = (p = '') =>
  ['id', 'name', 'email', 'password_hash', 'car_model', 'full_range_mi', 'charge_level', 'daily_miles',
   'units', 'car_color', 'car_photo_at', 'updated_at', 'created_at'].map((c) => p + c).join(', ');

const CAR_COLORS = ['#f4f5f2', '#1f2224', '#c3c8cc', '#6c757b', '#2f5fb3', '#c0392b', '#2e7d5b', '#e3b23c', '#e07a2e'];
function carColor(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (!CAR_COLORS.includes(value)) throw new HttpError(400, 'Pick one of the listed car colours');
  return value;
}

// Charger/queue changes read-then-write shared state, so run them one at a time.
let chargerLock = Promise.resolve();
function withChargerLock(fn) {
  const run = chargerLock.then(fn);
  chargerLock = run.catch(() => {});
  return run;
}
const serialized = (handler) => (req, res) => withChargerLock(() => handler(req, res));

// ---------- auth middleware ----------

async function auth(req, res, next) {
  const token = parseCookies(req).sid;
  const user =
    token &&
    (await one(
      `SELECT ${userCols('u.')} FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [sha256(token), nowIso()]
    ));
  if (!user) throw new HttpError(401, 'Please log in');
  req.user = user;
  next();
}

// Fixed-window counters, keyed by IP, email or 'all'. In memory, so they reset on restart.
class RateLimit {
  constructor(max, windowMs, message) {
    Object.assign(this, { max, windowMs, message, hits: new Map() });
  }
  check(key) {
    const entry = this.hits.get(key);
    if (entry && entry.until > Date.now() && entry.count >= this.max) throw new HttpError(429, this.message);
  }
  hit(key) {
    const entry = this.hits.get(key);
    if (!entry || entry.until < Date.now()) this.hits.set(key, { count: 1, until: Date.now() + this.windowMs });
    else entry.count++;
  }
  reset(key) {
    this.hits.delete(key);
  }
  prune() {
    for (const [key, entry] of this.hits) if (entry.until < Date.now()) this.hits.delete(key);
  }
}

const TRY_LATER = 'Too many attempts. Try again in a few minutes.';
// Brute-force guards: failed logins per IP and per account.
const failedLoginsByIp = new RateLimit(10, 15 * 60_000, TRY_LATER);
const failedLoginsByEmail = new RateLimit(5, 15 * 60_000, TRY_LATER);
// Sign-ups are expensive (scrypt, a broadcast, a Wikipedia lookup), so cap them too.
const signupsByIp = new RateLimit(5, 60 * 60_000, TRY_LATER);
const signupsTotal = new RateLimit(50, 60 * 60_000, 'Sign-ups are busy right now. Try again later.');
const rateLimits = [failedLoginsByIp, failedLoginsByEmail, signupsByIp, signupsTotal];

const MAX_PASSWORD = 128;

// ---------- live events (Server-Sent Events) ----------

const streams = new Set();

const eventSelect = `
  SELECT e.id, e.type, e.user_id, e.target_user_id, e.data, e.created_at,
         u.name AS actor, t.name AS target
  FROM events e
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN users t ON t.id = e.target_user_id`;

const formatEvent = (e) => ({ ...e, data: JSON.parse(e.data) });

async function logEvent(type, userId, data = {}, targetUserId = null) {
  const { id } = await one(
    'INSERT INTO events(type, user_id, target_user_id, data, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [type, userId, targetUserId, JSON.stringify(data), nowIso()]
  );
  const event = formatEvent(await one(`${eventSelect} WHERE e.id = $1`, [id]));
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of streams) res.write(payload);
}

// Tell every open page to re-fetch (e.g. a car photo finished downloading).
function broadcastRefresh() {
  for (const res of streams) res.write('data: {"type":"refresh"}\n\n');
}

// Look up a model's photo now, so it's ready by the time anyone looks.
const prefetchCarImage = (model) => resolveCarImage(model).then((found) => found && broadcastRefresh());

// ---------- charger state ----------

const activeSession = () =>
  one(
    `SELECT c.*, u.name, u.car_model FROM charge_sessions c
     JOIN users u ON u.id = c.user_id WHERE c.ended_at IS NULL`
  );

const queueRows = () =>
  all(
    `SELECT q.user_id, q.joined_at, q.note, u.name, u.car_model, u.charge_level,
            u.daily_miles, u.full_range_mi
     FROM queue q JOIN users u ON u.id = q.user_id
     ORDER BY q.joined_at, q.user_id`
  );

// When the charger is free and someone is waiting, hold it for the head of the
// queue for RESERVE_MINUTES and tell them it's their turn.
async function refreshReservation() {
  const [head] = await queueRows();
  if ((await activeSession()) || !head) {
    await setMeta('reserved_for', null);
    await setMeta('reserved_until', null);
    return;
  }
  if (Number(await getMeta('reserved_for')) !== head.user_id) {
    const until = new Date(Date.now() + RESERVE_MINUTES * 60_000).toISOString();
    await setMeta('reserved_for', head.user_id);
    await setMeta('reserved_until', until);
    await logEvent('your_turn', null, { until }, head.user_id);
  }
}

async function chargerState() {
  const active = await activeSession();
  const reservedFor = Number(await getMeta('reserved_for')) || null;
  const reservedUntil = await getMeta('reserved_until');
  const reservation =
    reservedFor && reservedUntil && reservedUntil > nowIso()
      ? {
          user_id: reservedFor,
          name: (await one('SELECT name FROM users WHERE id = $1', [reservedFor]))?.name,
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
    queue: await queueRows(),
    reservation,
  };
}

// ---------- routes: auth ----------

app.get('/healthz', (req, res) => res.send('ok'));

app.post('/api/register', async (req, res) => {
  signupsByIp.check(req.ip);
  signupsTotal.check('all');
  const b = req.body || {};
  const name = str(b.name, 'Name', 60);
  const email = str(b.email, 'Email', 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (password.length > MAX_PASSWORD) throw new HttpError(400, `Password must be at most ${MAX_PASSWORD} characters`);
  const carModel = str(b.car_model, 'Car model', 60);
  const fullRange = num(b.full_range_mi, 'Full-charge range', 10, 1000);
  const charge = num(b.charge_level, 'Charge level', 0, 100, 50);
  const daily = num(b.daily_miles, 'Daily mileage', 0, 1000, 30);
  const unitPref = units(b.units, 'imperial');

  signupsByIp.hit(req.ip);
  signupsTotal.hit('all');
  const now = nowIso();
  const created = await one(
    `INSERT INTO users(name, email, password_hash, car_model, full_range_mi, charge_level, daily_miles, units, updated_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [name, email, await hashPassword(password), carModel, fullRange, charge, daily, unitPref, now, now]
  );
  if (!created) throw new HttpError(409, 'An account with that email already exists');
  await startSession(res, created.id);
  await logEvent('registered', created.id, { car_model: carModel });
  prefetchCarImage(carModel);
  res.status(201).json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body?.password || '');
  failedLoginsByIp.check(req.ip);
  failedLoginsByEmail.check(email);
  const user = await one(`SELECT ${userCols()} FROM users WHERE email = $1`, [email]);
  // verifyPassword runs scrypt even without a user, so unknown emails aren't faster to reject.
  if (!(await verifyPassword(password, user?.password_hash))) {
    failedLoginsByIp.hit(req.ip);
    failedLoginsByEmail.hit(email);
    throw new HttpError(401, 'Wrong email or password');
  }
  failedLoginsByIp.reset(req.ip);
  failedLoginsByEmail.reset(email);
  await startSession(res, user.id);
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  const token = parseCookies(req).sid;
  if (token) await all('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

// ---------- routes: community ----------

/** publicUser plus the cached stock photo of each user's car model. */
async function withCarImages(users) {
  const images = await carImagesFor(users.map((u) => u.car_model), broadcastRefresh);
  return users.map((u) => {
    const image = images.get(modelKey(u.car_model));
    return { ...publicUser(u), car_image: image ?? null, car_image_pending: image === undefined };
  });
}

app.get('/api/state', auth, async (req, res) => {
  const users = await all(`SELECT ${userCols()} FROM users ORDER BY name`);
  const drivers = await withCarImages(users);
  const events = (await all(`${eventSelect} ORDER BY e.id DESC LIMIT 60`)).map(formatEvent);
  res.json({
    me: { ...drivers.find((d) => d.id === req.user.id), units: req.user.units },
    drivers,
    charger: await chargerState(),
    events,
    reserve_minutes: RESERVE_MINUTES,
  });
});

// A driver's profile: car, battery, what they're doing at the charger now,
// charging stats and recent history. Email is never exposed.
app.get('/api/users/:id/profile', auth, async (req, res) => {
  const id = Number(req.params.id) || 0;
  const user = await one(`SELECT ${userCols()} FROM users WHERE id = $1`, [id]);
  if (!user) throw new HttpError(404, 'Driver not found');
  const [driver] = await withCarImages([user]);

  const sessions = await all(
    `SELECT started_at, expected_end, ended_at, start_level, end_level FROM charge_sessions
     WHERE user_id = $1 ORDER BY started_at DESC LIMIT 2000`,
    [id]
  );
  const now = Date.now();
  const monthAgo = now - 30 * 24 * 3600_000;
  const duration = (c) => (c.ended_at ? Date.parse(c.ended_at) : now) - Date.parse(c.started_at);
  const finished = sessions.filter((c) => c.ended_at);
  const onTime = finished.filter((c) => Date.parse(c.ended_at) <= Date.parse(c.expected_end) + 10 * 60_000);
  const recent = sessions.filter((c) => Date.parse(c.started_at) >= monthAgo);
  const totalMs = sessions.reduce((sum, c) => sum + duration(c), 0);
  const stats = {
    sessions: sessions.length,
    hours: Math.round((totalMs / 3600_000) * 10) / 10,
    avg_minutes: sessions.length ? Math.round(totalMs / sessions.length / 60_000) : null,
    on_time_pct: finished.length ? Math.round((onTime.length / finished.length) * 100) : null,
    sessions_30d: recent.length,
    hours_30d: Math.round((recent.reduce((sum, c) => sum + duration(c), 0) / 3600_000) * 10) / 10,
    last_charged: sessions[0]?.started_at ?? null,
  };

  const charger = await chargerState();
  const queueIndex = charger.queue.findIndex((q) => q.user_id === id);
  const status =
    charger.active?.user_id === id
      ? { state: 'charging', started_at: charger.active.started_at, expected_end: charger.active.expected_end }
      : charger.reservation?.user_id === id
        ? { state: 'reserved', until: charger.reservation.until }
        : queueIndex >= 0
          ? { state: 'queued', position: queueIndex + 1, note: charger.queue[queueIndex].note, joined_at: charger.queue[queueIndex].joined_at }
          : { state: 'idle' };

  const events = (
    await all(`${eventSelect} WHERE e.user_id = $1 OR e.target_user_id = $1 ORDER BY e.id DESC LIMIT 15`, [id])
  ).map(formatEvent);

  res.json({
    driver: { ...driver, member_since: user.created_at },
    status,
    stats,
    sessions: sessions.slice(0, 10).map((c) => ({ ...c, on_time: c.ended_at ? Date.parse(c.ended_at) <= Date.parse(c.expected_end) + 10 * 60_000 : null })),
    events,
  });
});

app.put('/api/me', auth, async (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const charge = num(b.charge_level, 'Charge level', 0, 100, u.charge_level);
  const daily = num(b.daily_miles, 'Daily mileage', 0, 1000, u.daily_miles);
  const fullRange = num(b.full_range_mi, 'Full-charge range', 10, 1000, u.full_range_mi);
  const carModel = b.car_model === undefined ? u.car_model : str(b.car_model, 'Car model', 60);
  const color = carColor(b.car_color, u.car_color);
  await all(
    'UPDATE users SET charge_level = $1, daily_miles = $2, full_range_mi = $3, car_model = $4, car_color = $5, updated_at = $6 WHERE id = $7',
    [charge, daily, fullRange, carModel, color, nowIso(), u.id]
  );
  await logEvent('status', u.id, { charge_level: charge, daily_miles: daily });
  if (carModel !== u.car_model) prefetchCarImage(carModel);
  res.json({ ok: true });
});

// Photos are resized in the browser to a small JPEG before upload.
const MAX_PHOTO_BYTES = 60 * 1024;
app.put(PHOTO_PATH, express.json({ limit: '120kb' }), auth, async (req, res) => {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(req.body?.photo || '');
  const bytes = match && Buffer.from(match[1], 'base64');
  if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new HttpError(400, 'Upload a JPEG image');
  if (bytes.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is too large');
  await all('UPDATE users SET car_photo = $1, car_photo_at = $2 WHERE id = $3', [match[1], nowIso(), req.user.id]);
  await logEvent('photo', req.user.id, { car_model: req.user.car_model });
  res.json({ ok: true });
});

app.delete(PHOTO_PATH, auth, async (req, res) => {
  await all('UPDATE users SET car_photo = NULL, car_photo_at = NULL WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
});

app.get('/api/users/:id/photo', auth, async (req, res) => {
  const row = await one('SELECT car_photo FROM users WHERE id = $1', [Number(req.params.id) || 0]);
  if (!row?.car_photo) throw new HttpError(404, 'No photo');
  // URLs carry ?v=<upload time>, so a new upload gets a new URL.
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.send(Buffer.from(row.car_photo, 'base64'));
});

app.put('/api/me/preferences', auth, async (req, res) => {
  const unitPref = units(req.body?.units, req.user.units);
  await all('UPDATE users SET units = $1 WHERE id = $2', [unitPref, req.user.id]);
  res.json({ ok: true, units: unitPref });
});

app.post('/api/broadcast', auth, async (req, res) => {
  const message = str(req.body?.message, 'Message', 280);
  await logEvent('message', req.user.id, { message });
  res.json({ ok: true });
});

// ---------- routes: the shared charger ----------

app.post('/api/charger/start', auth, serialized(async (req, res) => {
  const expectedEnd = futureTime(req.body?.expected_end);
  const me = req.user;
  if (await activeSession()) throw new HttpError(409, 'The charger is already in use');
  const { reservation } = await chargerState();
  if (reservation && reservation.user_id !== me.id) {
    throw new HttpError(409, `The charger is reserved for ${reservation.name} (next in the queue) for a few more minutes`);
  }
  await all('INSERT INTO charge_sessions(user_id, started_at, expected_end, start_level) VALUES ($1, $2, $3, $4)', [
    me.id,
    nowIso(),
    expectedEnd,
    me.charge_level,
  ]);
  await all('DELETE FROM queue WHERE user_id = $1', [me.id]);
  await logEvent('start', me.id, { expected_end: expectedEnd, charge_level: me.charge_level });
  await refreshReservation();
  res.json(await chargerState());
}));

app.post('/api/charger/update', auth, serialized(async (req, res) => {
  const expectedEnd = futureTime(req.body?.expected_end);
  const active = await activeSession();
  if (!active || active.user_id !== req.user.id) throw new HttpError(403, "You're not the one charging right now");
  await all('UPDATE charge_sessions SET expected_end = $1, overdue_notified = FALSE WHERE id = $2', [expectedEnd, active.id]);
  await logEvent('extend', req.user.id, { expected_end: expectedEnd });
  res.json(await chargerState());
}));

app.post('/api/charger/end', auth, serialized(async (req, res) => {
  const active = await activeSession();
  if (!active || active.user_id !== req.user.id) throw new HttpError(403, "You're not the one charging right now");
  const endLevel = num(req.body?.end_level, 'Charge level', 0, 100, null);
  const now = nowIso();
  await all('UPDATE charge_sessions SET ended_at = $1, end_level = $2 WHERE id = $3', [now, endLevel, active.id]);
  if (endLevel !== null) {
    await all('UPDATE users SET charge_level = $1, updated_at = $2 WHERE id = $3', [endLevel, now, req.user.id]);
  }
  const minutes = Math.round((Date.parse(now) - Date.parse(active.started_at)) / 60_000);
  await logEvent('end', req.user.id, { minutes, end_level: endLevel });
  await refreshReservation();
  res.json(await chargerState());
}));

app.post('/api/queue/join', auth, serialized(async (req, res) => {
  const note = str(req.body?.note, 'Note', 140, { optional: true });
  if ((await activeSession())?.user_id === req.user.id) throw new HttpError(409, "You're already charging");
  const joined = await one(
    'INSERT INTO queue(user_id, joined_at, note) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING RETURNING user_id',
    [req.user.id, nowIso(), note]
  );
  if (!joined) throw new HttpError(409, "You're already in the queue");
  await logEvent('queue_join', req.user.id, { note });
  await refreshReservation();
  res.json(await chargerState());
}));

app.post('/api/queue/leave', auth, serialized(async (req, res) => {
  const left = await one('DELETE FROM queue WHERE user_id = $1 RETURNING user_id', [req.user.id]);
  if (!left) throw new HttpError(409, "You're not in the queue");
  await logEvent('queue_leave', req.user.id);
  await refreshReservation();
  res.json(await chargerState());
}));

// Charging history for the usage view; aggregation happens client-side so
// days and hours are bucketed in the viewer's local time zone.
app.get('/api/sessions', auth, async (req, res) => {
  const days = num(req.query.days, 'Days', 1, 365, 30);
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const rows = await all(
    `SELECT c.id, c.user_id, u.name, c.started_at, c.expected_end, c.ended_at, c.start_level, c.end_level
     FROM charge_sessions c JOIN users u ON u.id = c.user_id
     WHERE COALESCE(c.ended_at, '9999') >= $1 ORDER BY c.started_at`,
    [since]
  );
  res.json({ since, sessions: rows });
});

app.get('/api/stream', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
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

setInterval(async () => {
  try {
    // Nudge the driver (and everyone waiting) when the promised end time passes.
    // One conditional update, so an end or extend racing this can't be clobbered.
    const overdue = await one(
      `UPDATE charge_sessions SET overdue_notified = TRUE
       WHERE ended_at IS NULL AND NOT overdue_notified AND expected_end < $1
       RETURNING user_id, expected_end`,
      [nowIso()]
    );
    if (overdue) await logEvent('overdue', null, { expected_end: overdue.expected_end }, overdue.user_id);

    // If the head of the queue let their hold lapse, drop them so the charger
    // passes to the next driver instead of sitting idle.
    await withChargerLock(async () => {
      const reservedFor = Number(await getMeta('reserved_for'));
      const reservedUntil = await getMeta('reserved_until');
      if (!reservedFor || !reservedUntil || reservedUntil >= nowIso() || (await activeSession())) return;
      const [head] = await queueRows();
      if (head?.user_id !== reservedFor) return;
      await all('DELETE FROM queue WHERE user_id = $1', [reservedFor]);
      await logEvent('queue_skipped', null, { until: reservedUntil }, reservedFor);
      await refreshReservation();
    });
    await all('DELETE FROM sessions WHERE expires_at < $1', [nowIso()]);
    rateLimits.forEach((limit) => limit.prune());
  } catch (err) {
    console.error('Background job failed', err);
  }
}, 30_000);

app.listen(PORT, () => {
  console.log(`EV Charge Circle running at http://localhost:${PORT}`);
});

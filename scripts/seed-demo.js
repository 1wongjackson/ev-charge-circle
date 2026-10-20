// Seeds demo drivers, three weeks of charging history, a live charging
// session, a queue and some feed activity to showcase the app.
//
//   npm run seed:demo            add the demo data
//   npm run seed:demo -- --reset remove all demo data (and re-add it)
//   npm run seed:demo -- --remove remove all demo data only
//
// Uses DATABASE_URL when set, otherwise the local embedded database in
// data/pglite. Adding demo drivers to a DATABASE_URL database also needs
// --production, since anyone with the password can log in as them.
//
// All demo drivers use @example.com emails and share one password: a fresh
// random one each run (printed at the end), or DEMO_PASSWORD if set.

import crypto from 'node:crypto';
import { hashPassword } from '../passwords.js';

const args = process.argv.slice(2);
if (process.env.DATABASE_URL && !args.includes('--remove') && !args.includes('--production')) {
  console.error('Refusing to add demo drivers to DATABASE_URL without --production: anyone with the password could log in as them.');
  process.exit(1);
}
// Imported after the check above, since connecting to the database happens on import.
const { all, one } = await import('../db.js');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || crypto.randomBytes(12).toString('base64url');

const DEMO_EMAIL = '%@example.com';

const DRIVERS = [
  { name: 'Priya Shah', email: 'priya@example.com', color: '#2f5fb3', car: 'Hyundai Ioniq 5', range: 266, charge: 18, daily: 42, units: 'imperial' },
  { name: 'Marcus Lee', email: 'marcus@example.com', color: '#f4f5f2', car: 'Tesla Model 3', range: 272, charge: 64, daily: 28, units: 'imperial' },
  { name: 'Sofia Romero', email: 'sofia@example.com', color: '#c0392b', car: 'Kia EV6', range: 310, charge: 35, daily: 34, units: 'metric' },
  { name: 'Daniel Okafor', email: 'daniel@example.com', color: '#c3c8cc', car: 'Nissan Leaf', range: 149, charge: 22, daily: 35, units: 'imperial' },
  { name: 'Hannah Weber', email: 'hannah@example.com', color: '#1f2224', car: 'VW ID.4', range: 275, charge: 81, daily: 20, units: 'metric' },
  { name: 'Tom Nguyen', email: 'tom@example.com', color: '#e07a2e', car: 'Chevrolet Bolt EUV', range: 247, charge: 47, daily: 38, units: 'imperial' },
];

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// Deterministic pseudo-random numbers so every run produces the same story.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

async function removeDemo() {
  const ids = (await all('SELECT id FROM users WHERE email LIKE $1', [DEMO_EMAIL])).map((r) => r.id);
  if (!ids.length) return 0;
  await all('DELETE FROM events WHERE user_id = ANY($1) OR target_user_id = ANY($1)', [ids]);
  await all('DELETE FROM users WHERE id = ANY($1)', [ids]); // cascades sessions, charging history, queue
  await all("DELETE FROM meta WHERE key IN ('reserved_for', 'reserved_until') AND (SELECT value FROM meta WHERE key = 'reserved_for')::int = ANY($1)", [ids]);
  return ids.length;
}

async function event(type, userId, data, at, targetId = null) {
  await all('INSERT INTO events(type, user_id, target_user_id, data, created_at) VALUES ($1, $2, $3, $4, $5)', [
    type, userId, targetId, JSON.stringify(data), iso(at),
  ]);
}

async function addDemo() {
  const existing = await one('SELECT COUNT(*)::int AS n FROM users WHERE email LIKE $1', [DEMO_EMAIL]);
  if (existing.n) {
    console.log(`Demo data already present (${existing.n} drivers). Use --reset to recreate it.`);
    return;
  }

  // --- drivers (joined three weeks ago, statuses updated at various times today)
  const hash = await hashPassword(DEMO_PASSWORD);
  const joined = now - 21 * 24 * 60 * MIN;
  const id = {};
  for (const [i, d] of DRIVERS.entries()) {
    const row = await one(
      `INSERT INTO users(name, email, password_hash, car_model, full_range_mi, charge_level, daily_miles, units, car_color, updated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [d.name, d.email, hash, d.car, d.range, d.charge, d.daily, d.units, d.color, iso(now - (15 + i * 40) * MIN), iso(joined + i * 90 * MIN)]
    );
    id[d.name.split(' ')[0]] = row.id;
    await event('registered', row.id, { car_model: d.car }, joined + i * 90 * MIN);
  }
  const everyone = Object.values(id);

  // --- three weeks of weekday charging history, 3-4 sessions a day in office hours
  let sessions = 0;
  for (let day = 21; day >= 1; day--) {
    const date = new Date(now - day * 24 * 60 * MIN);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    date.setHours(8, Math.floor(rand() * 40), 0, 0);
    let t = date.getTime();
    const count = 3 + Math.floor(rand() * 2);
    for (let s = 0; s < count && new Date(t).getHours() < 17; s++) {
      const userId = pick(everyone);
      const planned = (60 + Math.floor(rand() * 7) * 15) * MIN; // 1h - 2h30
      const drift = rand() < 0.25 ? (10 + rand() * 35) * MIN : -rand() * 15 * MIN; // ~1 in 4 overstay
      const end = t + planned + drift;
      const startLevel = 15 + Math.floor(rand() * 35);
      await all(
        `INSERT INTO charge_sessions(user_id, started_at, expected_end, ended_at, start_level, end_level, overdue_notified)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, iso(t), iso(t + planned), iso(end), startLevel, Math.min(100, startLevel + 30 + Math.floor(rand() * 25)), drift > 0]
      );
      sessions++;
      t = end + (5 + rand() * 40) * MIN; // hand-over gap
    }
  }

  // --- today: Hannah charged earlier and unplugged 20 min early, handing over to
  // Marcus, who is charging now
  const today = now - 205 * MIN;
  const hannahDue = now - 35 * MIN;
  await all(
    `INSERT INTO charge_sessions(user_id, started_at, expected_end, ended_at, start_level, end_level)
     VALUES ($1, $2, $3, $4, 42, 81)`,
    [id.Hannah, iso(today), iso(hannahDue), iso(now - 55 * MIN)]
  );
  await event('start', id.Hannah, { expected_end: iso(hannahDue), charge_level: 42 }, today);
  await event('message', id.Tom, { message: 'Anyone know if the charger is free later today?' }, today + 25 * MIN);
  await event('queue_join', id.Marcus, { note: 'need ~2h before a client visit' }, today + 60 * MIN);
  await event('message', id.Hannah, { message: "Heading out soon, I'll unplug 20 min early so Marcus can get going 🙂" }, now - 95 * MIN);
  await event('end', id.Hannah, { minutes: Math.round((now - 55 * MIN - today) / MIN), end_level: 81 }, now - 55 * MIN);
  await event('your_turn', null, { until: iso(now - 40 * MIN) }, now - 55 * MIN, id.Marcus);

  const active = await one('SELECT 1 FROM charge_sessions WHERE ended_at IS NULL');
  if (active) {
    console.log('Someone is already charging - skipped the live demo session and queue.');
  } else {
    await all(
      `INSERT INTO charge_sessions(user_id, started_at, expected_end, start_level) VALUES ($1, $2, $3, 41)`,
      [id.Marcus, iso(now - 50 * MIN), iso(now + 70 * MIN)]
    );
    await event('start', id.Marcus, { expected_end: iso(now + 70 * MIN), charge_level: 41 }, now - 50 * MIN);
    await all('INSERT INTO queue(user_id, joined_at, note) VALUES ($1, $2, $3), ($4, $5, $6)', [
      id.Priya, iso(now - 35 * MIN), 'at 18%, long drive tonight',
      id.Daniel, iso(now - 12 * MIN), 'need ~1.5h, flexible',
    ]);
    await event('queue_join', id.Priya, { note: 'at 18%, long drive tonight' }, now - 35 * MIN);
    await event('status', id.Sofia, { charge_level: 35, daily_miles: 34 }, now - 20 * MIN);
    await event('queue_join', id.Daniel, { note: 'need ~1.5h, flexible' }, now - 12 * MIN);
    await event('message', id.Marcus, { message: "Thanks Hannah! I'll be done in a bit over an hour. Priya, you're up next" }, now - 8 * MIN);
  }

  console.log(`Added ${DRIVERS.length} demo drivers and ${sessions + 1} past charging sessions.`);
  console.log(`Log in as any of: ${DRIVERS.map((d) => d.email).join(', ')}`);
  console.log(`Password: ${DEMO_PASSWORD}`);
}

if (args.includes('--remove') || args.includes('--reset')) {
  console.log(`Removed ${await removeDemo()} demo drivers and their data.`);
}
if (!args.includes('--remove')) await addDemo();
process.exit(0);

# EV Charge Circle

A small web app for office EV drivers who share one charger.

- **Accounts**: register and log in with email and password. Passwords are hashed with scrypt, and sessions use an HttpOnly cookie. Logins and sign-ups are rate-limited per IP (and logins per account).
- **Driver dashboard**: every driver's charge %, estimated range, miles per day and days of range left. Drivers who will run out soonest are listed first.
- **Driver profiles**: click any car photo or name (driver cards, queue, charger, feed) to open that driver's profile: a large car photo with credit, their battery and range, whether they are charging or queued right now, 30-day and all-time charging stats, recent sessions (with on-time or overstayed), and recent activity. Profiles have their own link (`#/driver/<id>`), and emails are never shown.
- **My car**: update your charge level, daily mileage, full-charge range and car model.
- **Car thumbnails**: each driver's card shows a real photo of their declared car model. The app looks it up on Wikipedia/Wikimedia Commons and saves the result per model in the database, crediting each photo's author and licence (hover or tap to see them). Drivers can upload a photo of their own car instead. If no photo is found, the app shows a drawing of the car (sedan, SUV, hatchback or pickup, guessed from the model name) in a colour the driver picks.
- **Miles or kilometres**: each driver picks their units (mi/km switch in the header, or at sign-up). The choice is saved to their account. Distances are stored in miles and converted for display.
- **Shared charger**:
  - Plug in and broadcast when you expect to finish (30m–4h, or "done by" a time).
  - Others join a queue. When you release the charger, it is passed to the next driver and held for them for 15 minutes.
  - The driver at the head of the queue gets an in-app alert, plus a browser notification if they enabled alerts.
  - The current driver is alerted when their promised finish time passes.
- **Community feed**: a live feed of all activity, plus free-text broadcasts. It updates instantly over Server-Sent Events.
- **Charger usage**: sessions, hours, average session length, how busy the charger is during office hours (Mon–Fri 8am–6pm), and the on-time finish rate. Also shows charts of hours per day and the busiest hours, and a per-driver breakdown with overstays.

## Run locally

Requires Node.js 20 or newer. You don't need a database server: without `DATABASE_URL`, the app uses PGlite (an embedded Postgres) stored in `data/pglite`.

```bash
npm install
npm start
```

Then open http://localhost:3000.

## Demo data

`npm run seed:demo` adds six demo drivers (`@example.com` emails) to the local database. It also adds three weeks of charging history, a driver charging right now, two drivers in the queue, and feed activity. The demo drivers use a mix of miles and kilometres. They share one password, which is random on each run and printed at the end (set `DEMO_PASSWORD` to choose it).

- `npm run seed:demo -- --reset` removes the demo data and re-adds it fresh (e.g. to refresh "today"). This also gives the drivers a new password.
- `npm run seed:demo -- --remove` removes all demo drivers and their data, and leaves real users untouched.

**Don't seed a real deployment.** Anyone who has the password could log in as a demo driver, post broadcasts, take queue spots and read history. When `DATABASE_URL` is set, the script refuses to add demo data unless you pass `--production`. If the live database was seeded with an older version (which used a password published in this repo), remove the demo drivers:

```bash
DATABASE_URL="postgresql://..." npm run seed:demo -- --remove
```

## Deploy (Render free + Neon free Postgres)

1. **Database:** create a free project at https://neon.tech and copy its connection string (`postgresql://…?sslmode=require`).
2. **App:** in https://dashboard.render.com, choose **New → Blueprint** and connect this GitHub repo. Render reads `render.yaml`.
3. When asked for `DATABASE_URL`, paste the Neon connection string, then click **Apply**. Tables are created automatically on first start.
4. Share the `https://<name>.onrender.com` URL with your colleagues.

The free Render plan sleeps after about 15 minutes without traffic. The first visit afterwards takes roughly 30 seconds, and overdue reminders aren't sent while the app is asleep. Data lives in Neon, so nothing is lost.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | — | Postgres connection string (production) |
| `PGLITE_DIR` | `data/pglite` | Local embedded database folder, used when `DATABASE_URL` is unset |
| `RESERVE_MINUTES` | `15` | How long the charger is held for the next driver in the queue |
| `NODE_ENV` | — | Set to `production` to mark cookies `Secure` (requires HTTPS) |

## Structure

- `server.js`: Express API, auth, charger/queue rules, live event stream, overdue checker
- `db.js`: Postgres connection (or embedded PGlite locally) and schema
- `carPhotos.js`: finds and caches a Wikimedia Commons photo per car model
- `render.yaml`: Render deployment blueprint
- `public/`: the single-page frontend (plain HTML/CSS/JS)

## API

`POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/state`, `PUT /api/me`,
`POST /api/charger/start|update|end`, `POST /api/queue/join|leave`, `POST /api/broadcast`,
`GET /api/sessions?days=30`, `GET /api/stream` (SSE).

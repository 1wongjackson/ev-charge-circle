# EV Charge Circle

A small web app for office EV drivers who share the office chargers.

- **Accounts**: register and log in with email and password. Passwords are hashed with scrypt, and sessions use an HttpOnly cookie. Logins and sign-ups are rate-limited per IP (and logins per account). Set `ALLOWED_EMAIL_DOMAINS` and/or `SIGNUP_CODE` so only colleagues can sign up. Drivers can delete their account and all their data under **My car**.
- **Driver dashboard**: every driver's charge %, estimated range, miles per day and days of range left. Drivers who will run out soonest are listed first.
- **Driver profiles**: click any car photo or name (driver cards, queue, charger, feed) to open that driver's profile: a large car photo with credit, their battery and range, whether they are charging or queued right now, 30-day and all-time charging stats, recent sessions (with on-time or overstayed), and recent activity. Profiles have their own link (`#/driver/<id>`), and emails are never shown.
- **My car**: update your charge level, daily mileage, full-charge range and car model.
- **Car thumbnails**: each driver's card shows a real photo of their declared car model. The app looks it up on Wikipedia/Wikimedia Commons and saves the result per model in the database, crediting each photo's author and licence (hover or tap to see them). Drivers can upload a photo of their own car instead. If no photo is found, the app shows a drawing of the car (sedan, SUV, hatchback or pickup, guessed from the model name) in a colour the driver picks.
- **Miles or kilometres**: each driver picks their units (mi/km switch in the header, or at sign-up). The choice is saved to their account. Distances are stored in miles and converted for display.
- **Admin site settings**: admins (listed in `ADMIN_EMAILS`) log in with their normal account and get a **Charging site** panel. There they name the place hosting the chargers (e.g. "Acme HQ car park") and set how many chargers it has (1–50). A charger someone is plugged into can't be removed until it's free. Changes are posted to the feed.
- **Shared chargers**:
  - Plug in and broadcast when you expect to finish (30m–4h, or "done by" a time). With several chargers, pick the one you plugged into.
  - Once every charger is busy, others join one queue. When a charger frees up, it is held for the next driver in the queue for 15 minutes. With two chargers free, the first two in the queue each get a hold.
  - Drivers who get a hold get an in-app alert, plus a browser notification if they enabled alerts.
  - A driver is alerted when their promised finish time passes. If they're still on the charger 10 minutes later (`AUTO_RELEASE_MINUTES`), they are released automatically and the charger passes to the queue.
- **Community feed**: a live feed of all activity, plus free-text broadcasts. It updates instantly over Server-Sent Events.
- **Charger usage**: sessions, hours, average session length, how busy the chargers are during office hours (Mon–Fri 8am–6pm), and the on-time finish rate. Also shows charts of hours per day and the busiest hours, and a per-driver breakdown with overstays. Covers up to 90 days; sessions older than 14 days are sent without driver names, so the history can't be used to track when someone is in the office.

## Run locally

Requires Node.js 20 or newer. You don't need a database server: without `DATABASE_URL`, the app uses PGlite (an embedded Postgres) stored in `data/pglite`.

```bash
npm install
npm start
```

Then open http://localhost:3000.

### Lint and format

```bash
npm run lint     # ESLint
npm run format   # Prettier: rewrite JS, JSON, YAML and Markdown
npm run check    # both, without changing files (what CI runs on every push and pull request)
```

CSS and HTML are formatted by hand and skipped by Prettier.

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
3. When asked for `DATABASE_URL`, paste the Neon connection string. Also set `ALLOWED_EMAIL_DOMAINS` (e.g. `yourcompany.com`) and/or `SIGNUP_CODE`, otherwise anyone who finds the URL can sign up and see when colleagues charge. Then click **Apply**. Tables are created automatically on first start.
4. Share the `https://<name>.onrender.com` URL with your colleagues.

The free Render plan sleeps after about 15 minutes without traffic. The first visit afterwards takes roughly 30 seconds, and overdue reminders aren't sent while the app is asleep. Data lives in Neon, so nothing is lost.

### Configuration (environment variables)

| Variable                | Default       | Meaning                                                                                          |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `PORT`                  | `3000`        | HTTP port                                                                                        |
| `DATABASE_URL`          | —             | Postgres connection string (production)                                                          |
| `PGLITE_DIR`            | `data/pglite` | Local embedded database folder, used when `DATABASE_URL` is unset                                |
| `RESERVE_MINUTES`       | `15`          | How long a free charger is held for the next driver in the queue                                 |
| `AUTO_RELEASE_MINUTES`  | `10`          | Release a driver from the charger this long after their finish time passes (`0` = right away)    |
| `ADMIN_EMAILS`          | —             | Comma-separated emails of admins, who can set the site name and number of chargers               |
| `NODE_ENV`              | —             | Set to `production` to mark cookies `Secure` (requires HTTPS)                                    |
| `ALLOWED_EMAIL_DOMAINS` | —             | Comma-separated email domains allowed to sign up, e.g. `acme.com,acme.co.uk`. Unset = any domain |
| `SIGNUP_CODE`           | —             | Invite code required to sign up. Unset = no code                                                 |

## Structure

- `server.js`: Express API, auth, charger/queue rules, live event stream, overdue checker
- `db.js`: Postgres connection (or embedded PGlite locally) and schema
- `carPhotos.js`: finds and caches a Wikimedia Commons photo per car model
- `render.yaml`: Render deployment blueprint
- `public/`: the single-page frontend (plain HTML/CSS/JS)

## API

`GET /api/signup-info`, `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/state`, `PUT /api/me`, `DELETE /api/me`,
`POST /api/charger/start|update|end`, `POST /api/queue/join|leave`, `POST /api/broadcast`, `PUT /api/admin/site` (admins),
`GET /api/sessions?days=30`, `GET /api/stream` (SSE).

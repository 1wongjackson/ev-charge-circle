# EV Charge Circle

A small web app for office EV drivers who share one charger.

- **Accounts**: register and log in with email and password. Passwords are hashed with scrypt, and sessions use an HttpOnly cookie.
- **Driver dashboard**: every driver's charge %, estimated range, miles per day and days of range left. Drivers who will run out soonest are listed first.
- **My car**: update your charge level, daily mileage, full-charge range and car model.
- **Shared charger**:
  - Plug in and broadcast when you expect to finish (30m–4h, or "done by" a time).
  - Others join a queue. When you release the charger, it is passed to the next driver and held for them for 15 minutes.
  - The driver at the head of the queue gets an in-app alert, plus a browser notification if they enabled alerts.
  - The current driver is alerted when their promised finish time passes.
- **Community feed**: a live feed of all activity, plus free-text broadcasts. It updates instantly over Server-Sent Events.
- **Charger usage**: sessions, hours, average session length, how busy the charger is during office hours (Mon–Fri 8am–6pm), and the on-time finish rate. Also shows charts of hours per day and the busiest hours, and a per-driver breakdown with overstays.

## Run

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`, so there are no native modules to compile).

```bash
npm install
npm start
```

Then open http://localhost:3000.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/evcircle.db` | SQLite database file |
| `RESERVE_MINUTES` | `15` | How long the charger is held for the next driver in the queue |
| `NODE_ENV` | — | Set to `production` to mark cookies `Secure` (requires HTTPS) |

## Structure

- `server.js`: Express API, auth, charger/queue rules, live event stream, overdue checker
- `db.js`: SQLite schema
- `public/`: the single-page frontend (plain HTML/CSS/JS)

## API

`POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/state`, `PUT /api/me`,
`POST /api/charger/start|update|end`, `POST /api/queue/join|leave`, `POST /api/broadcast`,
`GET /api/sessions?days=30`, `GET /api/stream` (SSE).

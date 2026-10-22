'use strict';
/* global CAR_COLORS, carThumb, defaultCarColor, resizeCarPhoto -- from cars.js, loaded first */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = null; // latest /api/state payload
let stream = null;
let statusDirty = false;
let usageDays = 30;
let profileId = null; // driver whose profile is open
let retryTimer; // pending live-feed reconnect
let retryDelay = 2000;

// ---------- units ----------
// Distances are stored in miles; 'metric' only changes what's shown and typed.

const KM_PER_MI = 1.609344;
const IMPERIAL_REGIONS = ['US', 'GB', 'LR', 'MM'];
let units = guessUnits();

function guessUnits() {
  try {
    const saved = localStorage.getItem('units');
    if (saved === 'imperial' || saved === 'metric') return saved;
  } catch {
    // storage blocked (e.g. private mode): fall back to the locale
  }
  const region = (navigator.language || '').split('-')[1]?.toUpperCase();
  return IMPERIAL_REGIONS.includes(region) ? 'imperial' : 'metric';
}

const distUnit = () => (units === 'metric' ? 'km' : 'mi');
/** Miles -> number shown in the current units. */
const showDist = (mi) => Math.round(units === 'metric' ? mi * KM_PER_MI : mi);
/** Typed value in the current units -> miles for the API. */
const inputToMiles = (v) => (v === '' || v == null ? v : units === 'metric' ? Number(v) / KM_PER_MI : Number(v));

function applyUnits() {
  try {
    localStorage.setItem('units', units);
  } catch {
    // storage blocked: the choice still lasts for this page
  }
  $$('.u-dist').forEach((el) => (el.textContent = distUnit()));
  $$('[data-units], [data-reg-units]').forEach((b) => setPressed(b, (b.dataset.units || b.dataset.regUnits) === units));
  // Server limits are 1000 mi; keep the input limits equivalent.
  const max = units === 'metric' ? 1600 : 1000;
  $$('input[name="full_range_mi"], input[name="daily_miles"]').forEach((i) => (i.max = max));
}

function convertDistInputs(form, from, to) {
  if (from === to) return;
  const factor = to === 'metric' ? KM_PER_MI : 1 / KM_PER_MI;
  for (const name of ['full_range_mi', 'daily_miles']) {
    const input = form[name];
    if (input.value !== '') input.value = Math.round(Number(input.value) * factor);
  }
}

// ---------- utilities ----------

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/login')) showAuth();
    throw new Error(data.error || 'Something went wrong');
  }
  return data;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

function fmtDuration(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function ago(iso) {
  const min = (Date.now() - Date.parse(iso)) / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

/** Whether a charging session is still on time or past its promised end. */
const sessionMode = (s) => (Date.parse(s.expected_end) < Date.now() ? 'late' : 'busy');

/** " at Charger 2", or nothing when there's only one charger. */
const atCharger = (no) => (no && state?.charger.chargers.length > 1 ? ` at Charger ${no}` : '');

/** Mark a toggle button as on/off, for both the styling and screen readers. */
function setPressed(btn, on) {
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on);
}

/** Mark a tab as the selected one in its tablist. */
function selectTab(tab, on) {
  tab.classList.toggle('active', on);
  tab.setAttribute('aria-selected', on);
  tab.tabIndex = on ? 0 : -1;
}

// Arrow keys move between tabs, as in any tablist.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tab = e.target.closest?.('[role="tab"]');
  if (!tab) return;
  const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
  const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  next.focus();
  next.click();
});

/**
 * Show a message at the bottom of the screen. The region is aria-live, so
 * screen readers announce it. Sticky messages stay until dismissed.
 */
function toast(text, { sticky = false } = {}) {
  const el = $('#toast');
  el.innerHTML = `<div class="toast"><span>${esc(text)}</span><button type="button" class="toast-close" aria-label="Dismiss">✕</button></div>`;
  clearTimeout(toast.t);
  if (!sticky) toast.t = setTimeout(() => (el.innerHTML = ''), 6000);
}
$('#toast').addEventListener('click', (e) => {
  if (e.target.closest('.toast-close')) $('#toast').innerHTML = '';
});

/** Disable a set of buttons while fn runs, so a double-click can't send it twice. */
async function whileBusy(buttons, fn) {
  buttons.forEach((b) => (b.disabled = true));
  try {
    return await fn();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// Alerts about your turn at the charger: they matter, so they stay until dismissed.
function notify(text) {
  toast(text, { sticky: true });
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('EV Charge Circle', { body: text });
  }
}

// ---------- auth ----------

function showAuth() {
  state = null;
  stream?.close();
  stream = null;
  clearTimeout(retryTimer);
  setOffline(false);
  $('#auth-view').hidden = false;
  $('#app-view').hidden = true;
  $('#userbar').hidden = true;
}

function showApp() {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#userbar').hidden = false;
}

$$('[data-auth]').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('[data-auth]').forEach((b) => selectTab(b, b === btn));
    $('#login-form').hidden = btn.dataset.auth !== 'login';
    $('#register-form').hidden = btn.dataset.auth !== 'register';
    $('#auth-error').textContent = '';
  }),
);

async function submitAuth(e, url) {
  e.preventDefault();
  $('#auth-error').textContent = '';
  const body = Object.fromEntries(new FormData(e.target));
  if (url === '/api/register') {
    body.full_range_mi = inputToMiles(body.full_range_mi);
    body.daily_miles = inputToMiles(body.daily_miles);
    body.units = units;
  }
  try {
    await whileBusy([e.submitter || e.target.querySelector('[type="submit"]')], () =>
      api(url, { method: 'POST', body }),
    );
    e.target.reset();
    await boot();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
}
$$('[data-reg-units]').forEach((btn) =>
  btn.addEventListener('click', () => {
    convertDistInputs($('#register-form'), units, btn.dataset.regUnits);
    units = btn.dataset.regUnits;
    applyUnits();
  }),
);

$$('[data-units]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    if (btn.dataset.units === units) return;
    units = btn.dataset.units;
    statusDirty = false; // re-fill "My car" in the new units
    applyUnits();
    render();
    if (!$('#view-usage').hidden) loadUsage();
    await api('/api/me/preferences', { method: 'PUT', body: { units } }).catch((err) => toast(err.message));
  }),
);

// Ask for an invite code / work email only when the server requires one.
api('/api/signup-info')
  .then((info) => {
    $('#invite-field').hidden = !info.invite_code;
    $('#invite-field input').required = info.invite_code;
    $('#work-email-hint').hidden = !info.work_email;
  })
  .catch(() => {}); // the server will say what's missing on submit

$('#login-form').addEventListener('submit', (e) => submitAuth(e, '/api/login'));
$('#register-form').addEventListener('submit', (e) => submitAuth(e, '/api/register'));

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showAuth();
});

$('#notify-btn').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast("This browser doesn't support notifications");
  const p = await Notification.requestPermission();
  updateNotifyBtn();
  if (p === 'granted') toast("You'll get an alert when it's your turn at the charger");
});

function updateNotifyBtn() {
  const btn = $('#notify-btn');
  btn.hidden = !('Notification' in window) || Notification.permission !== 'default';
}

// ---------- data loading ----------

async function boot() {
  try {
    state = await api('/api/state');
  } catch {
    return showAuth();
  }
  units = state.me.units;
  applyUnits();
  showApp();
  updateNotifyBtn();
  render();
  route(); // open a driver profile if the URL points at one
  connectStream();
}

// Shown whenever the live feed or a refresh fails, so nobody acts on stale data.
function setOffline(offline) {
  $('#conn-banner').hidden = !offline;
}

async function reload() {
  try {
    state = await api('/api/state');
  } catch {
    // A 401 already sent us back to the login screen; anything else means we're out of date.
    if (state) setOffline(true);
    return;
  }
  if (stream?.readyState === EventSource.OPEN) setOffline(false);
  render();
  if (!$('#view-usage').hidden) loadUsage();
  if (!$('#view-profile').hidden && profileId) loadProfile(profileId);
}

let reloadTimer;
const scheduleReload = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, 150);
};

// EventSource retries on its own after a dropped connection, but gives up for
// good on an error response (e.g. a 502 while the server restarts). Then we
// retry ourselves, backing off, via /api/state, which also catches a 401.

function retryStream() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    await reload();
    if (state) connectStream();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60_000);
}

function connectStream() {
  if (stream) return;
  stream = new EventSource('/api/stream');
  stream.onerror = () => {
    setOffline(true);
    if (stream?.readyState === EventSource.CLOSED) {
      stream = null;
      retryStream();
    }
  };
  stream.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    const me = state?.me;
    if (me && ev.target_user_id === me.id && ev.type === 'your_turn') {
      notify(`⚡ It's your turn! A charger is held for you until ${fmtTime(ev.data.until)}.`);
    } else if (me && ev.target_user_id === me.id && ev.type === 'queue_skipped') {
      notify("⌛ Your hold on the charger expired, so you've been taken out of the queue. Rejoin any time.");
    } else if (me && ev.target_user_id === me.id && ev.type === 'overdue') {
      notify(
        `⏰ Your charge time is up — please move your car or update your finish time.${
          state.auto_release_minutes
            ? ` You'll be released from the charger in ${state.auto_release_minutes} minutes.`
            : ''
        }`,
      );
    } else if (me && ev.target_user_id === me.id && ev.type === 'auto_end') {
      notify("⏏️ Your charging time ran out, so you've been released from the charger. Please move your car.");
    } else if (me && ev.user_id !== me.id && ev.type === 'message') {
      toast(`${ev.actor}: ${ev.data.message}`);
    } else if (me && ev.user_id !== me.id && ev.type === 'start') {
      toast(`${ev.actor} plugged in${atCharger(ev.data.charger)} · done ~${fmtTime(ev.data.expected_end)}`);
    }
    scheduleReload();
  };
  // Resync whenever the stream (re)connects, since events may have been missed.
  stream.onopen = () => {
    retryDelay = 2000;
    setOffline(false);
    scheduleReload();
  };
}

// ---------- rendering ----------

function render() {
  if (!state) return;
  $('#me-name').textContent = state.me.name;
  renderCharger();
  renderQueue();
  renderDrivers();
  renderStatusForm();
  renderFeed();
  renderAdmin();
}

// Overall status of the chargers: free (one is open to anyone), reserved (the
// free ones are held for the queue), busy, or late (all in use, one overdue).
function chargerMode() {
  const { chargers, reservations } = state.charger;
  const free = chargers.filter((c) => !c.session).length;
  if (free > reservations.length) return 'free';
  if (free) return 'reserved';
  return chargers.some((c) => sessionMode(c.session) === 'late') ? 'late' : 'busy';
}

function durationPicker(action, label) {
  return `
    <div class="stack">
      <div class="durations">
        <span class="muted small-text">${label}</span>
        ${[0.5, 1, 2, 3, 4].map((h) => `<button class="ghost small" data-act="${action}" data-hours="${h}" type="button">${h < 1 ? '30m' : h + 'h'}</button>`).join('')}
      </div>
      <div class="durations">
        <span class="muted small-text">or done by</span>
        <input type="time" id="${action}-time" aria-label="Done by time" />
        <button class="small" data-act="${action}" data-time="#${action}-time" type="button">Set</button>
      </div>
    </div>`;
}

/** Car thumbnail for a driver id from the current drivers list. */
function thumbFor(userId, size) {
  const d = state.drivers.find((x) => x.id === userId);
  return d ? profileLink(d, carThumb(d, size)) : '';
}

const profileHref = (id) => `#/driver/${id}`;

/** Wrap a car thumbnail so clicking it opens that driver's profile. */
function profileLink(d, html) {
  return `<a class="profile-link" href="${profileHref(d.id)}" aria-label="View ${esc(d.name)}'s profile">${html}</a>`;
}

/** A driver's name linking to their profile. */
const nameLink = (id, name) => `<a class="name-link" href="${profileHref(id)}"><strong>${esc(name)}</strong></a>`;

function renderCharger() {
  const { chargers, reservations, queue, site_name } = state.charger;
  const me = state.me;
  const many = chargers.length > 1;
  const mode = chargerMode();
  const free = chargers.filter((c) => !c.session);
  const openToAll = free.length - reservations.length;
  const mine = chargers.find((c) => c.session?.user_id === me.id);
  const myHold = reservations.find((r) => r.user_id === me.id);
  const inQueue = queue.some((q) => q.user_id === me.id);

  $('#charger-title').textContent = `${site_name} charger${many ? 's' : ''}`;
  document.title = `${site_name} · EV Charge Circle`;
  const statusText = many
    ? { free: `${openToAll} of ${chargers.length} free`, busy: 'All in use', late: 'All in use', reserved: 'Reserved' }
    : { free: 'Available', busy: 'In use', late: 'Overdue', reserved: 'Reserved' };
  $('#charger-status').className = `badge ${mode}`;
  $('#charger-status').textContent = statusText[mode];
  const pill = $('#charger-pill');
  pill.className = `pill ${mode}`;
  pill.textContent = many
    ? {
        free: `● ${openToAll} of ${chargers.length} chargers free`,
        reserved: '● Chargers held for the queue',
        busy: `● All ${chargers.length} chargers in use`,
        late: `● All ${chargers.length} chargers in use`,
      }[mode]
    : {
        free: '● Charger free',
        reserved: `● Held for ${reservations[0]?.name}`,
        busy: `● ${chargers[0].session?.name} charging`,
        late: `● ${chargers[0].session?.name} charging`,
      }[mode];

  // Holds aren't tied to a charger; show them against the free ones in order.
  const holds = new Map(free.map((c, i) => [c.no, reservations[i]]));
  $('#charger-body').innerHTML = `<div class="${many ? 'charger-slots' : ''}">${chargers
    .map((c) => chargerSlot(c, holds.get(c.no), many))
    .join('')}</div>`;

  let actions;
  const picker = chargerPicker(free, many);
  if (mine) {
    actions = `
      <div class="stack">
        <div class="inline-field">
          <label class="muted small-text" for="end-level">Charge when unplugging (%)</label>
          <input id="end-level" type="number" min="0" max="100" placeholder="e.g. 80" />
          <button data-act="end" type="button">I'm done — release charger${many ? ` ${mine.no}` : ''}</button>
        </div>
        ${durationPicker('update', 'Change finish time:')}
      </div>`;
  } else if (myHold) {
    actions = `
      <div class="stack">
        <div>
          <p class="charger-big">⚡ It's your turn!</p>
          <p class="charger-sub">${many ? 'A charger is' : 'The charger is'} held for you until <strong>${fmtTime(myHold.until)}</strong>. Plug in and let everyone know how long you'll be.</p>
        </div>
        ${picker}${durationPicker('start', 'Charging for:')}
        <div><button class="ghost small" data-act="leave" data-confirm="Give up your turn? The charger will pass to the next driver and you'll leave the queue." type="button">Skip my turn</button></div>
      </div>`;
  } else if (openToAll > 0) {
    actions = `<div class="stack">${picker}${durationPicker('start', 'Charging for:')}
      ${inQueue ? '<div><button class="ghost small" data-act="leave" type="button">Leave the queue</button></div>' : ''}</div>`;
  } else {
    actions = queueActions(inQueue);
  }

  // Don't wipe inputs the user is typing into on periodic re-renders.
  const actionsEl = $('#charger-actions');
  const key = `${mode}|${mine?.no}|${Boolean(myHold)}|${inQueue}|${free.map((c) => c.no)}`;
  if (actionsEl.dataset.key !== key || !actionsEl.contains(document.activeElement)) {
    actionsEl.innerHTML = actions;
    actionsEl.dataset.key = key;
  }
}

/** One charger: who's on it, who it's held for, or that it's free. */
function chargerSlot(c, hold, many) {
  const me = state.me;
  const s = c.session;
  const mode = s ? sessionMode(s) : hold ? 'reserved' : 'free';
  const head = many
    ? `<div class="slot-head"><strong>Charger ${c.no}</strong>
        <span class="badge ${mode}">${{ free: 'Free', reserved: 'Held', busy: 'In use', late: 'Overdue' }[mode]}</span></div>`
    : '';
  const size = many ? '' : 'lg';
  let body;
  if (s) {
    const start = Date.parse(s.started_at);
    const end = Date.parse(s.expected_end);
    const pct = Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
    const remaining = (end - Date.now()) / 60000;
    const waiting = state.charger.queue.length;
    body = `
      <div class="charger-main">
        ${thumbFor(s.user_id, size)}
        <div>
          <p class="charger-big">${s.user_id === me.id ? "You're charging" : `${esc(s.name)} is charging`}</p>
          <p class="charger-sub">${esc(s.car_model)} · plugged in at ${fmtTime(s.started_at)}
            ${s.start_level != null ? ` at ${s.start_level}%` : ''}</p>
        </div>
      </div>
      <div class="progress ${mode === 'late' ? 'late' : ''}"><span style="width:${pct}%"></span></div>
      <p class="charger-sub"><strong>Expected done ${fmtTime(s.expected_end)}</strong>
        · ${remaining >= 0 ? `${fmtDuration(remaining)} left` : `${fmtDuration(-remaining)} over`}
        ${!many && waiting ? ` · ${waiting} waiting` : ''}</p>`;
  } else if (hold) {
    const mineHold = hold.user_id === me.id;
    body = `<div class="charger-main">${thumbFor(hold.user_id, size)}<div>
        <p class="charger-big">${mineHold ? 'Held for you' : `Held for ${esc(hold.name)}`}</p>
        <p class="charger-sub">${mineHold ? 'You have' : "They're next in the queue and have"} until ${fmtTime(hold.until)} to plug in.${mineHold ? '' : ' After that, it passes to the next driver.'}</p>
      </div></div>`;
  } else {
    body = many
      ? '<p class="charger-sub">Free to use.</p>'
      : `<p class="charger-big">The charger is free</p>
         <p class="charger-sub">Plug in and broadcast when you expect to be done so the next driver can plan.</p>`;
  }
  return `<div class="${many ? 'charger-slot' : ''}">${head}${body}</div>`;
}

/** Which charger you're plugging into, when there's more than one free. */
function chargerPicker(free, many) {
  if (!many || free.length < 2) return '';
  return `<div class="inline-field">
      <label class="muted small-text" for="start-charger">Plugging into</label>
      <select id="start-charger">${free.map((c) => `<option value="${c.no}">Charger ${c.no}</option>`).join('')}</select>
    </div>`;
}

function queueActions(inQueue) {
  return inQueue
    ? `<button class="ghost" data-act="leave" type="button">Leave the queue</button>`
    : `<div class="inline-field">
         <input id="queue-note" maxlength="140" placeholder="Optional note, e.g. 'at 15%, need ~2h'" aria-label="Note for the queue (optional)" />
         <button data-act="join" type="button">Join the queue</button>
       </div>`;
}

function timeInputToIso(sel) {
  const v = $(sel)?.value;
  if (!v) return null;
  const [h, m] = v.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // earlier than now = tomorrow
  return d.toISOString();
}

$('#charger-actions').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  $('#charger-error').textContent = '';
  if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) return;
  const buttons = $$('#charger-actions button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    let expected_end;
    if (btn.dataset.hours) expected_end = new Date(Date.now() + Number(btn.dataset.hours) * 3600_000).toISOString();
    if (btn.dataset.time) {
      expected_end = timeInputToIso(btn.dataset.time);
      if (!expected_end) throw new Error('Pick a time first');
    }
    if (act === 'start') {
      await api('/api/charger/start', { method: 'POST', body: { expected_end, charger: $('#start-charger')?.value } });
    }
    if (act === 'update') await api('/api/charger/update', { method: 'POST', body: { expected_end } });
    if (act === 'end') await api('/api/charger/end', { method: 'POST', body: { end_level: $('#end-level').value } });
    if (act === 'join') await api('/api/queue/join', { method: 'POST', body: { note: $('#queue-note').value } });
    if (act === 'leave') await api('/api/queue/leave', { method: 'POST' });
    if (act === 'end') statusDirty = false; // pick up the new charge level
    $('#charger-actions').dataset.key = '';
    await reload();
  } catch (err) {
    $('#charger-error').textContent = err.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false)); // no-op if a re-render replaced them
  }
});

function renderQueue() {
  const { queue } = state.charger;
  $('#queue-count').textContent = queue.length ? `· ${queue.length} waiting` : '';
  $('#queue-list').innerHTML = queue.length
    ? queue
        .map(
          (q, i) => `
      <li>
        <span class="pos">${i + 1}</span>
        ${thumbFor(q.user_id, 'sm')}
        <div class="who">
          <strong>${esc(q.name)}</strong>${q.user_id === state.me.id ? ' (you)' : ''}
          <span class="muted small-text"> · ${q.charge_level}% · joined ${fmtTime(q.joined_at)}</span>
          ${q.note ? `<div class="note">“${esc(q.note)}”</div>` : ''}
        </div>
        ${q.reserved_until ? '<span class="badge reserved">Up now</span>' : ''}
      </li>`,
        )
        .join('')
    : '<li class="empty">Nobody waiting.</li>';
}

function renderDrivers() {
  const { chargers, queue } = state.charger;
  const charging = new Map(chargers.filter((c) => c.session).map((c) => [c.session.user_id, c.no]));
  const drivers = [...state.drivers].sort((a, b) => (a.days_of_range ?? 1e9) - (b.days_of_range ?? 1e9));
  $('#drivers').innerHTML = drivers
    .map((d) => {
      const lvl = d.charge_level;
      const cls = lvl < 25 ? 'low' : lvl < 50 ? 'mid' : '';
      const qPos = queue.findIndex((q) => q.user_id === d.id);
      const badge = charging.has(d.id)
        ? `<span class="badge busy">⚡ Charging${chargers.length > 1 ? ` · #${charging.get(d.id)}` : ''}</span>`
        : qPos >= 0
          ? `<span class="badge">Queue #${qPos + 1}</span>`
          : '';
      return `
      <div class="driver ${d.id === state.me.id ? 'me' : ''}">
        <div class="driver-head">
          ${profileLink(d, carThumb(d))}
          <div class="driver-id">
            <div class="driver-name"><a class="name-link" href="${profileHref(d.id)}">${esc(d.name)}</a>${d.id === state.me.id ? ' (you)' : ''}</div>
            <div class="driver-car">${esc(d.car_model)}</div>
          </div>
        </div>
        <div class="battery" role="img" aria-label="Battery ${lvl} percent">
          <div class="battery-shell"><div class="battery-fill ${cls}" style="width:${lvl}%"></div></div>
          <div class="battery-cap"></div>
          <span class="battery-pct">${lvl}%</span>
        </div>
        <div class="driver-stats">
          <div><strong>${showDist(d.est_range_mi)}</strong>${distUnit()} left</div>
          <div><strong>${showDist(d.daily_miles)}</strong>${distUnit()} / day</div>
          <div><strong>${d.days_of_range ?? '—'}</strong>days</div>
        </div>
        <div class="driver-foot"><span>Updated ${ago(d.updated_at)}</span>${badge}</div>
      </div>`;
    })
    .join('');
}

function renderStatusForm() {
  if (statusDirty) return;
  const f = $('#status-form');
  f.charge_level.value = state.me.charge_level;
  $('#charge-out').textContent = state.me.charge_level;
  f.daily_miles.value = showDist(state.me.daily_miles);
  f.full_range_mi.value = showDist(state.me.full_range_mi);
  f.car_model.value = state.me.car_model;
  f.car_color.value = state.me.car_color || '';
  renderMyCar();
}

// Live preview of the "My car" thumbnail from the form's current values.
function renderMyCar() {
  const f = $('#status-form');
  const me = state.me;
  const color = f.car_color.value || me.car_color || defaultCarColor(me.name);
  const model = f.car_model.value.trim() || me.car_model;
  // The stock photo belongs to the saved model; while typing a new one, show the drawing.
  const stock = model.toLowerCase() === me.car_model.trim().toLowerCase() ? me.car_image : null;
  $('#my-car-thumb').innerHTML = carThumb({ ...me, car_model: model, car_color: color, car_image: stock }, 'lg');
  $$('#color-swatches .swatch').forEach((s) => {
    s.classList.toggle('active', s.dataset.color === color);
    s.setAttribute('aria-checked', s.dataset.color === color);
  });
  // Paint colour only applies to the drawing.
  $('#color-picker').hidden = Boolean(me.photo_version || stock);
  $('#car-note').textContent = me.photo_version
    ? ''
    : stock
      ? `Stock photo of the ${stock.title} from Wikipedia. Upload your own to show your car.`
      : model !== me.car_model
        ? 'Save to look up a photo of this model.'
        : me.car_image_pending
          ? 'Looking up a photo of this model…'
          : 'No photo found for this model. Check the make and model, or upload your own.';
  $('#photo-remove').hidden = !me.photo_version;
  $('#photo-upload').textContent = me.photo_version ? 'Change photo' : 'Upload a photo';
}

$('#color-swatches').innerHTML = CAR_COLORS.map(
  (c) =>
    `<button type="button" class="swatch" role="radio" data-color="${c.hex}" style="background:${c.hex}" title="${c.name}" aria-label="${c.name}"></button>`,
).join('');

$('#color-swatches').addEventListener('click', (e) => {
  const swatch = e.target.closest('.swatch');
  if (!swatch) return;
  $('#status-form').car_color.value = swatch.dataset.color;
  statusDirty = true;
  renderMyCar();
});

$('#photo-upload').addEventListener('click', () => $('#photo-input').click());

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const msg = $('#status-msg');
  try {
    msg.textContent = 'Uploading photo…';
    const photo = await resizeCarPhoto(file);
    await api('/api/me/photo', { method: 'PUT', body: { photo } });
    msg.textContent = 'Photo saved.';
    await reload();
    renderMyCar();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#photo-remove').addEventListener('click', async () => {
  try {
    await api('/api/me/photo', { method: 'DELETE' });
    await reload();
    renderMyCar();
  } catch (err) {
    $('#status-msg').textContent = err.message;
  }
});

$('#status-form').addEventListener('input', (e) => {
  statusDirty = true;
  if (e.target.name === 'charge_level') $('#charge-out').textContent = e.target.value;
  if (e.target.name === 'car_model') renderMyCar();
});

$('#status-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#status-msg');
  try {
    const body = Object.fromEntries(new FormData(e.target));
    body.daily_miles = inputToMiles(body.daily_miles);
    body.full_range_mi = inputToMiles(body.full_range_mi);
    await whileBusy([e.target.querySelector('[type="submit"]')], () => api('/api/me', { method: 'PUT', body }));
    statusDirty = false;
    msg.textContent = 'Saved.';
    setTimeout(() => (msg.textContent = ''), 2500);
    await reload();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#delete-error').textContent = '';
  if (!confirm('Delete your account and all your data for good?')) return;
  try {
    await api('/api/me', { method: 'DELETE', body: { password: e.target.password.value } });
    e.target.reset();
    showAuth();
  } catch (err) {
    $('#delete-error').textContent = err.message;
  }
});

$('#broadcast-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await whileBusy([e.target.querySelector('button')], () =>
      api('/api/broadcast', { method: 'POST', body: { message: e.target.message.value } }),
    );
    e.target.reset();
  } catch (err) {
    toast(err.message);
  }
});

function eventText(ev) {
  const a = ev.user_id ? nameLink(ev.user_id, ev.actor) : '<strong>Someone</strong>';
  const t = ev.target_user_id ? nameLink(ev.target_user_id, ev.target) : '<strong>Someone</strong>';
  const d = ev.data || {};
  switch (ev.type) {
    case 'registered':
      return `👋 ${a} joined the community (${esc(d.car_model)})`;
    case 'status':
      return `🔋 ${a} is at ${d.charge_level}%, driving ${showDist(d.daily_miles)} ${distUnit()}/day`;
    case 'start':
      return `⚡ ${a} plugged in${atCharger(d.charger)} — expects to be done at <strong>${fmtTime(d.expected_end)}</strong>`;
    case 'extend':
      return `🕒 ${a} now expects to be done at <strong>${fmtTime(d.expected_end)}</strong>`;
    case 'end':
      return `✅ ${a} unplugged after ${fmtDuration(d.minutes)}${d.end_level != null ? ` at ${d.end_level}%` : ''} — ${d.charger && state.charger.chargers.length > 1 ? `Charger ${d.charger}` : 'charger'} is free`;
    case 'auto_end':
      return `⏏️ ${t}'s charging time ran out — released${atCharger(d.charger) ? ` from Charger ${d.charger}` : ' from the charger'} after ${fmtDuration(d.minutes)}`;
    case 'site':
      return `🛠️ ${a} set up the site: <strong>${esc(d.name)}</strong> with ${d.chargers} charger${d.chargers === 1 ? '' : 's'}`;
    case 'queue_join':
      return `🙋 ${a} joined the queue${d.note ? `: “${esc(d.note)}”` : ''}`;
    case 'queue_leave':
      return `${a} left the queue`;
    case 'your_turn':
      return `➡️ A charger is free for ${t} — held until ${fmtTime(d.until)}`;
    case 'queue_skipped':
      return `⌛ ${t}'s hold expired — removed from the queue`;
    case 'overdue':
      return `<span class="alert">⏰ ${t}'s charge${atCharger(d.charger)} was due at ${fmtTime(d.expected_end)}</span>`;
    case 'photo':
      return `📷 ${a} added a photo of their ${esc(d.car_model)}`;
    case 'message':
      return `💬 ${a}<br><span class="msg">${esc(d.message)}</span>`;
    default:
      return esc(ev.type);
  }
}

function renderFeed() {
  $('#feed').innerHTML = state.events.length
    ? state.events.map((ev) => `<li>${eventText(ev)}<time>${ago(ev.created_at)}</time></li>`).join('')
    : '<li class="empty">No activity yet.</li>';
}

// ---------- admin: site settings ----------

let siteDirty = false;

function renderAdmin() {
  $('#admin-card').hidden = !state.me.is_admin;
  if (!state.me.is_admin || siteDirty) return;
  const f = $('#site-form');
  f.site_name.value = state.charger.site_name;
  f.charger_count.value = state.charger.chargers.length;
}

$('#site-form').addEventListener('input', () => (siteDirty = true));

$('#site-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#site-msg');
  try {
    const body = Object.fromEntries(new FormData(e.target));
    await whileBusy([e.target.querySelector('[type="submit"]')], () => api('/api/admin/site', { method: 'PUT', body }));
    siteDirty = false;
    msg.textContent = 'Saved.';
    setTimeout(() => (msg.textContent = ''), 2500);
    $('#charger-actions').dataset.key = '';
    await reload();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// ---------- tabs ----------

// Views: the two tabs, plus a driver profile at #/driver/<id>.
let lastTab = 'community';

function showView(name) {
  $('#view-community').hidden = name !== 'community';
  $('#view-usage').hidden = name !== 'usage';
  $('#view-profile').hidden = name !== 'profile';
  $$('[data-view]').forEach((b) => selectTab(b, b.dataset.view === name));
  if (name === 'usage') loadUsage();
}

function route() {
  const match = /^#\/driver\/(\d+)$/.exec(location.hash);
  if (match) {
    showView('profile');
    loadProfile(Number(match[1]));
    window.scrollTo(0, 0);
  } else {
    profileId = null;
    showView(lastTab);
  }
}

window.addEventListener('hashchange', () => state && route());

$$('[data-view]').forEach((btn) =>
  btn.addEventListener('click', () => {
    lastTab = btn.dataset.view;
    if (location.hash)
      location.hash = ''; // leaving a profile; route() shows the tab
    else showView(lastTab);
  }),
);

$('.back-link').addEventListener('click', (e) => {
  e.preventDefault();
  location.hash = '';
});

// ---------- driver profile ----------

async function loadProfile(id) {
  const first = profileId !== id;
  profileId = id;
  if (first) $('#profile').innerHTML = '<article class="card"><p class="muted">Loading…</p></article>';
  try {
    const profile = await api(`/api/users/${id}/profile`);
    if (profileId === id) renderProfile(profile);
  } catch (err) {
    if (profileId === id)
      $('#profile').innerHTML = `<article class="card"><p class="error">${esc(err.message)}</p></article>`;
  }
}

function profileStatus(status) {
  switch (status.state) {
    case 'charging':
      return `<span class="badge busy">⚡ Charging now${atCharger(status.charger)}</span>
        <span class="muted small-text">since ${fmtTime(status.started_at)} · expects to be done ${fmtTime(status.expected_end)}</span>`;
    case 'reserved':
      return `<span class="badge reserved">Up next</span>
        <span class="muted small-text">a charger is held for them until ${fmtTime(status.until)}</span>`;
    case 'queued':
      return `<span class="badge">#${status.position} in the queue</span>
        <span class="muted small-text">joined ${fmtTime(status.joined_at)}${status.note ? ` · “${esc(status.note)}”` : ''}</span>`;
    default:
      return '<span class="badge">Not at the charger</span>';
  }
}

const shortTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function sessionRow(s) {
  const end = s.ended_at ? Date.parse(s.ended_at) : Date.now();
  const date = new Date(s.started_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const time = `${shortTime(s.started_at)} – ${s.ended_at ? shortTime(s.ended_at) : 'now'}`;
  const charge = s.start_level != null ? `${s.start_level}% → ${s.end_level != null ? s.end_level + '%' : '…'}` : '—';
  const done =
    s.on_time === null
      ? 'In progress'
      : s.on_time
        ? '<span class="ok">✓ On time</span>'
        : '<span class="late-text">Overstayed</span>';
  return `<tr><td>${date}</td><td>${time}</td><td class="num">${fmtDuration((end - Date.parse(s.started_at)) / 60000)}</td>
    <td>${charge}</td><td>${done}</td></tr>`;
}

function renderProfile({ driver: d, status, stats, sessions, events, named_history_days }) {
  const isMe = d.id === state.me.id;
  const lvl = d.charge_level;
  const fill = lvl < 25 ? 'low' : lvl < 50 ? 'mid' : '';
  const c = d.car_image;
  const credit = d.photo_version
    ? '<p class="credit muted small-text">Photo uploaded by the driver</p>'
    : c
      ? `<p class="credit muted small-text">${esc(c.title)} (stock photo) · <a href="${esc(c.file_url)}" target="_blank" rel="noopener">${esc(c.artist)}</a>, ${esc(c.license)}, via Wikimedia Commons</p>`
      : '';
  const tile = (k, v) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const history = sessions.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Time</th><th class="num">Duration</th><th>Charge</th><th>Finished</th></tr></thead>
        <tbody>${sessions.map(sessionRow).join('')}</tbody></table></div>`
    : '<p class="empty">No charging sessions yet.</p>';
  const activity = events.length
    ? events.map((ev) => `<li>${eventText(ev)}<time>${ago(ev.created_at)}</time></li>`).join('')
    : '<li class="empty">No activity yet.</li>';

  $('#profile').innerHTML = `
    <article class="card profile-hero">
      <div class="profile-photo">${carThumb(d, 'xl')}${credit}</div>
      <div class="profile-info">
        <h1>${esc(d.name)}${isMe ? ' <span class="badge">You</span>' : ''}</h1>
        <p class="profile-car">${esc(d.car_model)}</p>
        <p class="muted small-text">Member since ${new Date(d.member_since).toLocaleDateString([], { month: 'long', year: 'numeric' })}
          · status updated ${ago(d.updated_at)}</p>
        <div class="profile-status">${profileStatus(status)}</div>
        <div class="battery" role="img" aria-label="Battery ${lvl} percent">
          <div class="battery-shell"><div class="battery-fill ${fill}" style="width:${lvl}%"></div></div>
          <div class="battery-cap"></div>
          <span class="battery-pct">${lvl}%</span>
        </div>
        <div class="driver-stats">
          <div><strong>${showDist(d.est_range_mi)}</strong>${distUnit()} left</div>
          <div><strong>${showDist(d.daily_miles)}</strong>${distUnit()} / day</div>
          <div><strong>${d.days_of_range ?? '—'}</strong>days of range</div>
          <div><strong>${showDist(d.full_range_mi)}</strong>${distUnit()} full range</div>
        </div>
        ${isMe ? '<p class="muted small-text">Update your car, charge level and photo under <strong>My car</strong> on the Community tab.</p>' : ''}
      </div>
    </article>
    <div class="tiles">
      ${tile('Sessions (30 days)', stats.sessions_30d)}
      ${tile('Hours charged (30 days)', stats.hours_30d.toFixed(1))}
      ${tile('Average session', stats.avg_minutes != null ? fmtDuration(stats.avg_minutes) : '—')}
      ${tile('Finished on time', stats.on_time_pct != null ? stats.on_time_pct + '%' : '—')}
      ${tile('All-time sessions', stats.sessions)}
    </div>
    <div class="grid profile-grid">
      <article class="card"><h3>Recent charging</h3>${history}
        ${isMe ? '' : `<p class="muted small-text">Only sessions from the last ${named_history_days} days are listed.</p>`}</article>
      <article class="card"><h3>Recent activity</h3><ul class="feed">${activity}</ul></article>
    </div>`;
}

$$('[data-days]').forEach((btn) => btn.addEventListener('click', () => loadUsage(Number(btn.dataset.days))));

// ---------- usage analytics ----------

const OFFICE_START = 8;
const OFFICE_END = 18;
const isOfficeHour = (d) =>
  d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= OFFICE_START && d.getHours() < OFFICE_END;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function nextHour(t) {
  const d = new Date(t);
  d.setMinutes(60, 0, 0);
  return d.getTime();
}

/** Fetch and show usage for a range. The range buttons only switch once it has loaded. */
async function loadUsage(days = usageDays) {
  const view = $('#view-usage');
  const request = (loadUsage.last = {});
  view.setAttribute('aria-busy', 'true');
  $('#usage-error').textContent = '';
  let data;
  try {
    data = await api(`/api/sessions?days=${days}`);
  } catch (err) {
    if (loadUsage.last === request) $('#usage-error').textContent = `Couldn't load usage: ${err.message}`;
    return;
  } finally {
    if (loadUsage.last === request) view.removeAttribute('aria-busy');
  }
  if (loadUsage.last !== request) return; // a newer request superseded this one
  usageDays = days;
  $$('[data-days]').forEach((b) => setPressed(b, Number(b.dataset.days) === days));
  renderUsage(data);
}

function renderUsage({ sessions, drivers }) {
  const now = Date.now();
  const rangeStart = new Date(now);
  rangeStart.setHours(0, 0, 0, 0);
  rangeStart.setDate(rangeStart.getDate() - (usageDays - 1));
  const from = rangeStart.getTime();

  const days = [];
  for (let d = new Date(from); d.getTime() <= now; d.setDate(d.getDate() + 1)) {
    days.push({ key: dayKey(d), date: new Date(d), ms: 0 });
  }
  const dayIdx = Object.fromEntries(days.map((d, i) => [d.key, i]));
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, ms: 0 }));
  let totalMs = 0;
  let officeBusyMs = 0;
  let overstays = 0;

  // Walk each session hour by hour so every slice lands in the right local day/hour bucket.
  for (const s of sessions) {
    const start = Math.max(Date.parse(s.started_at), from);
    const end = s.ended_at ? Date.parse(s.ended_at) : now;
    if (end <= start) continue;
    for (let t = start; t < end;) {
      const next = Math.min(end, nextHour(t));
      const d = new Date(t);
      const slice = next - t;
      const i = dayIdx[dayKey(d)];
      if (i !== undefined) days[i].ms += slice;
      hours[d.getHours()].ms += slice;
      if (isOfficeHour(d)) officeBusyMs += slice;
      t = next;
    }
    const ms = end - start;
    totalMs += ms;
    if (s.ended_at && Date.parse(s.ended_at) > Date.parse(s.expected_end) + 10 * 60_000) overstays++;
  }

  let officeAvailMs = 0;
  for (let t = from; t < now;) {
    const next = Math.min(now, nextHour(t));
    if (isOfficeHour(new Date(t))) officeAvailMs += (next - t) * state.charger.chargers.length;
    t = next;
  }

  const hrs = (ms) => ms / 3600_000;
  const finished = sessions.filter((s) => s.ended_at).length;
  $('#usage-tiles').innerHTML = [
    ['Charging sessions', sessions.length],
    [state.charger.chargers.length > 1 ? 'Hours on the chargers' : 'Hours on the charger', hrs(totalMs).toFixed(1)],
    ['Average session', sessions.length ? fmtDuration(totalMs / sessions.length / 60000) : '—'],
    [`Busy during office hours`, officeAvailMs ? `${Math.round((officeBusyMs / officeAvailMs) * 100)}%` : '—'],
    ['Finished on time', finished ? `${Math.round(((finished - overstays) / finished) * 100)}%` : '—'],
  ]
    .map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');

  const labelEvery = Math.ceil(days.length / 10);
  barChart(
    $('#chart-daily'),
    days.map((d, i) => ({
      value: hrs(d.ms),
      label: i % labelEvery === 0 ? d.date.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '',
      tip: `${d.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${hrs(d.ms).toFixed(1)} h`,
    })),
  );
  barChart(
    $('#chart-hourly'),
    hours.map(({ h, ms }) => {
      const label = new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
      return { value: hrs(ms), label: h % 3 === 0 ? label : '', tip: `${label}: ${hrs(ms).toFixed(1)} h in use` };
    }),
  );

  // Per-driver totals come from the server, since older sessions arrive without names.
  const rows = drivers.sort((a, b) => b.ms - a.ms);
  $('#driver-table').innerHTML = rows.length
    ? `<thead><tr><th>Driver</th><th class="num">Sessions</th><th class="num">Hours</th><th class="num">Avg session</th>
         <th>Share of use</th><th class="num">Overstays</th><th>Last charged</th></tr></thead>
       <tbody>${rows
         .map((r) => {
           const share = totalMs ? (r.ms / totalMs) * 100 : 0;
           return `<tr><td>${nameLink(r.user_id, r.name)}</td><td class="num">${r.count}</td><td class="num">${hrs(r.ms).toFixed(1)}</td>
             <td class="num">${fmtDuration(r.ms / r.count / 60000)}</td>
             <td>${Math.round(share)}%<span class="share" style="width:${share * 0.8}px"></span></td>
             <td class="num">${r.late}</td><td>${fmtTime(r.last)}</td></tr>`;
         })
         .join('')}</tbody>`
    : '<tbody><tr><td class="empty">No charging sessions in this period yet.</td></tr></tbody>';
}

function barChart(el, data) {
  const max = Math.max(...data.map((d) => d.value), 0.0001);
  el.innerHTML = `
    <div class="bars-max">max ${max < 0.01 ? 0 : max.toFixed(1)} h</div>
    <div class="bars-plot">${data
      .map(
        (
          d,
          i,
        ) => `<div class="bar-slot" data-tip="${esc(d.tip)}" role="img" aria-label="${esc(d.tip)}" tabindex="${i === 0 ? 0 : -1}">
          <div class="bar" style="height:${(d.value / max) * 100}%"></div></div>`,
      )
      .join('')}</div>
    <div class="bars-axis">${data.map((d) => `<span>${esc(d.label)}</span>`).join('')}</div>`;
}

// Shared tooltip for chart bars: follows the mouse, or sits above a bar that
// was tapped or reached with the keyboard.
function showTip(slot, x, y) {
  const tip = $('#tooltip');
  if (!slot) return (tip.hidden = true);
  tip.textContent = slot.dataset.tip;
  tip.hidden = false;
  tip.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${y - 34}px`;
}
const showTipAbove = (slot) => {
  const r = slot.getBoundingClientRect();
  showTip(slot, r.left + r.width / 2 - 12, r.top);
};
document.addEventListener('mousemove', (e) => {
  const slot = e.target.closest?.('[data-tip]');
  const keyboardTip = document.activeElement?.dataset?.tip !== undefined;
  if (slot || !keyboardTip) showTip(slot, e.clientX, e.clientY); // don't hide a focused bar's tip
});
document.addEventListener('click', (e) => {
  const slot = e.target.closest?.('[data-tip]');
  if (slot) showTipAbove(slot);
});
document.addEventListener('focusin', (e) => (e.target.dataset?.tip ? showTipAbove(e.target) : showTip(null)));
document.addEventListener('focusout', () => showTip(null));
// Arrow keys step through a chart's bars; only one bar is a tab stop.
document.addEventListener('keydown', (e) => {
  const slot = e.target.closest?.('.bar-slot');
  if (!slot) return;
  const slots = [...slot.parentElement.children];
  const i = slots.indexOf(slot);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: slots.length - 1 }[e.key];
  if (next === undefined || !slots[next]) return;
  e.preventDefault();
  slot.tabIndex = -1;
  slots[next].tabIndex = 0;
  slots[next].focus();
});

// Re-fetch now and then too, in case an update was missed; this also keeps
// countdowns and "x minutes ago" fresh.
setInterval(() => state && reload(), 30_000);

convertDistInputs($('#register-form'), 'imperial', units); // defaults in the HTML are miles
applyUnits();
boot();

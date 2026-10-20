'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = null; // latest /api/state payload
let stream = null;
let statusDirty = false;
let usageDays = 30;

// ---------- utilities ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 5000);
}

function notify(text) {
  toast(text);
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('EV Charge Circle', { body: text });
  }
}

// ---------- auth ----------

function showAuth() {
  state = null;
  stream?.close();
  stream = null;
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
    $$('[data-auth]').forEach((b) => b.classList.toggle('active', b === btn));
    $('#login-form').hidden = btn.dataset.auth !== 'login';
    $('#register-form').hidden = btn.dataset.auth !== 'register';
    $('#auth-error').textContent = '';
  })
);

async function submitAuth(e, url) {
  e.preventDefault();
  $('#auth-error').textContent = '';
  const body = Object.fromEntries(new FormData(e.target));
  try {
    await api(url, { method: 'POST', body });
    e.target.reset();
    await boot();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
}
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
  showApp();
  updateNotifyBtn();
  render();
  connectStream();
}

async function reload() {
  try {
    state = await api('/api/state');
    render();
    if (!$('#view-usage').hidden) loadUsage();
  } catch {}
}

let reloadTimer;
const scheduleReload = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, 150);
};

function connectStream() {
  if (stream) return;
  stream = new EventSource('/api/stream');
  stream.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    const me = state?.me;
    if (me && ev.target_user_id === me.id && ev.type === 'your_turn') {
      notify(`⚡ It's your turn! The charger is held for you until ${fmtTime(ev.data.until)}.`);
    } else if (me && ev.target_user_id === me.id && ev.type === 'overdue') {
      notify('⏰ Your charge time is up — please move your car or update your finish time.');
    } else if (me && ev.user_id !== me.id && ev.type === 'message') {
      toast(`${ev.actor}: ${ev.data.message}`);
    } else if (me && ev.user_id !== me.id && ev.type === 'start') {
      toast(`${ev.actor} plugged in · done ~${fmtTime(ev.data.expected_end)}`);
    }
    scheduleReload();
  };
  // EventSource reconnects on its own; resync whenever it does.
  stream.onopen = scheduleReload;
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
}

function chargerMode() {
  const { active, reservation } = state.charger;
  if (active) return Date.parse(active.expected_end) < Date.now() ? 'late' : 'busy';
  if (reservation) return 'reserved';
  return 'free';
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

function renderCharger() {
  const { active, reservation, queue } = state.charger;
  const me = state.me;
  const mode = chargerMode();
  const inQueue = queue.some((q) => q.user_id === me.id);
  const statusText = { free: 'Available', busy: 'In use', late: 'Overdue', reserved: 'Reserved' }[mode];

  $('#charger-status').className = `badge ${mode}`;
  $('#charger-status').textContent = statusText;
  const pill = $('#charger-pill');
  pill.className = `pill ${mode}`;
  pill.textContent =
    mode === 'free' ? '● Charger free' : mode === 'reserved' ? `● Held for ${reservation.name}` : `● ${active.name} charging`;

  let body = '';
  let actions = '';

  if (active) {
    const start = Date.parse(active.started_at);
    const end = Date.parse(active.expected_end);
    const pct = Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
    const remaining = (end - Date.now()) / 60000;
    const mine = active.user_id === me.id;
    body = `
      <p class="charger-big">${mine ? "You're charging" : `${esc(active.name)} is charging`}</p>
      <p class="charger-sub">${esc(active.car_model)} · plugged in at ${fmtTime(active.started_at)}
        ${active.start_level != null ? ` at ${active.start_level}%` : ''}</p>
      <div class="progress ${mode === 'late' ? 'late' : ''}"><span style="width:${pct}%"></span></div>
      <p class="charger-sub"><strong>Expected done ${fmtTime(active.expected_end)}</strong>
        · ${remaining >= 0 ? `${fmtDuration(remaining)} left` : `${fmtDuration(-remaining)} over`}
        ${queue.length ? ` · ${queue.length} waiting` : ''}</p>`;
    if (mine) {
      actions = `
        <div class="stack">
          <div class="inline-field">
            <label class="muted small-text" for="end-level">Charge when unplugging (%)</label>
            <input id="end-level" type="number" min="0" max="100" placeholder="e.g. 80" />
            <button data-act="end" type="button">I'm done — release charger</button>
          </div>
          ${durationPicker('update', 'Change finish time:')}
        </div>`;
    } else {
      actions = queueActions(inQueue);
    }
  } else if (reservation) {
    const mine = reservation.user_id === me.id;
    body = mine
      ? `<p class="charger-big">⚡ It's your turn!</p>
         <p class="charger-sub">The charger is held for you until <strong>${fmtTime(reservation.until)}</strong>. Plug in and let everyone know how long you'll be.</p>`
      : `<p class="charger-big">Held for ${esc(reservation.name)}</p>
         <p class="charger-sub">They're next in the queue and have until ${fmtTime(reservation.until)} to plug in. After that, anyone can use it.</p>`;
    actions = mine
      ? `${durationPicker('start', 'Charging for:')}<button class="ghost small" data-act="leave" type="button">Skip my turn</button>`
      : queueActions(inQueue);
  } else {
    body = `<p class="charger-big">The charger is free</p>
            <p class="charger-sub">Plug in and broadcast when you expect to be done so the next driver can plan.</p>`;
    actions = durationPicker('start', 'Charging for:');
  }

  $('#charger-body').innerHTML = body;
  // Don't wipe inputs the user is typing into on periodic re-renders.
  const actionsEl = $('#charger-actions');
  if (actionsEl.dataset.key !== `${mode}|${active?.user_id}|${reservation?.user_id}|${inQueue}` || !actionsEl.contains(document.activeElement)) {
    actionsEl.innerHTML = actions;
    actionsEl.dataset.key = `${mode}|${active?.user_id}|${reservation?.user_id}|${inQueue}`;
  }
}

function queueActions(inQueue) {
  return inQueue
    ? `<button class="ghost" data-act="leave" type="button">Leave the queue</button>`
    : `<div class="inline-field">
         <input id="queue-note" maxlength="140" placeholder="Optional note, e.g. 'at 15%, need ~2h'" />
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
  try {
    let expected_end;
    if (btn.dataset.hours) expected_end = new Date(Date.now() + Number(btn.dataset.hours) * 3600_000).toISOString();
    if (btn.dataset.time) {
      expected_end = timeInputToIso(btn.dataset.time);
      if (!expected_end) throw new Error('Pick a time first');
    }
    if (act === 'start') await api('/api/charger/start', { method: 'POST', body: { expected_end } });
    if (act === 'update') await api('/api/charger/update', { method: 'POST', body: { expected_end } });
    if (act === 'end') await api('/api/charger/end', { method: 'POST', body: { end_level: $('#end-level').value } });
    if (act === 'join') await api('/api/queue/join', { method: 'POST', body: { note: $('#queue-note').value } });
    if (act === 'leave') await api('/api/queue/leave', { method: 'POST' });
    if (act === 'end') statusDirty = false; // pick up the new charge level
    $('#charger-actions').dataset.key = '';
    await reload();
  } catch (err) {
    $('#charger-error').textContent = err.message;
  }
});

function renderQueue() {
  const { queue, reservation } = state.charger;
  $('#queue-count').textContent = queue.length ? `· ${queue.length} waiting` : '';
  $('#queue-list').innerHTML = queue.length
    ? queue
        .map(
          (q, i) => `
      <li>
        <span class="pos">${i + 1}</span>
        <div class="who">
          <strong>${esc(q.name)}</strong>${q.user_id === state.me.id ? ' (you)' : ''}
          <span class="muted small-text"> · ${q.charge_level}% · joined ${fmtTime(q.joined_at)}</span>
          ${q.note ? `<div class="note">“${esc(q.note)}”</div>` : ''}
        </div>
        ${reservation?.user_id === q.user_id ? '<span class="badge reserved">Up now</span>' : ''}
      </li>`
        )
        .join('')
    : '<li class="empty">Nobody waiting.</li>';
}

function renderDrivers() {
  const { active, queue } = state.charger;
  const drivers = [...state.drivers].sort((a, b) => (a.days_of_range ?? 1e9) - (b.days_of_range ?? 1e9));
  $('#drivers').innerHTML = drivers
    .map((d) => {
      const lvl = d.charge_level;
      const cls = lvl < 25 ? 'low' : lvl < 50 ? 'mid' : '';
      const qPos = queue.findIndex((q) => q.user_id === d.id);
      const badge =
        active?.user_id === d.id
          ? '<span class="badge busy">⚡ Charging</span>'
          : qPos >= 0
            ? `<span class="badge">Queue #${qPos + 1}</span>`
            : '';
      return `
      <div class="driver ${d.id === state.me.id ? 'me' : ''}">
        <div class="driver-top">
          <span class="driver-name">${esc(d.name)}${d.id === state.me.id ? ' (you)' : ''}</span>
        </div>
        <div class="driver-car">${esc(d.car_model)}</div>
        <div class="battery" role="img" aria-label="Battery ${lvl} percent">
          <div class="battery-shell"><div class="battery-fill ${cls}" style="width:${lvl}%"></div></div>
          <div class="battery-cap"></div>
          <span class="battery-pct">${lvl}%</span>
        </div>
        <div class="driver-stats">
          <div><strong>${d.est_range_mi}</strong>mi left</div>
          <div><strong>${d.daily_miles}</strong>mi / day</div>
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
  f.daily_miles.value = state.me.daily_miles;
  f.full_range_mi.value = state.me.full_range_mi;
  f.car_model.value = state.me.car_model;
}

$('#status-form').addEventListener('input', (e) => {
  statusDirty = true;
  if (e.target.name === 'charge_level') $('#charge-out').textContent = e.target.value;
});

$('#status-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#status-msg');
  try {
    await api('/api/me', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
    statusDirty = false;
    msg.textContent = 'Saved.';
    setTimeout(() => (msg.textContent = ''), 2500);
    await reload();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#broadcast-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/broadcast', { method: 'POST', body: { message: e.target.message.value } });
    e.target.reset();
  } catch (err) {
    toast(err.message);
  }
});

function eventText(ev) {
  const a = `<strong>${esc(ev.actor || 'Someone')}</strong>`;
  const t = `<strong>${esc(ev.target || 'Someone')}</strong>`;
  const d = ev.data || {};
  switch (ev.type) {
    case 'registered': return `👋 ${a} joined the community (${esc(d.car_model)})`;
    case 'status': return `🔋 ${a} is at ${d.charge_level}%, driving ${d.daily_miles} mi/day`;
    case 'start': return `⚡ ${a} plugged in — expects to be done at <strong>${fmtTime(d.expected_end)}</strong>`;
    case 'extend': return `🕒 ${a} now expects to be done at <strong>${fmtTime(d.expected_end)}</strong>`;
    case 'end': return `✅ ${a} unplugged after ${fmtDuration(d.minutes)}${d.end_level != null ? ` at ${d.end_level}%` : ''} — charger is free`;
    case 'queue_join': return `🙋 ${a} joined the queue${d.note ? `: “${esc(d.note)}”` : ''}`;
    case 'queue_leave': return `${a} left the queue`;
    case 'your_turn': return `➡️ Charger passed to ${t} — held until ${fmtTime(d.until)}`;
    case 'overdue': return `<span class="alert">⏰ ${t}'s charge was due at ${fmtTime(d.expected_end)}</span>`;
    case 'message': return `💬 ${a}<br><span class="msg">${esc(d.message)}</span>`;
    default: return esc(ev.type);
  }
}

function renderFeed() {
  $('#feed').innerHTML = state.events.length
    ? state.events.map((ev) => `<li>${eventText(ev)}<time>${ago(ev.created_at)}</time></li>`).join('')
    : '<li class="empty">No activity yet.</li>';
}

// ---------- tabs ----------

$$('[data-view]').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('[data-view]').forEach((b) => b.classList.toggle('active', b === btn));
    $('#view-community').hidden = btn.dataset.view !== 'community';
    $('#view-usage').hidden = btn.dataset.view !== 'usage';
    if (btn.dataset.view === 'usage') loadUsage();
  })
);

$$('[data-days]').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('[data-days]').forEach((b) => b.classList.toggle('active', b === btn));
    usageDays = Number(btn.dataset.days);
    loadUsage();
  })
);

// ---------- usage analytics ----------

const OFFICE_START = 8;
const OFFICE_END = 18;
const isOfficeHour = (d) => d.getDay() >= 1 && d.getDay() <= 5 && d.getHours() >= OFFICE_START && d.getHours() < OFFICE_END;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function nextHour(t) {
  const d = new Date(t);
  d.setMinutes(60, 0, 0);
  return d.getTime();
}

async function loadUsage() {
  const { sessions } = await api(`/api/sessions?days=${usageDays}`);
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
  const perDriver = new Map();
  let totalMs = 0;
  let officeBusyMs = 0;
  let overstays = 0;

  // Walk each session hour by hour so every slice lands in the right local day/hour bucket.
  for (const s of sessions) {
    const start = Math.max(Date.parse(s.started_at), from);
    const end = s.ended_at ? Date.parse(s.ended_at) : now;
    if (end <= start) continue;
    for (let t = start; t < end; ) {
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
    const late = s.ended_at && Date.parse(s.ended_at) > Date.parse(s.expected_end) + 10 * 60_000;
    if (late) overstays++;
    const p = perDriver.get(s.user_id) || { name: s.name, count: 0, ms: 0, late: 0, last: s.started_at };
    p.count++;
    p.ms += ms;
    if (late) p.late++;
    if (s.started_at > p.last) p.last = s.started_at;
    perDriver.set(s.user_id, p);
  }

  let officeAvailMs = 0;
  for (let t = from; t < now; ) {
    const next = Math.min(now, nextHour(t));
    if (isOfficeHour(new Date(t))) officeAvailMs += next - t;
    t = next;
  }

  const hrs = (ms) => ms / 3600_000;
  const finished = sessions.filter((s) => s.ended_at).length;
  $('#usage-tiles').innerHTML = [
    ['Charging sessions', sessions.length],
    ['Hours on the charger', hrs(totalMs).toFixed(1)],
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
    }))
  );
  barChart(
    $('#chart-hourly'),
    hours.map(({ h, ms }) => {
      const label = new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
      return { value: hrs(ms), label: h % 3 === 0 ? label : '', tip: `${label}: ${hrs(ms).toFixed(1)} h in use` };
    })
  );

  const rows = [...perDriver.values()].sort((a, b) => b.ms - a.ms);
  $('#driver-table').innerHTML = rows.length
    ? `<thead><tr><th>Driver</th><th class="num">Sessions</th><th class="num">Hours</th><th class="num">Avg session</th>
         <th>Share of use</th><th class="num">Overstays</th><th>Last charged</th></tr></thead>
       <tbody>${rows
         .map((r) => {
           const share = totalMs ? (r.ms / totalMs) * 100 : 0;
           return `<tr><td>${esc(r.name)}</td><td class="num">${r.count}</td><td class="num">${hrs(r.ms).toFixed(1)}</td>
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
      .map((d) => `<div class="bar-slot" data-tip="${esc(d.tip)}"><div class="bar" style="height:${(d.value / max) * 100}%"></div></div>`)
      .join('')}</div>
    <div class="bars-axis">${data.map((d) => `<span>${esc(d.label)}</span>`).join('')}</div>`;
}

// Shared hover tooltip for chart bars.
document.addEventListener('mousemove', (e) => {
  const tip = $('#tooltip');
  const slot = e.target.closest?.('[data-tip]');
  if (!slot) return (tip.hidden = true);
  tip.textContent = slot.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY - 34}px`;
});

// Keep countdowns and "x minutes ago" fresh.
setInterval(() => state && render(), 30_000);

boot();

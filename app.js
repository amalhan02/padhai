// Padhai — study plan tracker. No build step: plain ES modules talking to Supabase.
import * as L from './logic.js';
import { CONFIG } from './config.js';

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => L.iso(new Date());
const fmt = (s, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => (s ? L.parse(s).toLocaleDateString('en-IN', opts) : '—');
const short = (s) => fmt(s, { day: 'numeric', month: 'short' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const KINDS = ['DSA', 'Go', 'Backend', 'LLD', 'Design', 'Mock', 'Review'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LEVELS = ['Hello, World', 'Goroutine', 'Channel Surfer', 'Mutex Master', 'Select Statement', 'Scheduler', 'Garbage Collector', 'Race Detector', 'Staff Gopher', 'Interview Ready'];
const ICON = {
  today: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/>',
  journey: '<path d="M6 21V4"/><path d="M6 5h11l-2.5 4 2.5 4H6"/>',
  practice: '<path d="M5 4h9a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4z"/><path d="M9 9h5M9 13h5"/>',
  me: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
};

// ------------------------------------------------------------------ data stores
// Both stores expose the same small interface, so the rest of the app does not care which is in use.
function localStore() {
  const KEY = 'padhai-demo';
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { db = null; }
  db = db || { seq: 1, t: { profiles: [{ id: 'demo', display_name: 'You', email: '' }], plans: [], sessions: [], problems: [], topics: [], mocks: [] } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { return; } };
  return {
    demo: true,
    async init() { return { id: 'demo', email: '' }; },
    async signIn() {}, async signUp() {},
    async signOut() { try { localStorage.removeItem(KEY); } catch { db = null; } location.reload(); },
    async all(table, where = {}) { return db.t[table].filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).map((r) => ({ ...r })); },
    async insert(table, rows) { const out = rows.map((r) => ({ id: db.seq++, ...r })); db.t[table].push(...out); save(); return out.map((r) => ({ ...r })); },
    async update(table, id, patch) { const r = db.t[table].find((x) => x.id === id); Object.assign(r, patch); save(); return { ...r }; },
    async remove(table, id) {
      db.t[table] = db.t[table].filter((x) => x.id !== id);
      if (table === 'plans') for (const t of ['sessions', 'problems', 'topics', 'mocks']) db.t[t] = db.t[t].filter((x) => x.plan_id !== id);
      save();
    },
    async upsertProfile(p) { const r = db.t.profiles.find((x) => x.id === p.id); if (r) Object.assign(r, p); else db.t.profiles.push(p); save(); return p; },
  };
}

async function supabaseStore() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  // the study tables are prefixed so they can share a Supabase project with another app
  const from = (table) => sb.from(table === 'profiles' ? table : 'study_' + table);
  return {
    demo: false,
    async init() { return ok(await sb.auth.getSession()).session?.user || null; },
    async signIn(email, password) { return ok(await sb.auth.signInWithPassword({ email, password })).user; },
    async signUp(email, password) { const d = ok(await sb.auth.signUp({ email, password })); return d.session ? d.user : null; },
    async signOut() { await sb.auth.signOut(); location.reload(); },
    async all(table, where = {}) { let q = from(table).select('*'); for (const [k, v] of Object.entries(where)) q = q.eq(k, v); return ok(await q); },
    async insert(table, rows) { return ok(await from(table).insert(rows).select()); },
    async update(table, id, patch) { return ok(await from(table).update(patch).eq('id', id).select().single()); },
    async remove(table, id) { ok(await from(table).delete().eq('id', id)); },
    // update first: a shared profiles table may only allow people to update their own row
    async upsertProfile(p) {
      const { id, ...rest } = p;
      const updated = ok(await sb.from('profiles').update(rest).eq('id', id).select());
      return updated.length ? updated[0] : ok(await sb.from('profiles').insert(p).select().single());
    },
  };
}

// ------------------------------------------------------------------ state
let store;
const S = { user: null, profiles: [], plans: [], planId: null, sessions: [], problems: [], topics: [], mocks: [],
  tab: 'today', ptab: 'problems', openCat: null, pStatus: 'all', pBlock: '', sheet: null, detail: null, focus: false, party: null,
  toast: null, authMode: 'in', busy: false };
const plan = () => S.plans.find((p) => p.id === S.planId) || null;
const pref = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { return; } } };
const timerKey = () => 'padhai-timer-' + S.planId;

function toast(msg, ok = false) {
  S.toast = { msg, ok }; render();
  clearTimeout(toast.t); toast.t = setTimeout(() => { S.toast = null; render(); }, ok ? 2200 : 6000);
}
async function run(fn) {
  if (S.busy) return;
  S.busy = true;
  try { await fn(); } catch (e) { console.error(e); toast(e.message || String(e)); } finally { S.busy = false; }
  render();
}

async function loadPlans() {
  S.profiles = await store.all('profiles');
  S.plans = (await store.all('plans')).sort((a, b) => a.id - b.id);
  const saved = Number(pref.get('padhai-plan'));
  S.planId = S.plans.some((p) => p.id === saved) ? saved
    : (S.plans.find((p) => p.owner_id === S.user.id) || S.plans[0] || {}).id ?? null;
  await loadPlanData();
}
async function loadPlanData() {
  if (!S.planId) { S.sessions = S.problems = S.topics = S.mocks = []; return; }
  const w = { plan_id: S.planId };
  [S.sessions, S.problems, S.topics, S.mocks] = await Promise.all(['sessions', 'problems', 'topics', 'mocks'].map((t) => store.all(t, w)));
  S.sessions.sort((a, b) => a.seq - b.seq);
  S.problems.sort((a, b) => (a.block || 99) - (b.block || 99) || a.id - b.id);
  S.topics.sort((a, b) => a.sort - b.sort || a.id - b.id);
  S.mocks.sort((a, b) => (a.done_on < b.done_on ? 1 : -1));
}
const patchRow = (list, row) => { const i = list.findIndex((r) => r.id === row.id); if (i >= 0) list[i] = row; };
async function save(table, id, patch) { patchRow(S[table], await store.update(table, id, patch)); }

// ------------------------------------------------------------------ progress, XP and dates
function xp() {
  const D = { Easy: 10, Medium: 20, Hard: 30 };
  let n = S.sessions.filter((s) => s.done_on).length * 50 + S.mocks.length * 40;
  for (const p of S.problems) if (p.solved_on) n += (D[p.difficulty] || 15) + (p.reviews_done || 0) * 10;
  for (const t of S.topics) if (t.learned_on) n += 5 + (t.reviews_done || 0) * 5;
  return n;
}
// level n starts at 150 * n * (n - 1) XP: 0, 300, 900, 1800, 3000 …
function level(n = xp()) {
  let lv = 1;
  while (lv < LEVELS.length && n >= 150 * (lv + 1) * lv) lv++;
  const lo = 150 * lv * (lv - 1), hi = 150 * (lv + 1) * lv;
  return { lv, name: LEVELS[lv - 1], xp: n, toNext: lv < LEVELS.length ? hi - n : 0, pct: lv < LEVELS.length ? Math.round(((n - lo) / (hi - lo)) * 100) : 100 };
}
// the date each session falls on: the day it was done, or its projected day if still to do
function schedule(p, st, t) {
  const m = new Map();
  let d = st.doneToday ? L.addDays(t, 1) : (t > p.start_date ? t : p.start_date), first = true;
  for (const s of S.sessions) {
    if (s.done_on) { m.set(s.id, s.done_on); continue; }
    d = L.nthStudyDay(p, first ? d : L.addDays(d, 1), 1); first = false;
    if (!d) break;
    m.set(s.id, d);
  }
  return m;
}
function dayState(p, doneDays, d, t) {
  if (doneDays.has(d)) return 'done';
  if (d < p.start_date || !L.isStudyDay(p, d)) return 'rest';
  return d < t ? 'missed' : 'future';
}
const doneDaysOf = () => new Set(S.sessions.filter((s) => s.done_on).map((s) => s.done_on));

// ------------------------------------------------------------------ views
function viewAuth() {
  const up = S.authMode === 'up';
  return `<div class="top"><span class="brand">Padhai</span></div>
  <div class="hero"><div class="task">${up ? 'Create your account' : 'Sign in to keep your streak'}</div>
    <form data-form="auth">
      <label style="color:#ffffffb3">Email</label><input name="email" type="email" autocomplete="email" required style="color:var(--ink)">
      <label style="color:#ffffffb3">Password</label><input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="6" required style="color:var(--ink)">
      <button class="press">${up ? 'Create account' : 'Sign in'}</button>
    </form>
    <button class="alt" data-a="authMode">${up ? 'I already have an account' : 'Create an account'}</button>
  </div>`;
}

function viewEmpty() {
  return `<div class="hero"><div class="ghost">91</div><div class="daynum">No plan yet</div>
    <p class="extra">Load the 91-day Go interview plan, choose who is studying and when to start. Every day can be edited later.</p>
    <button class="press" data-a="newPlan">Create a plan</button></div>`;
}

function weekStrip(p, t) {
  const doneDays = doneDaysOf(), mon = L.addDays(t, 1 - L.dow(t));
  return `<div class="week">${DAY_NAMES.map((n, i) => { const d = L.addDays(mon, i), st = dayState(p, doneDays, d, t);
    return `<div class="${st} ${d === t ? 'today' : ''}">${n[0]}<i>${st === 'done' ? '✓' : st === 'missed' ? '×' : L.parse(d).getDate()}</i></div>`; }).join('')}</div>`;
}

function quests(st, t, due) {
  const q = [{ label: "Finish today's session", n: st.doneToday ? 1 : 0, of: 1 }];
  const s = st.next, solved = S.problems.filter((x) => x.solved_on === t).length;
  const left = s ? S.problems.filter((x) => x.block === s.block && !x.solved_on).length : 0;
  if (solved || (s && s.kind === 'DSA' && left)) q.push({ label: 'Solve 3 new problems', n: Math.min(3, solved), of: Math.max(1, Math.min(3, solved + left)) });
  const reviewed = S.problems.filter((x) => x.last_review_on === t).length + S.topics.filter((x) => x.last_review_on === t).length;
  if (reviewed || due) q.push({ label: 'Clear your reviews', n: reviewed, of: reviewed + due });
  return q;
}

function viewToday() {
  const p = plan(), t = today(), st = L.planStatus(p, S.sessions, t), s = st.next;
  const dueP = S.problems.filter((x) => L.problemStatus(x, t).status === 'due');
  const dueT = S.topics.filter((x) => L.topicStatus(x, t).status === 'due');
  const running = !!pref.get(timerKey()), rest = st.started && !st.todayIsStudy;
  const doneView = st.doneToday && !S.catchUp && !running;
  const todo = s ? S.problems.filter((x) => x.block === s.block && !x.solved_on) : [];
  const groups = {};
  for (const x of dueT) (groups[`${x.category}: ${x.grp}`] ||= []).push(x);

  let hero;
  if (st.finished) hero = `<div class="daynum">Plan complete</div><p class="extra">All ${st.total} days done. Keep clearing reviews while you interview.</p>`;
  else if (!s) hero = `<div class="daynum">Empty plan</div><p class="extra">This plan has no days yet.</p><button class="press" data-a="addSession">Add the first day</button>`;
  else if (doneView) hero = `<div class="daynum">Day ${s.seq - 1} done ✓</div>
    <p class="extra">${st.streak > 1 ? `${st.streak} days in a row. ` : ''}Next up, Day ${s.seq}: ${esc(s.task)}</p>
    <button class="alt" data-a="catchUp">${st.behind ? `Catch up: start Day ${s.seq} now` : `Start Day ${s.seq} early`}</button>`;
  else hero = `<div class="daynum">Day ${s.seq} <span>of ${st.total}</span></div>
    <div class="when"><span class="pill k-${esc(s.kind)}">${esc(s.kind)}</span>${!st.started ? `Starts ${fmt(p.start_date)}` : rest ? 'Rest day' : fmt(t)}</div>
    <div class="task">${esc(s.task)}</div>
    ${s.extra ? `<p class="extra">${esc(s.extra)}</p>` : ''}
    <button class="press" data-a="focus">${running ? 'Continue session' : !st.started ? 'Start early' : rest ? 'Study anyway' : "Start today's session"}</button>`;

  let note = '';
  if (store.demo) note += `<div class="note">Demo mode: nothing is saved to the database yet.</div>`;
  if (st.behind > 0) note += `<div class="note bad"><b>${plural(st.behind, 'day')} behind.</b> The finish line moved ${plural(st.slipDays, 'day')} to ${short(st.projectedFinish)}. One session today is enough; do not double up.</div>`;
  else if (st.started && st.todayIsStudy && !st.doneToday && st.streak > 0) note += `<div class="note"><b>${st.streak}-day streak on the line.</b> It ends tonight if today is skipped.</div>`;
  if (!pref.get('padhai-hint')) note += `<div class="note">Each day: press the orange button, study for ${p.minutes_per_day} minutes, press Finish. Missed a day? The plan just moves on by one.
    <button class="press plain sm" style="margin-top:8px" data-a="hideHint">Got it</button></div>`;

  const qs = st.finished ? [] : quests(st, t, dueP.length + dueT.length);
  return `<div class="hero"><div class="ghost">${s ? s.seq : st.total}</div>${weekStrip(p, t)}${hero}</div>${note}
  ${qs.length ? `<h2>Today's quests</h2><div class="card">${qs.map((q) => `
    <div class="row quest ${q.n >= q.of ? 'ok' : ''}"><div class="tick">${q.n >= q.of ? '✓' : ''}</div>
      <div class="grow"><div class="t">${q.label} <span class="mute small">${q.n}/${q.of}</span></div><div class="bar"><i style="width:${(q.n / q.of) * 100}%"></i></div></div></div>`).join('')}</div>` : ''}

  ${dueP.length ? `<h2>Re-solve these (${dueP.length})</h2><div class="card">${dueP.map((x) => `
    <div class="row"><div class="grow"><div class="t">${esc(x.name)}</div>
      <div class="small mute">${esc(x.pattern || '')}, review ${(x.reviews_done || 0) + 1} of 3. How did it go?</div>
      <div class="rate">${['Struggled', 'OK', 'Easy'].map((r) => `<button class="press plain sm" data-a="reviewProblem" data-id="${x.id}" data-r="${r}">${r}</button>`).join('')}</div></div></div>`).join('')}</div>` : ''}

  ${dueT.length ? `<h2>Revise these topics (${dueT.length})</h2><div class="card">${Object.entries(groups).map(([g, xs]) => `
    <div class="row"><div class="grow"><div class="t">${esc(g)}</div><div class="small mute">${esc(xs.map((x) => x.topic).join(', '))}</div></div>
      <button class="press mint sm" data-a="reviewTopics" data-ids="${xs.map((x) => x.id).join(',')}">Revised</button></div>`).join('')}</div>` : ''}

  ${s && !doneView && todo.length ? `<h2>Problems for this block (${todo.length} left)</h2><div class="card">${todo.map((x) => `
    <div class="row"><div class="grow"><div class="t">${esc(x.name)}</div><div class="small mute">${esc(x.pattern || '')}, ${esc(x.difficulty || '')}</div></div>
      <button class="press mint sm" data-a="logProblem" data-id="${x.id}">Solved</button></div>`).join('')}</div>` : ''}`;
}

function viewJourney() {
  const p = plan(), t = today(), st = L.planStatus(p, S.sessions, t), when = schedule(p, st, t);
  const nums = [...new Set(S.sessions.map((s) => s.block))].sort((a, b) => a - b);
  return `<div class="note"><b>${st.doneCount} of ${st.total} days done.</b> Finish line: ${fmt(st.projectedFinish)}${st.slipDays ? ` (planned ${short(st.plannedFinish)})` : ''}.
    Tap any day to see it, tick it or change it.</div>
  ${nums.map((n) => {
    const ss = S.sessions.filter((s) => s.block === n), d = ss.filter((s) => s.done_on).length;
    const b = (p.blocks || []).find((x) => x.num === n) || {};
    return `<div class="camp"><b>Block ${n}: ${esc(b.dsa || '')}</b><span>${b.deep ? esc(b.deep) + '. ' : ''}${d} of ${ss.length} days done</span></div>
    <div class="trail">${ss.map((s) => { const now = st.next && s.id === st.next.id; return `
      <button class="step ${s.done_on ? 'done' : ''} ${now ? 'now' : ''}" ${now ? 'id="now"' : ''} data-a="openDay" data-id="${s.id}" aria-label="Day ${s.seq}">
        <span class="node">${s.done_on ? '✓' : s.seq}</span>
        <span class="grow"><span class="small mute">Day ${s.seq}, ${fmt(when.get(s.id))} <span class="pill k-${esc(s.kind)}">${esc(s.kind)}</span></span>
          <span class="t">${esc(s.task)}</span></span></button>`; }).join('')}</div>`;
  }).join('')}
  <div style="height:14px"></div><button class="press plain" data-a="addSession">Add a day</button>
  ${st.next ? `<button class="press sm fab" data-a="jumpNow">Go to Day ${st.next.seq}</button>` : ''}`;
}

function viewDay() {
  const p = plan(), t = today(), st = L.planStatus(p, S.sessions, t), s = S.sessions.find((x) => x.id === S.detail);
  const split = (p.splits || {})[s.kind], b = (p.blocks || []).find((x) => x.num === s.block) || {};
  return `<div class="sheet-bg" data-a="closeDayBg"><div class="sheet" role="dialog" aria-label="Day ${s.seq}">
    <div class="head"><h3 class="grow">Day ${s.seq} <span class="pill k-${esc(s.kind)}">${esc(s.kind)}</span></h3><button class="press plain sm" data-a="closeDay">Close</button></div>
    <p class="small mute">${s.done_on ? 'Done ' + fmt(s.done_on) : 'Planned for ' + fmt(schedule(p, st, t).get(s.id))}, Block ${s.block}${b.dsa ? ': ' + esc(b.dsa) : ''}</p>
    <div class="note"><div class="t">${esc(s.task)}</div>${s.extra ? `<div class="small mute" style="margin-top:6px">${esc(s.extra)}</div>` : ''}</div>
    ${split ? `<div class="note small"><b>How to spend the ${p.minutes_per_day} minutes</b><br>${esc(split)}</div>` : ''}
    ${s.notes ? `<div class="note small"><b>Your notes</b><br>${esc(s.notes)}</div>` : ''}
    <button class="press ${s.done_on ? 'plain' : 'mint'}" data-a="toggleSession" data-id="${s.id}">${s.done_on ? 'Mark as not done' : 'Mark as done'}</button>
    <button class="press plain" data-a="editSession" data-id="${s.id}">Edit this day</button>
  </div></div>`;
}

function viewFocus() {
  const p = plan(), st = L.planStatus(p, S.sessions, today()), s = st.next;
  const steps = String((p.splits || {})[s.kind] || '').split(/\.\s+(?=\d)/).map((x) => x.replace(/\.$/, '')).filter(Boolean);
  return `<div class="full"><div class="in">
    <div class="small" style="color:#ffffffa6">Day ${s.seq} of ${st.total} <span class="pill k-${esc(s.kind)}">${esc(s.kind)}</span></div>
    <div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54"/><circle class="arc" id="arc" cx="60" cy="60" r="54" stroke-dasharray="339.3" stroke-dashoffset="0"/></svg>
      <div class="time"><div id="timer">--:--</div><span id="timerLabel">left</span></div></div>
    <div class="task">${esc(s.task)}</div>
    ${steps.length ? `<ul class="how">${steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="spacer"></div>
    <button class="press mint" data-a="doneSession" data-id="${s.id}">Finish Day ${s.seq}</button>
    <button class="alt" data-a="leaveFocus">Back to the app (timer keeps running)</button>
    <button class="alt" data-a="timerStop">Stop and reset the timer</button>
  </div></div>`;
}

function viewParty() {
  const c = S.party, colors = ['#ff6a3d', '#12b89a', '#ffc93c', '#4c6fff', '#ffffff'];
  return `<div class="full party"><div class="confetti">${Array.from({ length: 36 }, (_, i) => `<i style="left:${(i * 37) % 100}%;background:${colors[i % 5]};animation-duration:${2 + (i % 5) * 0.5}s;animation-delay:${(i % 9) * 0.12}s"></i>`).join('')}</div>
  <div class="in"><h1>Day ${c.day} done</h1>
    <div class="gain"><div><b>+${c.gain} XP</b>${esc(c.level)}</div><div><b>${c.streak}</b>day streak</div></div>
    <p style="color:#ffffffd9">${c.next ? `Tomorrow, Day ${c.next.seq}: ${esc(c.next.task)}` : 'That was the last day. You finished the plan.'}</p>
    <div class="spacer"></div>
    <button class="press" data-a="closeParty">Continue</button></div></div>`;
}

function viewPractice() {
  const t = today();
  const seg = `<div class="seg"><button class="${S.ptab === 'problems' ? 'on' : ''}" data-a="ptab" data-k="problems">Problems</button><button class="${S.ptab === 'topics' ? 'on' : ''}" data-a="ptab" data-k="topics">Topics</button></div>`;
  if (S.ptab === 'topics') {
    const cats = [...new Set(S.topics.map((x) => x.category))];
    return seg + cats.map((c) => {
      const xs = S.topics.filter((x) => x.category === c), started = xs.filter((x) => x.learned_on).length;
      const open = S.openCat === c, grps = [...new Set(xs.map((x) => x.grp))];
      return `<div class="card" style="margin-bottom:10px"><button class="row" data-a="toggleCat" data-c="${esc(c)}">
          <span class="grow"><span class="t">${esc(c)}</span> <span class="small mute">${started} of ${xs.length} learned</span><div class="bar" style="margin-top:7px"><i style="width:${(started / xs.length) * 100}%"></i></div></span>
          <span class="mute">${open ? '▴' : '▾'}</span></button>
        ${open ? grps.map((g) => { const gs = xs.filter((x) => x.grp === g), fresh = gs.filter((x) => !x.learned_on);
          return `<div class="row"><span class="grow t" style="color:var(--sky)">${esc(g)}</span>
            ${fresh.length ? `<button class="press mint sm" data-a="learnTopics" data-ids="${fresh.map((x) => x.id).join(',')}">Learned today</button>` : ''}</div>
          ${gs.map((x) => { const s = L.topicStatus(x, t); return `<button class="row" data-a="editTopic" data-id="${x.id}">
            <span class="grow"><span class="t" style="font-weight:500">${esc(x.topic)}</span>${s.next ? `<div class="small mute">review on ${short(s.next)}</div>` : ''}</span>
            ${s.status === 'todo' ? '' : `<span class="pill s-${s.status}">${s.status}</span>`}</button>`; }).join('')}`; }).join('') : ''}</div>`;
    }).join('') + `<button class="press plain" data-a="addTopic">Add a topic</button>`;
  }
  const rows = S.problems.map((x) => ({ x, s: L.problemStatus(x, t) }));
  const count = (k) => rows.filter((r) => r.s.status === k).length;
  const shown = rows.filter((r) => (S.pStatus === 'all' || r.s.status === S.pStatus) && (!S.pBlock || String(r.x.block) === S.pBlock));
  const blocks = [...new Set(S.problems.map((x) => x.block).filter(Boolean))].sort((a, b) => a - b);
  const chip = (k, label) => `<button class="${S.pStatus === k ? 'on' : ''}" data-a="pStatus" data-k="${k}">${label}</button>`;
  return `${seg}<div class="chips">${chip('all', `All ${rows.length}`)}${chip('todo', `To do ${count('todo')}`)}${chip('due', `Due ${count('due')}`)}${chip('scheduled', `Scheduled ${count('scheduled')}`)}${chip('mastered', `Mastered ${count('mastered')}`)}</div>
  <div class="tools"><select data-change="pBlock" aria-label="Filter by block"><option value="">All blocks</option>
    ${blocks.map((b) => `<option value="${b}" ${String(b) === S.pBlock ? 'selected' : ''}>Block ${b}</option>`).join('')}</select>
    <button class="press plain sm" style="min-height:46px" data-a="addProblem">Add</button></div>
  <div class="card">${shown.length ? shown.map(({ x, s }) => `
    <button class="row" data-a="editProblem" data-id="${x.id}">
      <span class="grow"><span class="t">${esc(x.name)}</span>
        <div class="small mute">Block ${x.block || '–'}, ${esc(x.pattern || '')}, ${esc(x.difficulty || '')}${s.next ? ', review on ' + short(s.next) : ''}</div></span>
      ${s.status === 'todo' ? '' : `<span class="pill s-${s.status}">${s.status}</span>`}</button>`).join('') : '<p class="mute" style="padding:14px 0">Nothing here.</p>'}</div>`;
}

function viewMe() {
  const p = plan(), t = today(), me = S.profiles.find((x) => x.id === S.user.id) || {};
  let top = '';
  if (p) {
    const lv = level(), st = L.planStatus(p, S.sessions, t), doneDays = doneDaysOf();
    const mon = L.addDays(t, 1 - L.dow(t)), cells = [];
    for (let w = 11; w >= 0; w--) for (let i = 0; i < 7; i++) { const d = L.addDays(mon, i - w * 7); cells.push(`<i class="${dayState(p, doneDays, d, t)} ${d === t ? 'today' : ''}" title="${d}"></i>`); }
    top = `<div class="level"><div class="small" style="color:#ffffffa6">Level ${lv.lv}</div><h3>${esc(lv.name)}</h3>
      <div class="bar sun"><i style="width:${lv.pct}%"></i></div>
      <div class="small" style="color:#ffffffb3">${lv.xp} XP${lv.toNext ? `, ${lv.toNext} more to reach ${esc(LEVELS[lv.lv])}` : ''}</div></div>
    <div class="tiles"><div class="tile"><b>${st.streak}</b><span>day streak</span></div><div class="tile"><b>${st.doneCount}</b><span>days done</span></div>
      <div class="tile"><b>${S.problems.filter((x) => x.solved_on).length}</b><span>solved</span></div><div class="tile"><b>${S.problems.filter((x) => (x.reviews_done || 0) >= 3).length}</b><span>mastered</span></div></div>
    <h2>Last 12 weeks</h2><div class="card" style="padding:14px"><div class="heat">${cells.join('')}</div>
      <p class="small mute" style="margin-top:10px">Green is a day studied, red a study day missed.</p></div>
    <h2>Evening reminder</h2><div class="card"><div class="row"><span class="grow"><span class="t">${!p.nudge_enabled ? 'Switched off' : p.nudge_email ? 'On, to ' + esc(p.nudge_email) : 'No email added yet'}</span>
      <div class="small mute">An email at about 8 pm if the day is not done${p.cc_email ? `; ${esc(p.cc_email)} is copied after ${plural(p.cc_after_missed, 'missed day')}` : ''}.</div></span>
      <button class="press plain sm" data-a="editPlan">${p.nudge_email ? 'Change' : 'Add email'}</button></div></div>
    <h2>Mocks (${S.mocks.length})</h2>
    <div class="card">${S.mocks.length ? S.mocks.map((m) => `<button class="row" data-a="editMock" data-id="${m.id}">
      <span class="grow"><span class="t">${esc(m.kind)}${m.topic ? ': ' + esc(m.topic) : ''}</span>
        <div class="small mute">${fmt(m.done_on)}${m.source ? ', ' + esc(m.source) : ''}${m.actions ? '. Fix: ' + esc(m.actions) : ''}</div></span>
      ${m.rating ? `<span class="pill">${m.rating}/5</span>` : ''}</button>`).join('') : '<p class="mute" style="padding:14px 0">No mocks logged yet. The first one is in block 4.</p>'}</div>
    <div style="height:10px"></div><button class="press plain" data-a="addMock">Log a mock</button>`;
  }
  return `${top}<h2>Plans</h2>
  <div class="card">${S.plans.map((x) => `<div class="row"><span class="grow"><span class="t">${esc(x.name)}</span>
      <div class="small mute">${esc((S.profiles.find((u) => u.id === x.owner_id) || {}).display_name || '?')}, started ${short(x.start_date)}</div></span>
      <button class="press plain sm" data-a="editPlan" data-id="${x.id}">Settings</button></div>`).join('') || '<p class="mute" style="padding:14px 0">No plans yet.</p>'}</div>
  <div style="height:10px"></div><button class="press plain" data-a="newPlan">New plan</button>
  <h2>Account</h2>
  <div class="card"><div class="row"><span class="grow"><span class="t">${esc(me.display_name || '')}</span><div class="small mute">${esc(me.email || (store.demo ? 'demo mode' : ''))}</div></span>
    <button class="press plain sm" data-a="editProfile">Edit</button></div></div>
  <div style="height:10px"></div><button class="press plain danger" data-a="signOut">${store.demo ? 'Reset demo data' : 'Sign out'}</button>`;
}

// ------------------------------------------------------------------ edit sheets
const F = {
  session: [['kind', 'Type', 'select', KINDS], ['block', 'Block', 'number'], ['task', 'What to do', 'textarea'], ['extra', 'Extra', 'textarea'], ['done_on', 'Done on', 'date'], ['notes', 'Your notes', 'textarea']],
  problem: [['name', 'Problem', 'text'], ['pattern', 'Pattern', 'text'], ['difficulty', 'Difficulty', 'select', ['', 'Easy', 'Medium', 'Hard']], ['block', 'Block', 'number'],
    ['solved_on', 'Date solved', 'date'], ['rating', 'How it went', 'select', ['', 'Struggled', 'OK', 'Easy']], ['reviews_done', 'Reviews done', 'number'], ['last_review_on', 'Last review', 'date'], ['link', 'Link', 'text'], ['notes', 'Notes', 'textarea']],
  topic: [['category', 'Category', 'text'], ['grp', 'Group', 'text'], ['topic', 'Topic', 'text'], ['learned_on', 'Learned on', 'date'], ['reviews_done', 'Reviews done', 'number'],
    ['last_review_on', 'Last review', 'date'], ['confidence', 'Confidence (1–5)', 'select', ['', 1, 2, 3, 4, 5]], ['notes', 'Notes', 'textarea']],
  mock: [['done_on', 'Date', 'date'], ['kind', 'Type', 'select', ['Coding', 'LLD / Machine Coding', 'System Design', 'Behavioral', 'Full Loop']], ['source', 'Partner / source', 'text'],
    ['topic', 'Problem / topic', 'text'], ['rating', 'Rating (1–5)', 'select', ['', 1, 2, 3, 4, 5]], ['went_wrong', 'What went wrong', 'textarea'], ['actions', 'What to fix', 'textarea']],
  profile: [['display_name', 'Your name', 'text'], ['email', 'Your email', 'text']],
};
const planFields = () => [['name', 'Plan name', 'text'], ['owner_id', 'Who is studying', 'select', S.profiles.map((x) => [x.id, x.display_name])],
  ['start_date', 'Start date', 'date'], ['study_days', 'Study days', 'days'], ['minutes_per_day', 'Minutes per day', 'number'],
  ['nudge_enabled', 'Evening email if the day is not done', 'select', [[true, 'On'], [false, 'Off']]],
  ['nudge_email', 'Send the reminder to (email)', 'email'],
  ['cc_email', 'Also copy this email after missed days (optional)', 'email'],
  ['cc_after_missed', 'Copy them after this many missed days in a row (0 = never)', 'number']];

function openSheet(title, fields, values, onSave, onDelete) { S.sheet = { title, fields, values: { ...values }, onSave, onDelete }; render(); }

function viewSheet() {
  const sh = S.sheet;
  const field = ([k, label, type, opts]) => {
    const v = sh.values[k];
    if (type === 'textarea') return `<label>${label}</label><textarea name="${k}">${esc(v)}</textarea>`;
    if (type === 'select') return `<label>${label}</label><select name="${k}">${opts.map((o) => { const [val, text] = Array.isArray(o) ? o : [o, o === '' ? '—' : o]; return `<option value="${esc(val)}" ${String(v ?? '') === String(val) ? 'selected' : ''}>${esc(text)}</option>`; }).join('')}</select>`;
    if (type === 'days') return `<label>${label}</label><div class="days">${DAY_NAMES.map((d, i) => `<button type="button" class="${(v || []).includes(i + 1) ? 'on' : ''}" data-a="toggleDay" data-d="${i + 1}">${d}</button>`).join('')}</div>`;
    return `<label>${label}</label><input name="${k}" type="${type}" value="${esc(v)}" ${type === 'number' ? 'inputmode="numeric"' : ''}>`;
  };
  return `<div class="sheet-bg" data-a="closeSheetBg"><div class="sheet" role="dialog" aria-label="${esc(sh.title)}">
    <div class="head"><h3 class="grow">${esc(sh.title)}</h3><button class="press plain sm" data-a="closeSheet">Close</button></div>
    ${sh.note ? `<p class="small mute">${esc(sh.note)}</p>` : ''}
    <form data-form="sheet">${sh.fields.map(field).join('')}
      <button class="press">Save</button></form>
    ${sh.onDelete ? `<button class="press plain danger" data-a="sheetDelete">Delete</button>` : ''}
  </div></div>`;
}

function readSheet(form) {
  const out = {};
  for (const [k, , type, opts] of S.sheet.fields) {
    if (type === 'days') { out[k] = [...(S.sheet.values[k] || [])].sort(); continue; }
    let v = form.elements[k].value;
    if (type === 'number') v = v === '' ? null : Number(v);
    else if (type === 'date') v = v || null;
    else if (type === 'select') {
      const raw = (opts.map((o) => (Array.isArray(o) ? o[0] : o))).find((o) => String(o) === v);
      v = raw === '' || raw === undefined ? null : raw;
    } else v = v.trim() === '' ? null : v.trim();
    out[k] = v;
  }
  return out;
}

const editRow = (table, title, fields, id) => {
  const row = S[table].find((x) => x.id === Number(id));
  openSheet(title, fields, row, (v) => save(table, row.id, v),
    async () => { await store.remove(table, row.id); S[table] = S[table].filter((x) => x.id !== row.id); });
};
const addRow = (table, title, fields, defaults) => openSheet(title, fields, defaults, async (v) => {
  S[table].push(...await store.insert(table, [{ plan_id: S.planId, ...defaults, ...v }]));
});

// ------------------------------------------------------------------ actions
const A = {
  authMode() { S.authMode = S.authMode === 'in' ? 'up' : 'in'; },
  tab(d) { S.tab = d.t; S.catchUp = false; window.scrollTo(0, 0); if (d.t === 'journey') setTimeout(() => A.jumpNow(), 60); },
  ptab(d) { S.ptab = d.k; },
  catchUp() { S.catchUp = true; },
  hideHint() { pref.set('padhai-hint', '1'); },
  toggleCat(d) { S.openCat = S.openCat === d.c ? null : d.c; },
  pStatus(d) { S.pStatus = d.k; },
  closeSheet() { S.sheet = null; },
  openDay(d) { S.detail = Number(d.id); },
  closeDay() { S.detail = null; },
  jumpNow() { const el = document.getElementById('now'); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return Promise.resolve(); },
  toggleDay(d) { const v = new Set(S.sheet.values.study_days || []); const n = Number(d.d); v.has(n) ? v.delete(n) : v.add(n); S.sheet.values.study_days = [...v]; },
  focus() { if (!pref.get(timerKey())) pref.set(timerKey(), String(Date.now())); S.focus = true; },
  leaveFocus() { S.focus = false; },
  timerStop() { pref.set(timerKey(), null); S.focus = false; },
  closeParty() { S.party = null; S.tab = 'today'; },

  doneSession: (d) => run(async () => {
    const before = level();
    await save('sessions', Number(d.id), { done_on: today() });
    pref.set(timerKey(), null); S.focus = false; S.catchUp = false;
    const st = L.planStatus(plan(), S.sessions, today()), after = level();
    S.party = { day: S.sessions.find((x) => x.id === Number(d.id)).seq, gain: after.xp - before.xp, streak: st.streak, next: st.next,
      level: after.lv > before.lv ? `Level up: ${after.name}` : after.name };
  }),
  toggleSession: (d) => run(async () => { const s = S.sessions.find((x) => x.id === Number(d.id)); await save('sessions', s.id, { done_on: s.done_on ? null : today() }); }),
  logProblem(d) {
    const x = S.problems.find((p) => p.id === Number(d.id));
    openSheet(x.name, [F.problem[5], F.problem[8], F.problem[9]], { rating: 'OK', link: x.link, notes: x.notes },
      async (v) => { await save('problems', x.id, { ...v, rating: v.rating || 'OK', solved_on: today(), reviews_done: 0, last_review_on: null }); toast('Solved. It will come back for review.', true); });
    S.sheet.note = 'Be honest about how it went: it decides when this problem comes back.';
  },
  reviewProblem: (d) => run(async () => { const x = S.problems.find((p) => p.id === Number(d.id)); await save('problems', x.id, { rating: d.r, reviews_done: (x.reviews_done || 0) + 1, last_review_on: today() }); }),
  reviewTopics: (d) => run(async () => { for (const id of d.ids.split(',').map(Number)) { const x = S.topics.find((t) => t.id === id); await save('topics', id, { reviews_done: (x.reviews_done || 0) + 1, last_review_on: today() }); } }),
  learnTopics: (d) => run(async () => { for (const id of d.ids.split(',').map(Number)) await save('topics', id, { learned_on: today() }); }),

  editSession(d) { S.detail = null; editRow('sessions', 'Edit day', F.session, d.id); },
  editProblem: (d) => editRow('problems', 'Problem', F.problem, d.id),
  editTopic: (d) => editRow('topics', 'Topic', F.topic, d.id),
  editMock: (d) => editRow('mocks', 'Mock', F.mock, d.id),
  addSession() { const last = S.sessions[S.sessions.length - 1]; addRow('sessions', 'New day', F.session.slice(0, 4), { seq: (last ? last.seq : 0) + 1, block: last ? last.block : 1, kind: 'DSA', task: '' }); },
  addProblem() { const st = L.planStatus(plan(), S.sessions, today()); addRow('problems', 'New problem', F.problem.slice(0, 4), { name: '', block: st.next ? st.next.block : null, reviews_done: 0 }); },
  addTopic() { addRow('topics', 'New topic', F.topic.slice(0, 3), { category: S.openCat || '', grp: '', topic: '', sort: 9999, reviews_done: 0 }); },
  addMock() { addRow('mocks', 'Log a mock', F.mock, { done_on: today(), kind: 'Coding' }); },

  editPlan(d) {
    const p = d.id ? S.plans.find((x) => x.id === Number(d.id)) : plan();
    openSheet('Plan settings', planFields(), p, async (v) => { patchRow(S.plans, await store.update('plans', p.id, v)); },
      async () => { await store.remove('plans', p.id); await loadPlans(); });
    S.sheet.note = 'Deleting a plan removes all of its days, problems, topics and mocks.';
  },
  newPlan() {
    const pf = planFields();
    openSheet('New plan', [['template', 'Start from', 'select', [['plan-go-sde2.json', 'Go SDE-2 / SSE-1 interview prep (91 days)'], ['', 'Empty plan']]], ...pf.slice(0, 4), pf[6], pf[7]],
      { template: 'plan-go-sde2.json', name: 'Go interview prep', owner_id: S.user.id, start_date: today(), study_days: [1, 2, 3, 4, 5, 6],
        nudge_email: (S.profiles.find((x) => x.id === S.user.id) || {}).email || '' },
      async (v) => {
        const { template, ...row } = v;
        let tpl = { blocks: [], splits: {}, sessions: [], problems: [], topics: [], minutes_per_day: 120 };
        if (template) { const r = await fetch(template); if (!r.ok) throw new Error('Could not load the plan template'); tpl = L.expandPlan(await r.json()); }
        const [p] = await store.insert('plans', [{ ...row, minutes_per_day: tpl.minutes_per_day || 120, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
          nudge_enabled: true, cc_after_missed: 2, blocks: tpl.blocks, splits: tpl.splits }]);
        const withPlan = (rows, extra = {}) => rows.map((r) => ({ plan_id: p.id, ...extra, ...r }));
        if (tpl.sessions.length) await store.insert('sessions', withPlan(tpl.sessions));
        if (tpl.problems.length) await store.insert('problems', withPlan(tpl.problems, { reviews_done: 0 }));
        if (tpl.topics.length) await store.insert('topics', withPlan(tpl.topics, { reviews_done: 0 }));
        pref.set('padhai-plan', String(p.id));
        await loadPlans(); S.tab = 'today';
      });
  },
  editProfile() {
    const me = S.profiles.find((x) => x.id === S.user.id);
    openSheet('Your details', F.profile, me, async (v) => { patchRow(S.profiles, await store.upsertProfile({ id: me.id, ...v, display_name: v.display_name || me.display_name })); });
  },
  sheetDelete: () => { if (!confirmTwice()) return; const sh = S.sheet; run(async () => { await sh.onDelete(); S.sheet = null; }); },
  signOut: () => store.signOut(),
};
// Two taps to delete instead of a browser confirm dialog.
function confirmTwice() {
  if (S.sheet.armed) return true;
  S.sheet.armed = true; toast('Tap Delete again to confirm.'); return false;
}

// ------------------------------------------------------------------ render + events
function render() {
  const focus = document.activeElement && document.activeElement.name;
  let html;
  if (!S.user) html = viewAuth();
  else {
    const p = plan(), t = today();
    const due = p ? L.dueCounts(S.problems, S.topics, t) : { problems: 0, topics: 0 };
    const st = p ? L.planStatus(p, S.sessions, t) : null;
    const body = !p ? (S.tab === 'me' ? viewMe() : viewEmpty())
      : { today: viewToday, journey: viewJourney, practice: viewPractice, me: viewMe }[S.tab]();
    const tabs = [['today', 'Today', due.problems + due.topics], ['journey', 'Journey'], ['practice', 'Practice'], ['me', 'Me']];
    html = `<div class="top"><span class="brand">Padhai</span>
      ${S.plans.length > 1 ? `<select data-change="plan" aria-label="Choose plan">${S.plans.map((x) => `<option value="${x.id}" ${x.id === S.planId ? 'selected' : ''}>${esc((S.profiles.find((u) => u.id === x.owner_id) || {}).display_name || '?')}: ${esc(x.name)}</option>`).join('')}</select>` : ''}
      ${st ? `<span class="chip ${st.streak ? 'hot' : ''}" title="Day streak">🔥 ${st.streak}</span><span class="chip" title="Level">⚡ Lv ${level().lv}</span>` : ''}</div>
      ${body}
      <nav><div class="in">${tabs.map(([k, label, n]) => `<button class="${S.tab === k ? 'on' : ''}" data-a="tab" data-t="${k}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>${label}${n ? `<span class="dot" aria-label="${n} due">${n}</span>` : ''}</button>`).join('')}</div></nav>`;
    if (p && S.detail && S.sessions.some((x) => x.id === S.detail)) html += viewDay();
    if (p && S.focus && st.next) html += viewFocus();
    if (S.party) html += viewParty();
  }
  if (S.sheet) {
    // keep what is typed in an open sheet when something else re-renders
    const form = document.querySelector('form[data-form="sheet"]');
    if (form) Object.assign(S.sheet.values, readSheet(form));
    html += viewSheet();
  }
  if (S.toast) html += `<div class="toast ${S.toast.ok ? 'ok' : ''}" role="status">${esc(S.toast.msg)}</div>`;
  app.innerHTML = html;
  if (focus) { const el = app.querySelector(`[name="${focus}"]`); if (el) el.focus(); }
  tick();
}

function tick() {
  const el = document.getElementById('timer'), p = plan();
  if (!el || !p) return;
  const total = p.minutes_per_day * 60, left = total - Math.floor((Date.now() - Number(pref.get(timerKey()))) / 1000), a = Math.abs(left);
  el.textContent = `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  document.getElementById('timerLabel').textContent = left < 0 ? 'over, well done' : 'left';
  document.getElementById('arc').style.strokeDashoffset = String(339.3 * Math.min(1, Math.max(0, 1 - left / total)));
}
setInterval(tick, 1000);

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const a = el.dataset.a;
  if (a === 'closeSheetBg' || a === 'closeDayBg') { if (e.target === el) { if (a === 'closeSheetBg') S.sheet = null; else S.detail = null; render(); } return; }
  const r = A[a](el.dataset);
  if (!(r instanceof Promise)) render();
});
app.addEventListener('change', (e) => {
  const k = e.target.dataset.change;
  if (k === 'plan') run(async () => { S.planId = Number(e.target.value); pref.set('padhai-plan', String(S.planId)); await loadPlanData(); });
  if (k === 'pBlock') { S.pBlock = e.target.value; render(); }
});
app.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.form === 'auth') {
    const email = form.elements.email.value.trim(), password = form.elements.password.value;
    run(async () => {
      const user = S.authMode === 'up' ? await store.signUp(email, password) : await store.signIn(email, password);
      if (!user) { S.authMode = 'in'; toast('Account created. Confirm the email Supabase sent you, then sign in.', true); return; }
      await start(user);
    });
  } else if (form.dataset.form === 'sheet') {
    const sh = S.sheet, v = readSheet(form);
    run(async () => { await sh.onSave(v); S.sheet = null; });
  }
});

async function start(user) {
  S.user = user;
  const profiles = await store.all('profiles');
  if (!profiles.some((p) => p.id === user.id)) await store.upsertProfile({ id: user.id, display_name: (user.email || 'You').split('@')[0], email: user.email || null });
  await loadPlans();
}

(async () => {
  try {
    store = CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY ? await supabaseStore() : localStore();
    const user = await store.init();
    if (user) await start(user);
  } catch (e) { console.error(e); S.toast = { msg: e.message || String(e) }; }
  render();
})();

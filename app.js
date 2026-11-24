// Padhai — study plan tracker. No build step: plain ES modules talking to Supabase.
import * as L from './logic.js';
import { CONFIG } from './config.js';

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => L.iso(new Date());
const fmt = (s, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => (s ? L.parse(s).toLocaleDateString('en-IN', opts) : '—');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const KINDS = ['DSA', 'Go', 'Backend', 'LLD', 'Design', 'Mock', 'Review'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ------------------------------------------------------------------ data stores
// Both stores expose the same small interface, so the rest of the app does not care which is in use.
function localStore() {
  const KEY = 'padhai-demo';
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { db = null; }
  db = db || { seq: 1, t: { profiles: [{ id: 'demo', display_name: 'You', email: '' }], plans: [], sessions: [], problems: [], topics: [], mocks: [] } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* storage blocked: keep going in memory */ } };
  return {
    demo: true,
    async init() { return { id: 'demo', email: '' }; },
    async signIn() {}, async signUp() {},
    async signOut() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } location.reload(); },
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
  tab: 'today', openBlock: null, openCat: null, pStatus: 'all', pBlock: '', sheet: null, toast: null, authMode: 'in', busy: false };
const plan = () => S.plans.find((p) => p.id === S.planId) || null;
const pref = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } } };

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

// ------------------------------------------------------------------ views
function viewAuth() {
  const up = S.authMode === 'up';
  return `<div class="top"><span class="brand">Padhai</span></div>
  <div class="card hero"><h3>${up ? 'Create your account' : 'Sign in'}</h3>
    <form data-form="auth">
      <label>Email</label><input name="email" type="email" autocomplete="email" required>
      <label>Password</label><input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="6" required>
      <div style="height:14px"></div>
      <button class="btn primary block">${up ? 'Create account' : 'Sign in'}</button>
    </form>
    <div style="height:10px"></div>
    <button class="btn block" data-a="authMode">${up ? 'I already have an account' : 'Create account'}</button>
  </div>`;
}

function viewEmpty() {
  return `<div class="card hero"><div class="big">No study plan yet</div>
    <p class="mute">Load the 13-block Go interview plan, pick who is studying and the start date. You can edit every session afterwards.</p>
    <button class="btn primary block" data-a="newPlan">Create a plan</button></div>`;
}

function banners(st) {
  const out = [];
  if (store.demo) out.push(`<div class="banner info">Demo mode: nothing is saved to Supabase yet. Fill in config.js to go live.</div>`);
  if (!st) return out.join('');
  if (st.finished) out.push(`<div class="banner good">Plan complete. Keep clearing reviews while you interview.</div>`);
  else if (!st.started) out.push(`<div class="banner info">Starts ${fmt(plan().start_date)}. You can begin early.</div>`);
  else if (st.behind > 0) out.push(`<div class="banner bad"><b>${plural(st.behind, 'session')} behind.</b> Finish date has slipped ${plural(st.slipDays, 'day')} to ${fmt(st.projectedFinish)}. Do today's session; do not try to double up.</div>`);
  else if (st.todayIsStudy && !st.doneToday) out.push(`<div class="banner warn">Today's session is still open. ${st.streak ? `Your ${st.streak}-day streak ends tonight if you skip it.` : 'Start the streak today.'}</div>`);
  else if (st.doneToday) out.push(`<div class="banner good">Done for today. ${st.streak > 1 ? `${st.streak} days in a row.` : ''}</div>`);
  else out.push(`<div class="banner info">Rest day. Reviews below are optional.</div>`);
  return out.join('');
}

function timerHtml(p) {
  const started = Number(pref.get('padhai-timer-' + p.id));
  if (!started) return `<button class="btn block" data-a="timerStart">Start ${p.minutes_per_day}-minute timer</button>`;
  return `<div class="row"><div class="grow"><div class="timer" id="timer">--:--</div><div class="small mute">left in this session</div></div>
    <button class="btn sm" data-a="timerStop">Stop</button></div>`;
}

function sessionCard(s, p, st) {
  const blk = (p.blocks || []).find((b) => b.num === s.block);
  const split = (p.splits || {})[s.kind];
  return `<div class="card hero">
    <div class="row"><span class="pill k-${esc(s.kind)}">${esc(s.kind)}</span>
      <span class="small mute grow">Day ${s.seq} of ${st.total} · Block ${s.block}${blk ? ' · ' + esc(blk.dsa) : ''}</span>
      <button class="btn sm" data-a="editSession" data-id="${s.id}">Edit</button></div>
    <div class="big" style="margin:10px 0 6px">${esc(s.task)}</div>
    ${s.extra ? `<div class="small mute">${esc(s.extra)}</div>` : ''}
    ${split ? `<details style="margin-top:10px"><summary class="small" style="color:var(--accent)">How to spend the ${p.minutes_per_day} minutes ▾</summary><div class="small mute" style="margin-top:6px">${esc(split)}</div></details>` : ''}
    <div style="height:12px"></div>
    ${timerHtml(p)}
    <div style="height:8px"></div>
    <button class="btn primary block" data-a="doneSession" data-id="${s.id}">Mark Day ${s.seq} done</button>
  </div>`;
}

function viewToday() {
  const p = plan(), t = today(), st = L.planStatus(p, S.sessions, t);
  const dueP = S.problems.filter((x) => L.problemStatus(x, t).status === 'due');
  const dueT = S.topics.filter((x) => L.topicStatus(x, t).status === 'due');
  const pct = st.total ? Math.round((st.doneCount / st.total) * 100) : 0;
  const s = st.next;
  const showNext = s && (!st.doneToday || S.catchUp);
  const todo = s ? S.problems.filter((x) => x.block === s.block && !x.solved_on) : [];
  const groups = {};
  for (const x of dueT) (groups[`${x.category} · ${x.grp}`] ||= []).push(x);

  return `${banners(st)}
  <div class="stats">
    <div class="stat ${st.streak ? 'good' : ''}"><b>${st.streak}</b><span>day streak</span></div>
    <div class="stat ${st.behind ? 'bad' : ''}"><b>${st.behind}</b><span>behind</span></div>
    <div class="stat ${dueP.length + dueT.length ? 'bad' : ''}"><b>${dueP.length + dueT.length}</b><span>reviews due</span></div>
  </div>
  <div class="card"><div class="row"><div class="grow"><b>${st.doneCount} of ${st.total}</b> <span class="mute">sessions · ${pct}%</span></div>
    <span class="small mute">ends ${fmt(st.projectedFinish, { day: 'numeric', month: 'short' })}</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div></div>
  ${showNext ? sessionCard(s, p, st) : ''}
  ${st.doneToday && s && !S.catchUp ? `<button class="btn block" data-a="catchUp">${st.behind ? 'Catch up: do the next session too' : 'Do the next session early'}</button>` : ''}

  ${dueP.length ? `<h2>Problems to re-solve (${dueP.length})</h2><div class="card list">${dueP.map((x) => `
    <div class="item"><div class="grow"><div class="t">${esc(x.name)}</div>
      <div class="small mute">${esc(x.pattern || '')} · review ${(x.reviews_done || 0) + 1} of 3 · was ${esc(x.rating || 'OK')}</div>
      <div class="row" style="margin-top:6px;gap:6px">
        ${['Struggled', 'OK', 'Easy'].map((r) => `<button class="btn sm" data-a="reviewProblem" data-id="${x.id}" data-r="${r}">${r}</button>`).join('')}
      </div></div></div>`).join('')}</div>
    <p class="small mute">Re-solve from a blank file, then tap how it went.</p>` : ''}

  ${dueT.length ? `<h2>Topics to revise (${dueT.length})</h2><div class="card list">${Object.entries(groups).map(([g, xs]) => `
    <div class="item"><div class="grow"><div class="t">${esc(g)}</div><div class="small mute">${esc(xs.map((x) => x.topic).join(', '))}</div></div>
      <button class="btn sm" data-a="reviewTopics" data-ids="${xs.map((x) => x.id).join(',')}">Revised</button></div>`).join('')}</div>` : ''}

  ${showNext && todo.length ? `<h2>Block ${s.block} problems left (${todo.length})</h2><div class="card list">${todo.map((x) => `
    <div class="item"><div class="grow"><div class="t">${esc(x.name)}</div><div class="small mute">${esc(x.pattern || '')} · ${esc(x.difficulty || '')}</div></div>
      <button class="btn sm" data-a="logProblem" data-id="${x.id}">Solved</button></div>`).join('')}</div>` : ''}`;
}

function viewPlan() {
  const p = plan(), t = today(), st = L.planStatus(p, S.sessions, t);
  const nums = [...new Set(S.sessions.map((s) => s.block))].sort((a, b) => a - b);
  return `<div class="card"><div class="row"><div class="grow"><b>${esc(p.name)}</b>
      <div class="small mute">Started ${fmt(p.start_date)} · planned end ${fmt(st.plannedFinish)}${st.slipDays ? ` · now ${fmt(st.projectedFinish)}` : ''}</div></div>
      <button class="btn sm" data-a="editPlan">Edit</button></div></div>
  ${nums.map((n) => {
    const ss = S.sessions.filter((s) => s.block === n), d = ss.filter((s) => s.done_on).length;
    const b = (p.blocks || []).find((x) => x.num === n) || {};
    const open = S.openBlock === n || (S.openBlock === null && st.next && st.next.block === n);
    return `<div class="card"><button class="row" style="width:100%;text-align:left" data-a="toggleBlock" data-n="${n}">
        <div class="grow"><b>Block ${n}</b> <span class="small mute">${d}/${ss.length}</span>
          <div class="small mute">${esc(b.dsa || '')}${b.deep ? ' · ' + esc(b.deep) : ''}</div></div><span class="mute">${open ? '▴' : '▾'}</span></button>
      <div class="bar"><i style="width:${ss.length ? (d / ss.length) * 100 : 0}%"></i></div>
      ${open ? `<div class="list" style="margin-top:8px">${ss.map((s) => `
        <div class="item ${s.done_on ? 'done' : ''}">
          <button class="check ${s.done_on ? 'on' : ''}" data-a="toggleSession" data-id="${s.id}" aria-label="Mark day ${s.seq} ${s.done_on ? 'not done' : 'done'}">${s.done_on ? '✓' : ''}</button>
          <button class="grow" style="text-align:left" data-a="editSession" data-id="${s.id}">
            <div class="t">${esc(s.task)}</div>
            <div class="small mute">Day ${s.seq} · <span class="pill k-${esc(s.kind)}">${esc(s.kind)}</span>${s.done_on ? ' · done ' + fmt(s.done_on) : ''}</div></button>
        </div>`).join('')}
        ${b.build ? `<div class="small mute" style="padding-top:8px">Build / design: ${esc(b.build)}</div>` : ''}</div>` : ''}
    </div>`;
  }).join('')}
  <button class="btn block" data-a="addSession">Add a session</button>`;
}

function viewProblems() {
  const t = today();
  const rows = S.problems.map((x) => ({ x, s: L.problemStatus(x, t) }));
  const count = (k) => rows.filter((r) => r.s.status === k).length;
  const shown = rows.filter((r) => (S.pStatus === 'all' || r.s.status === S.pStatus) && (!S.pBlock || String(r.x.block) === S.pBlock));
  const blocks = [...new Set(S.problems.map((x) => x.block).filter(Boolean))].sort((a, b) => a - b);
  const chip = (k, label) => `<button class="chip ${S.pStatus === k ? 'on' : ''}" data-a="pStatus" data-k="${k}">${label}</button>`;
  return `<div class="chips">${chip('all', `All ${rows.length}`)}${chip('todo', `To do ${count('todo')}`)}${chip('due', `Due ${count('due')}`)}${chip('scheduled', `Scheduled ${count('scheduled')}`)}${chip('mastered', `Mastered ${count('mastered')}`)}</div>
  <div class="row" style="margin-bottom:10px"><select data-change="pBlock" aria-label="Filter by block"><option value="">All blocks</option>
    ${blocks.map((b) => `<option value="${b}" ${String(b) === S.pBlock ? 'selected' : ''}>Block ${b}</option>`).join('')}</select>
    <button class="btn" data-a="addProblem">Add</button></div>
  <div class="card list">${shown.length ? shown.map(({ x, s }) => `
    <button class="item" style="text-align:left;width:100%" data-a="editProblem" data-id="${x.id}">
      <div class="grow"><div class="t">${esc(x.name)}</div>
        <div class="small mute">B${x.block || '–'} · ${esc(x.pattern || '')} · ${esc(x.difficulty || '')}${s.next ? ' · next ' + fmt(s.next, { day: 'numeric', month: 'short' }) : ''}</div></div>
      ${s.status === 'todo' ? '' : `<span class="pill s-${s.status}">${s.status}</span>`}</button>`).join('') : '<p class="mute">Nothing here.</p>'}</div>`;
}

function viewTopics() {
  const t = today(), cats = [...new Set(S.topics.map((x) => x.category))];
  return cats.map((c) => {
    const xs = S.topics.filter((x) => x.category === c);
    const started = xs.filter((x) => x.learned_on).length, mastered = xs.filter((x) => L.topicStatus(x, t).status === 'mastered').length;
    const open = S.openCat === c, grps = [...new Set(xs.map((x) => x.grp))];
    return `<div class="card"><button class="row" style="width:100%;text-align:left" data-a="toggleCat" data-c="${esc(c)}">
        <div class="grow"><b>${esc(c)}</b> <span class="small mute">${started}/${xs.length} learned · ${mastered} mastered</span></div><span class="mute">${open ? '▴' : '▾'}</span></button>
      <div class="bar"><i style="width:${(started / xs.length) * 100}%"></i></div>
      ${open ? grps.map((g) => {
        const gs = xs.filter((x) => x.grp === g), fresh = gs.filter((x) => !x.learned_on);
        return `<div class="row" style="margin-top:12px"><div class="grow small" style="color:var(--accent)">${esc(g)}</div>
          ${fresh.length ? `<button class="btn sm" data-a="learnTopics" data-ids="${fresh.map((x) => x.id).join(',')}">Learned all today</button>` : ''}</div>
          <div class="list">${gs.map((x) => { const s = L.topicStatus(x, t); return `
            <button class="item" style="text-align:left;width:100%" data-a="editTopic" data-id="${x.id}">
              <div class="grow"><div class="t">${esc(x.topic)}</div>${s.next ? `<div class="small mute">next review ${fmt(s.next, { day: 'numeric', month: 'short' })}</div>` : ''}</div>
              ${s.status === 'todo' ? '' : `<span class="pill s-${s.status}">${s.status}</span>`}</button>`; }).join('')}</div>`;
      }).join('') : ''}</div>`;
  }).join('') + `<button class="btn block" data-a="addTopic">Add a topic</button>`;
}

function viewMore() {
  const me = S.profiles.find((x) => x.id === S.user.id) || {};
  return `<h2>Mocks (${S.mocks.length})</h2>
  <div class="card list">${S.mocks.length ? S.mocks.map((m) => `
    <button class="item" style="text-align:left;width:100%" data-a="editMock" data-id="${m.id}">
      <div class="grow"><div class="t">${esc(m.kind)}${m.topic ? ' · ' + esc(m.topic) : ''}</div>
        <div class="small mute">${fmt(m.done_on)}${m.source ? ' · ' + esc(m.source) : ''}${m.actions ? ' · fix: ' + esc(m.actions) : ''}</div></div>
      ${m.rating ? `<span class="pill">${m.rating}/5</span>` : ''}</button>`).join('') : '<p class="mute">No mocks logged yet. The first one is in block 4.</p>'}</div>
  <button class="btn block" data-a="addMock">Log a mock</button>
  <h2>Plans</h2>
  <div class="card list">${S.plans.map((p) => `
    <div class="item"><div class="grow"><div class="t">${esc(p.name)}</div>
      <div class="small mute">${esc((S.profiles.find((x) => x.id === p.owner_id) || {}).display_name || '?')} · reminder ${!p.nudge_enabled ? 'off' : p.nudge_email ? 'to ' + esc(p.nudge_email) : 'on, but no email set'}</div></div>
      <button class="btn sm" data-a="editPlan" data-id="${p.id}">Settings</button></div>`).join('')}</div>
  <button class="btn block" data-a="newPlan">New plan</button>
  <h2>Account</h2>
  <div class="card"><div class="row"><div class="grow"><b>${esc(me.display_name || '')}</b><div class="small mute">${esc(me.email || (store.demo ? 'demo mode' : ''))}</div></div>
    <button class="btn sm" data-a="editProfile">Edit</button></div></div>
  <button class="btn block danger" data-a="signOut">${store.demo ? 'Reset demo data' : 'Sign out'}</button>`;
}

// ------------------------------------------------------------------ edit sheets
const F = {
  session: [['kind', 'Type', 'select', KINDS], ['block', 'Block', 'number'], ['task', 'Task', 'textarea'], ['extra', 'Extra', 'textarea'], ['done_on', 'Done on', 'date'], ['notes', 'Notes', 'textarea']],
  problem: [['name', 'Problem', 'text'], ['pattern', 'Pattern', 'text'], ['difficulty', 'Difficulty', 'select', ['', 'Easy', 'Medium', 'Hard']], ['block', 'Block', 'number'],
    ['solved_on', 'Date solved', 'date'], ['rating', 'How it went', 'select', ['', 'Struggled', 'OK', 'Easy']], ['reviews_done', 'Reviews done', 'number'], ['last_review_on', 'Last review', 'date'], ['link', 'Link', 'text'], ['notes', 'Notes', 'textarea']],
  topic: [['category', 'Category', 'text'], ['grp', 'Group', 'text'], ['topic', 'Topic', 'text'], ['learned_on', 'Learned on', 'date'], ['reviews_done', 'Reviews done', 'number'],
    ['last_review_on', 'Last review', 'date'], ['confidence', 'Confidence (1–5)', 'select', ['', 1, 2, 3, 4, 5]], ['notes', 'Notes', 'textarea']],
  mock: [['done_on', 'Date', 'date'], ['kind', 'Type', 'select', ['Coding', 'LLD / Machine Coding', 'System Design', 'Behavioral', 'Full Loop']], ['source', 'Partner / source', 'text'],
    ['topic', 'Problem / topic', 'text'], ['rating', 'Rating (1–5)', 'select', ['', 1, 2, 3, 4, 5]], ['went_wrong', 'What went wrong', 'textarea'], ['actions', 'What to fix', 'textarea']],
  profile: [['display_name', 'Your name', 'text'], ['email', 'Email for reminders', 'text']],
};
const planFields = () => [['name', 'Plan name', 'text'], ['owner_id', 'Who is studying', 'select', S.profiles.map((x) => [x.id, x.display_name])],
  ['start_date', 'Start date', 'date'], ['study_days', 'Study days', 'days'], ['minutes_per_day', 'Minutes per day', 'number'],
  ['nudge_enabled', 'Evening email if the session is not done', 'select', [[true, 'On'], [false, 'Off']]],
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
    <div class="row"><h3 class="grow">${esc(sh.title)}</h3><button class="btn sm" data-a="closeSheet">Close</button></div>
    ${sh.note ? `<p class="small mute">${esc(sh.note)}</p>` : ''}
    <form data-form="sheet">${sh.fields.map(field).join('')}
      <div style="height:16px"></div><button class="btn primary block">Save</button></form>
    ${sh.onDelete ? `<div style="height:8px"></div><button class="btn block danger" data-a="sheetDelete">Delete</button>` : ''}
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
const addRow = (table, title, fields, defaults, after) => openSheet(title, fields, defaults, async (v) => {
  S[table].push(...await store.insert(table, [{ plan_id: S.planId, ...defaults, ...v }])); if (after) after();
});

// ------------------------------------------------------------------ actions
const A = {
  authMode() { S.authMode = S.authMode === 'in' ? 'up' : 'in'; },
  tab(d) { S.tab = d.t; S.catchUp = false; window.scrollTo(0, 0); },
  catchUp() { S.catchUp = true; },
  toggleBlock(d) { const n = Number(d.n); S.openBlock = S.openBlock === n ? -1 : n; },
  toggleCat(d) { S.openCat = S.openCat === d.c ? null : d.c; },
  pStatus(d) { S.pStatus = d.k; },
  closeSheet() { S.sheet = null; },
  toggleDay(d) { const v = new Set(S.sheet.values.study_days || []); const n = Number(d.d); v.has(n) ? v.delete(n) : v.add(n); S.sheet.values.study_days = [...v]; },
  timerStart() { pref.set('padhai-timer-' + S.planId, String(Date.now())); },
  timerStop() { pref.set('padhai-timer-' + S.planId, null); },

  doneSession: (d) => run(async () => { await save('sessions', Number(d.id), { done_on: today() }); pref.set('padhai-timer-' + S.planId, null); S.catchUp = false; toast('Session done. Nice.', true); }),
  toggleSession: (d) => run(async () => { const s = S.sessions.find((x) => x.id === Number(d.id)); await save('sessions', s.id, { done_on: s.done_on ? null : today() }); }),
  logProblem(d) {
    const x = S.problems.find((p) => p.id === Number(d.id));
    openSheet(x.name, [F.problem[5], F.problem[8], F.problem[9]], { rating: 'OK', link: x.link, notes: x.notes },
      (v) => save('problems', x.id, { ...v, rating: v.rating || 'OK', solved_on: today(), reviews_done: 0, last_review_on: null }));
    S.sheet.note = 'Be honest about how it went: it sets when this problem comes back.';
  },
  reviewProblem: (d) => run(async () => { const x = S.problems.find((p) => p.id === Number(d.id)); await save('problems', x.id, { rating: d.r, reviews_done: (x.reviews_done || 0) + 1, last_review_on: today() }); }),
  reviewTopics: (d) => run(async () => { for (const id of d.ids.split(',').map(Number)) { const x = S.topics.find((t) => t.id === id); await save('topics', id, { reviews_done: (x.reviews_done || 0) + 1, last_review_on: today() }); } }),
  learnTopics: (d) => run(async () => { for (const id of d.ids.split(',').map(Number)) await save('topics', id, { learned_on: today() }); }),

  editSession: (d) => editRow('sessions', 'Session', F.session, d.id),
  editProblem: (d) => editRow('problems', 'Problem', F.problem, d.id),
  editTopic: (d) => editRow('topics', 'Topic', F.topic, d.id),
  editMock: (d) => editRow('mocks', 'Mock', F.mock, d.id),
  addSession() { const last = S.sessions[S.sessions.length - 1]; addRow('sessions', 'New session', F.session.slice(0, 4), { seq: (last ? last.seq : 0) + 1, block: last ? last.block : 1, kind: 'DSA', task: '' }); },
  addProblem() { const st = L.planStatus(plan(), S.sessions, today()); addRow('problems', 'New problem', F.problem.slice(0, 4), { name: '', block: st.next ? st.next.block : null, reviews_done: 0 }); },
  addTopic() { addRow('topics', 'New topic', F.topic.slice(0, 3), { category: S.openCat || '', grp: '', topic: '', sort: 9999, reviews_done: 0 }); },
  addMock() { addRow('mocks', 'Log a mock', F.mock, { done_on: today(), kind: 'Coding' }); },

  editPlan(d) {
    const p = d.id ? S.plans.find((x) => x.id === Number(d.id)) : plan();
    openSheet('Plan settings', planFields(), p, async (v) => { patchRow(S.plans, await store.update('plans', p.id, v)); },
      async () => { await store.remove('plans', p.id); await loadPlans(); });
    S.sheet.note = 'Deleting a plan removes all of its sessions, problems, topics and mocks.';
  },
  newPlan() {
    const pf = planFields();
    openSheet('New plan', [['template', 'Start from', 'select', [['plan-go-sde2.json', 'Go SDE-2 / SSE-1 interview prep (13 blocks)'], ['', 'Empty plan']]], ...pf.slice(0, 4), pf[6], pf[7]],
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
    const body = !p ? banners(null) + (S.tab === 'more' ? viewMore() : viewEmpty())
      : { today: viewToday, plan: viewPlan, problems: viewProblems, topics: viewTopics, more: viewMore }[S.tab]();
    const tabs = [['today', '◎', 'Today', due.problems + due.topics], ['plan', '▤', 'Plan'], ['problems', '⌘', 'Problems'], ['topics', '❖', 'Topics'], ['more', '⋯', 'More']];
    html = `<div class="top"><span class="brand">Padhai</span>
      ${S.plans.length ? `<select data-change="plan" aria-label="Choose plan">${S.plans.map((x) => `<option value="${x.id}" ${x.id === S.planId ? 'selected' : ''}>${esc(x.name)} — ${esc((S.profiles.find((u) => u.id === x.owner_id) || {}).display_name || '?')}</option>`).join('')}</select>` : ''}</div>
      ${body}
      <nav><div class="in">${tabs.map(([k, icon, label, n]) => `<button class="${S.tab === k ? 'on' : ''}" data-a="tab" data-t="${k}"><b aria-hidden="true">${icon}</b>${label}${n ? `<span class="dot" aria-label="${n} due">${n}</span>` : ''}</button>`).join('')}</div></nav>`;
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
  const left = p.minutes_per_day * 60 - Math.floor((Date.now() - Number(pref.get('padhai-timer-' + p.id))) / 1000);
  const a = Math.abs(left);
  el.textContent = `${left < 0 ? '+' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  el.style.color = left < 0 ? 'var(--good)' : '';
}
setInterval(tick, 1000);

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  if (el.dataset.a === 'closeSheetBg') { if (e.target === el) { S.sheet = null; render(); } return; }
  const r = A[el.dataset.a](el.dataset);
  if (!(r instanceof Promise)) render();
});
app.addEventListener('change', (e) => {
  const k = e.target.dataset.change;
  if (k === 'plan') run(async () => { S.planId = Number(e.target.value); pref.set('padhai-plan', String(S.planId)); S.openBlock = null; await loadPlanData(); });
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

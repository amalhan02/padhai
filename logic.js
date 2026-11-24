// Pure scheduling logic, shared by the app (browser) and the nightly email script (Node).
// Dates are 'YYYY-MM-DD' strings throughout, so they compare correctly as text.

const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
export const dow = (s) => { const d = parse(s).getDay(); return d === 0 ? 7 : d; }; // 1 = Mon … 7 = Sun
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);

/** Today's date in a given IANA time zone (the email script runs in UTC). */
export const todayIn = (tz, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export const isStudyDay = (plan, s) => (plan.study_days || []).includes(dow(s));

// ---- spaced review -------------------------------------------------------------------------
const BASE = { Struggled: 2, OK: 4, Easy: 7 };

/** A problem is todo → scheduled/due (3 reviews) → mastered. Gaps grow after each review. */
export function problemStatus(p, today) {
  if (!p.solved_on) return { status: 'todo', next: null };
  const n = p.reviews_done || 0;
  if (n >= 3) return { status: 'mastered', next: null };
  const base = BASE[p.rating] || BASE.OK;
  const next = p.last_review_on
    ? addDays(p.last_review_on, base * [1, 2, 4][n])   // gap since the last review
    : addDays(p.solved_on, base * [1, 3, 7][n]);        // no review date logged: count from solve date
  return { status: next <= today ? 'due' : 'scheduled', next };
}

/** A topic is todo → scheduled/due (3 reviews at about +3, +10, +30 days) → mastered. */
export function topicStatus(t, today) {
  if (!t.learned_on) return { status: 'todo', next: null };
  const n = t.reviews_done || 0;
  if (n >= 3) return { status: 'mastered', next: null };
  const next = t.last_review_on
    ? addDays(t.last_review_on, [3, 7, 20][n])
    : addDays(t.learned_on, [3, 10, 30][n]);
  return { status: next <= today ? 'due' : 'scheduled', next };
}

// ---- plan progress -------------------------------------------------------------------------
/** The date of the n-th study day on or after `from` (n ≥ 1), or null if the plan has no study days. */
export function nthStudyDay(plan, from, n) {
  if (!(plan.study_days || []).length || n < 1) return null;
  let d = from;
  for (let guard = 0; guard < 5000; guard++) {
    if (isStudyDay(plan, d) && --n === 0) return d;
    d = addDays(d, 1);
  }
  return null;
}

export function planStatus(plan, sessions, today) {
  const sorted = [...sessions].sort((a, b) => a.seq - b.seq);
  const done = sorted.filter((s) => s.done_on);
  const next = sorted.find((s) => !s.done_on) || null;
  const total = sorted.length;
  const doneDays = new Set(done.map((s) => s.done_on));
  const started = today >= plan.start_date;
  const doneToday = doneDays.has(today);
  const todayIsStudy = started && isStudyDay(plan, today);

  // sessions that should already be finished: one per study day before today
  let expected = 0;
  for (let d = plan.start_date; d < today && expected < total; d = addDays(d, 1)) if (isStudyDay(plan, d)) expected++;
  const behind = Math.max(0, expected - done.length);

  // streak: consecutive study days with a session done (today only counts once it is done)
  let streak = 0;
  for (let d = doneToday ? today : addDays(today, -1); d >= plan.start_date; d = addDays(d, -1)) {
    if (doneDays.has(d)) streak++;
    else if (isStudyDay(plan, d)) break;
  }

  // missed: consecutive study days, up to and including today, with nothing done
  let missed = 0;
  if (started) {
    for (let d = today; d >= plan.start_date; d = addDays(d, -1)) {
      if (doneDays.has(d)) break;
      if (isStudyDay(plan, d)) missed++;
    }
  }

  const remaining = total - done.length;
  const from = doneToday ? addDays(today, 1) : (today > plan.start_date ? today : plan.start_date);
  const projectedFinish = remaining > 0 ? nthStudyDay(plan, from, remaining)
    : (done.length ? done.map((s) => s.done_on).sort().pop() : null);
  const plannedFinish = total ? nthStudyDay(plan, plan.start_date, total) : null;
  const slipDays = projectedFinish && plannedFinish ? Math.max(0, daysBetween(plannedFinish, projectedFinish)) : 0;

  return { total, doneCount: done.length, next, started, todayIsStudy, doneToday, behind, streak, missed,
    projectedFinish, plannedFinish, slipDays, finished: total > 0 && remaining === 0 };
}

export function dueCounts(problems, topics, today) {
  return {
    problems: problems.filter((p) => problemStatus(p, today).status === 'due').length,
    topics: topics.filter((t) => topicStatus(t, today).status === 'due').length,
  };
}

// ---- plan templates ------------------------------------------------------------------------
/**
 * Expand a compact plan template (see plan-go-sde2.json) into rows for the database.
 * Each block lists its days as [kind, task, extra?] and its problems as [name, pattern, E|M|H, day in block];
 * topics are [category, group, [topic, …]].
 */
export function expandPlan(tpl) {
  const DIFF = { E: 'Easy', M: 'Medium', H: 'Hard' };
  const out = { minutes_per_day: tpl.minutes_per_day || 120, splits: tpl.splits || {}, blocks: [], sessions: [], problems: [], topics: [] };
  (tpl.blocks || []).forEach((b, i) => {
    const num = i + 1, first = out.sessions.length;
    out.blocks.push({ num, dsa: b.dsa, deep: b.deep, build: b.build, job: b.job });
    for (const [kind, task, extra] of b.days || []) out.sessions.push({ seq: out.sessions.length + 1, block: num, kind, task, extra: extra || null });
    for (const [name, pattern, d, dayInBlock] of b.problems || []) out.problems.push({ name, pattern, difficulty: DIFF[d] || null, block: num, day: dayInBlock ? first + dayInBlock : null });
  });
  for (const [category, grp, items] of tpl.topics || []) for (const topic of items) out.topics.push({ category, grp, topic, sort: out.topics.length + 1 });
  return out;
}

// ---- nightly email -------------------------------------------------------------------------
/**
 * Decide whether tonight's reminder goes out for a plan, and to whom.
 * Returns null when no email is needed (rest day, already done, finished, reminders off…).
 */
export function nudgeDecision({ plan, sessions, problems = [], topics = [], profiles, today, appUrl = '' }) {
  if (!plan.nudge_enabled) return null;
  const st = planStatus(plan, sessions, today);
  if (!st.started || st.finished || !st.next || !st.todayIsStudy || st.doneToday) return null;
  // Addresses come from the plan's own settings (typed in the app); the owner's profile email is the fallback.
  const owner = profiles.find((p) => p.id === plan.owner_id) || {};
  const to = (plan.nudge_email || owner.email || '').trim();
  if (!to) return null;

  const ccAfter = plan.cc_after_missed || 0;
  const ccTo = (plan.cc_email || '').trim();
  const cc = ccAfter > 0 && st.missed >= ccAfter && ccTo && ccTo !== to ? [ccTo] : [];
  const due = dueCounts(problems, topics, today);
  const s = st.next;
  const lines = [
    `Hi ${owner.display_name || 'there'},`,
    '',
    `Today's session isn't marked done yet: Day ${s.seq} of ${st.total} (${s.kind}).`,
    `  ${s.task}`,
    '',
    st.missed > 1 ? `That makes ${st.missed} study days in a row without a session.` : null,
    st.behind > 0 ? `You are ${st.behind} session${st.behind === 1 ? '' : 's'} behind; the finish date has slipped to ${st.projectedFinish}.` : null,
    due.problems + due.topics > 0 ? `Reviews waiting: ${due.problems} problem${due.problems === 1 ? '' : 's'}, ${due.topics} topic${due.topics === 1 ? '' : 's'}.` : null,
    st.streak > 0 ? `Your streak is ${st.streak} day${st.streak === 1 ? '' : 's'}. Do the session tonight to keep it.` : null,
    '',
    'Two hours. Open the app and start the timer.',
    appUrl || null,
  ].filter((l) => l !== null);
  return {
    to,
    cc,
    subject: st.missed > 1 ? `${st.missed} days missed — Day ${s.seq} is still waiting` : `Day ${s.seq} not done yet: ${s.kind}`,
    text: lines.join('\n'),
  };
}

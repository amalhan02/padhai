import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from './logic.js';

const plan = { id: 1, owner_id: 'w', start_date: '2026-11-30', study_days: [1, 2, 3, 4, 5, 6],
  nudge_enabled: true, cc_after_missed: 2, nudge_email: 'w@example.com', cc_email: 'h@example.com' };
const mk = (n, doneOn = {}) => Array.from({ length: n }, (_, i) =>
  ({ seq: i + 1, block: 1, kind: 'DSA', task: `task ${i + 1}`, done_on: doneOn[i + 1] || null }));
const profiles = [{ id: 'w', display_name: 'Wife', email: 'w@example.com' }, { id: 'h', display_name: 'Me', email: 'h@example.com' }];

test('the bundled plan template expands to 91 sessions, 102 problems and 178 topics', async () => {
  const { readFile } = await import('node:fs/promises');
  const plan = L.expandPlan(JSON.parse(await readFile(new URL('./plan-go-sde2.json', import.meta.url), 'utf8')));
  assert.equal(plan.sessions.length, 91);
  assert.equal(plan.problems.length, 102);
  assert.equal(plan.topics.length, 178);
  assert.equal(plan.blocks.length, 13);
  assert.deepEqual(plan.sessions[7], { seq: 8, block: 2, kind: 'DSA', task: 'Two Pointers — 3 problems', extra: 'Clear due reviews first' });
  assert.deepEqual(plan.problems[0], { name: 'Two Sum', pattern: 'Hash Maps', difficulty: 'Easy', block: 1 });
});

test('date helpers', () => {
  assert.equal(L.addDays('2026-11-30', 6), '2026-12-06');
  assert.equal(L.dow('2026-11-30'), 1);            // Monday
  assert.equal(L.dow('2026-12-06'), 7);            // Sunday
  assert.equal(L.todayIn('Asia/Kolkata', new Date('2026-12-01T20:00:00Z')), '2026-12-02');
});

test('problem review gaps', () => {
  const p = { solved_on: '2026-11-30', rating: 'Struggled', reviews_done: 0 };
  assert.deepEqual(L.problemStatus(p, '2026-12-01'), { status: 'scheduled', next: '2026-12-02' });
  assert.equal(L.problemStatus(p, '2026-12-02').status, 'due');
  assert.equal(L.problemStatus({ ...p, rating: 'Easy', reviews_done: 2 }, '2026-12-01').next, '2027-01-18');
  assert.equal(L.problemStatus({ ...p, rating: 'OK', reviews_done: 1, last_review_on: '2026-12-10' }, '2026-12-11').next, '2026-12-18');
  assert.equal(L.problemStatus({ ...p, reviews_done: 3 }, '2026-12-01').status, 'mastered');
  assert.equal(L.problemStatus({}, '2026-12-01').status, 'todo');
});

test('topic review gaps', () => {
  assert.equal(L.topicStatus({ learned_on: '2026-11-30', reviews_done: 1 }, '2026-12-01').next, '2026-12-10');
  assert.equal(L.topicStatus({ learned_on: '2026-11-30', reviews_done: 1, last_review_on: '2026-12-05' }, '2026-12-12').status, 'due');
});

test('planned finish skips Sundays: 91 sessions from Mon 30 Nov end Mon 15 Mar', () => {
  assert.equal(L.planStatus(plan, mk(91), '2026-11-30').plannedFinish, '2027-03-15');
});

test('on track: done every day so far', () => {
  const st = L.planStatus(plan, mk(91, { 1: '2026-11-30', 2: '2026-12-01' }), '2026-12-02');
  assert.equal(st.behind, 0);
  assert.equal(st.streak, 2);
  assert.equal(st.next.seq, 3);
  assert.equal(st.doneToday, false);
  assert.equal(st.slipDays, 0);
});

test('behind: two missed days slip the finish date', () => {
  const st = L.planStatus(plan, mk(91, { 1: '2026-11-30' }), '2026-12-03'); // Thu; Tue + Wed missed
  assert.equal(st.behind, 2);
  assert.equal(st.missed, 3);                       // Tue, Wed and today so far
  assert.equal(st.streak, 0);
  assert.equal(st.projectedFinish, '2027-03-17');
  assert.equal(st.slipDays, 2);
});

test('streak survives the Sunday rest day', () => {
  const st = L.planStatus(plan, mk(91, { 1: '2026-12-04', 2: '2026-12-05', 3: '2026-12-07' }), '2026-12-07');
  assert.equal(st.streak, 3);
});

test('nudge: sent when a study day is not done; partner copied after 2 missed days', () => {
  const one = L.nudgeDecision({ plan, sessions: mk(91), profiles, today: '2026-11-30' });
  assert.equal(one.to, 'w@example.com');
  assert.deepEqual(one.cc, []);
  const two = L.nudgeDecision({ plan, sessions: mk(91), profiles, today: '2026-12-01' });
  assert.deepEqual(two.cc, ['h@example.com']);
  assert.match(two.text, /2 study days in a row/);
});

test('nudge: addresses come from the plan; no address means no email, no cc address means no cc', () => {
  const noCc = L.nudgeDecision({ plan: { ...plan, cc_email: null }, sessions: mk(91), profiles, today: '2026-12-01' });
  assert.deepEqual(noCc.cc, []);
  const fallback = L.nudgeDecision({ plan: { ...plan, nudge_email: null }, sessions: mk(91), profiles, today: '2026-11-30' });
  assert.equal(fallback.to, 'w@example.com');     // owner's profile email
  assert.equal(L.nudgeDecision({ plan: { ...plan, nudge_email: null }, sessions: mk(91), profiles: [], today: '2026-11-30' }), null);
});

test('nudge: silent when done, on Sunday, before the start, when off, or when finished', () => {
  const base = { plan, profiles };
  assert.equal(L.nudgeDecision({ ...base, sessions: mk(91, { 1: '2026-11-30' }), today: '2026-11-30' }), null);
  assert.equal(L.nudgeDecision({ ...base, sessions: mk(91), today: '2026-12-06' }), null);
  assert.equal(L.nudgeDecision({ ...base, sessions: mk(91), today: '2026-11-29' }), null);
  assert.equal(L.nudgeDecision({ ...base, plan: { ...plan, nudge_enabled: false }, sessions: mk(91), today: '2026-11-30' }), null);
  assert.equal(L.nudgeDecision({ ...base, sessions: mk(1, { 1: '2026-11-30' }), today: '2026-12-01' }), null);
});

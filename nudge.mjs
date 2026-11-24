// Evening reminder: emails the person studying if today's session is not marked done.
// Run by .github/workflows/nudge.yml. Set DRY_RUN=1 to print the emails instead of sending them.
import { nudgeDecision, todayIn } from './logic.js';

const env = (k, required = true) => {
  const v = process.env[k];
  // Until the repo secrets are added the reminder is simply off; exit quietly so the nightly run does not fail.
  if (!v && required) { console.log(`Reminder not set up yet: ${k} is missing (repo Settings > Secrets and variables > Actions).`); process.exit(0); }
  return v || '';
};
const DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const GMAIL_USER = env('GMAIL_USER', !DRY);
const GMAIL_APP_PASSWORD = env('GMAIL_APP_PASSWORD', !DRY);
const APP_URL = env('APP_URL', false);

const { createClient } = await import('@supabase/supabase-js');
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const rows = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };

const plans = await rows(sb.from('study_plans').select('*').eq('nudge_enabled', true));
const profiles = await rows(sb.from('profiles').select('*'));
const emails = [];
for (const plan of plans) {
  const [sessions, problems, topics] = await Promise.all([
    rows(sb.from('study_sessions').select('seq,block,kind,task,done_on').eq('plan_id', plan.id)),
    rows(sb.from('study_problems').select('solved_on,rating,reviews_done,last_review_on').eq('plan_id', plan.id)),
    rows(sb.from('study_topics').select('learned_on,reviews_done,last_review_on').eq('plan_id', plan.id)),
  ]);
  const today = todayIn(plan.timezone || 'Asia/Kolkata');
  const mail = nudgeDecision({ plan, sessions, problems, topics, profiles, today, appUrl: APP_URL });
  console.log(`${plan.name} (${today}): ${mail ? 'reminder → ' + mail.to + (mail.cc.length ? ' cc ' + mail.cc.join(', ') : '') : 'no reminder needed'}`);
  if (mail) emails.push(mail);
}

if (DRY) {
  for (const m of emails) console.log(`\n--- ${m.subject}\n${m.text}`);
} else if (emails.length) {
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  for (const m of emails) {
    await transport.sendMail({ from: `Padhai <${GMAIL_USER}>`, to: m.to, cc: m.cc, subject: m.subject, text: m.text });
    console.log(`sent: ${m.subject}`);
  }
}

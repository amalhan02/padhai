# Padhai — study plan tracker

A phone-first web app that runs a study plan one session at a time and nags when a day is skipped.
Built the same way as the expense tracker: plain HTML and JavaScript (no build step), Supabase for data
and logins, GitHub Pages for hosting. A scheduled GitHub job sends the evening reminder email.

## What it does

- **Today**: the next session, how to spend the 2 hours, a countdown timer and one "Mark done" button.
  Problems and topics due for review are listed underneath.
- **Nudges in the app**: day streak, sessions behind, reviews due, and how far the finish date has slipped.
- **Evening email**: at about 8 pm India time on study days, if the session is not marked done, the person
  studying gets an email. After 2 missed study days in a row the other person is copied.
- **Plan**: the 13 blocks with progress; tick sessions, edit any of them, add your own.
- **Problems**: 102 problems pre-loaded. Mark one solved and say how it went; it comes back for 3 spaced reviews.
- **Topics**: 178 topics by category. Mark a group learned; reviews come back at about 3, 10 and 30 days.
- **Mocks**: log each mock with a rating and what to fix.
- **More than one plan**: every plan has an owner. Add a second plan later from More > New plan and switch
  between them with the selector at the top.

Sessions are done in order. A missed day does not pile up work: the remaining sessions slip by a day.

## Setup (about 20 minutes)

This copy is set up to share the `ghar-kharcha` Supabase project with the expense tracker: the study tables
are prefixed `study_`, and both apps use the same two logins. Steps 1–3 are already done for that project.

1. **Supabase project**: create one at supabase.com, or reuse an existing one.
2. **Database**: SQL Editor > paste all of `schema.sql` > Run.
3. **Keys**: Project Settings > API. Copy the Project URL and the anon (publishable) key into `config.js`.
   Never put the service_role (secret) key in `config.js`.
4. **Host it**: push this folder to a GitHub repo, then Settings > Pages > Deploy from a branch > `main`, root.
   A free GitHub Pages site needs a public repo. The code holds no secrets; the data stays in Supabase.
5. **Create both accounts**: open the site and use "Create account" once each. Confirm by email if asked.
6. **Lock it down**: Supabase > Authentication > Sign In / Providers > turn off new sign-ups.
   Any signed-in user can see and edit every plan, so only the two of you should have accounts.
7. **Load the plan**: More > New plan > "Go SDE-2 / SSE-1 interview prep", choose who is studying and the start date.
8. **Phones**: open the site and choose "Add to Home Screen".

### Evening email

1. Pick a Gmail account to send from. Turn on 2-Step Verification, then create an **app password**
   (Google Account > Security > App passwords).
2. In the GitHub repo: Settings > Secrets and variables > Actions. Add these **secrets**:
   - `SUPABASE_SERVICE_ROLE_KEY` – the secret key from Supabase > Project Settings > API Keys
   - `GMAIL_USER` – the Gmail address
   - `GMAIL_APP_PASSWORD` – the app password
3. On the Variables tab of the same page, add `SUPABASE_URL` (the Project URL) and `APP_URL` (the GitHub
   Pages address, so the email links to the app).
4. Test it: Actions > "Evening study reminder" > Run workflow with "dry run" ticked. The log shows the email
   it would send. Untick it to send a real one.

Things to know:

- The addresses are typed in the app: More > Plans > Settings has "Send the reminder to" and "Also copy this
  email after missed days". No address, no email.
- GitHub's schedule can run 10–30 minutes late.
- GitHub pauses scheduled jobs in a repo with no commits for 60 days and emails you a link to re-enable them.
- To change the time, edit the `cron` line in `.github/workflows/nudge.yml` (it is in UTC).
- Per plan, the reminder can be switched off and the "copy the other person" threshold changed in plan settings.

## Adding another plan

- **In the app**: More > New plan. Choose the Go template again, or "Empty plan" and add sessions by hand.
- **A different syllabus**: copy `plan-go-sde2.json`, change its sessions, problems and topics, save it as
  `plan-<name>.json`, and add one line for it to the template list in `newPlan()` in `app.js`.

## Files

- `index.html` – page shell and styles
- `app.js` – the app
- `logic.js` – dates, review scheduling, progress and the reminder decision (shared with the email script)
- `config.js` – Supabase URL and anon key
- `plan-go-sde2.json` – the plan template (91 sessions, 102 problems, 178 topics)
- `schema.sql` – tables and security rules
- `nudge.mjs`, `.github/workflows/nudge.yml` – the evening email
- `logic.test.mjs` – `npm test` runs the logic tests

## Design decisions

- **Email sender**: GitHub scheduled job + Gmail, chosen over a Supabase scheduled job + an email service
  because it needs no extra account or domain. The cost is a possibly late email and the 60-day pause.
- **Demo mode**: with `config.js` empty the app stores data in the browser only. It exists so the app can be
  tried and tested without a database.
- **Left out on purpose**: job applications, STAR stories and visa notes stay in the spreadsheet.

## What has and has not been tested

- Tested: the scheduling logic (9 tests) and the full app flow in a phone-sized browser in demo mode.
- Not tested: anything against a live Supabase project, and actually sending an email. The first real run is
  the test. Errors show as a banner at the top of the screen.

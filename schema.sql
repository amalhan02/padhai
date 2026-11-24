-- Padhai study tracker: run this once in Supabase > SQL Editor.
-- Safe to run in a project shared with another app (for example the expense tracker): the study tables
-- are prefixed study_, and an existing profiles table is reused, not replaced.
-- Two logins. Every signed-in user can see and edit every plan, so turn OFF new sign-ups
-- (Authentication > Sign In / Providers) once both of you have registered.

-- ---------- tables ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text not null,
  email        text,                                  -- where the evening reminder is sent
  created_at   timestamptz not null default now()
);

alter table public.profiles add column if not exists email text;

-- One row per study plan. Add a second plan later for the other person.
create table public.study_plans (
  id               bigint generated always as identity primary key,
  owner_id         uuid not null references public.profiles on delete cascade,  -- who is studying
  name             text not null,
  start_date       date not null,
  study_days       int[] not null default '{1,2,3,4,5,6}',   -- 1 = Mon … 7 = Sun
  minutes_per_day  int not null default 120 check (minutes_per_day > 0),
  timezone         text not null default 'Asia/Kolkata',
  nudge_enabled    boolean not null default true,            -- evening email if the day's session is not done
  nudge_email      text,                                     -- where the reminder goes (set in the app)
  cc_email         text,                                     -- who is copied after missed days (set in the app)
  cc_after_missed  int not null default 2 check (cc_after_missed >= 0),  -- copy cc_email after N missed days; 0 = never
  blocks           jsonb not null default '[]',              -- [{num, dsa, deep, build, job}]
  splits           jsonb not null default '{}',              -- {kind: how to spend the session}
  created_at       timestamptz not null default now()
);

-- The ordered sessions of a plan. They are done in seq order; a missed day just slips the rest.
create table public.study_sessions (
  id       bigint generated always as identity primary key,
  plan_id  bigint not null references public.study_plans on delete cascade,
  seq      int not null,
  block    int not null default 1,
  kind     text not null,
  task     text not null,
  extra    text,
  done_on  date,
  notes    text,
  unique (plan_id, seq)
);

create table public.study_problems (
  id              bigint generated always as identity primary key,
  plan_id         bigint not null references public.study_plans on delete cascade,
  name            text not null,
  pattern         text,
  difficulty      text check (difficulty in ('Easy', 'Medium', 'Hard')),
  block           int,
  solved_on       date,
  rating          text check (rating in ('Struggled', 'OK', 'Easy')),
  reviews_done    int not null default 0 check (reviews_done >= 0),
  last_review_on  date,
  link            text,
  notes           text
);

create table public.study_topics (
  id              bigint generated always as identity primary key,
  plan_id         bigint not null references public.study_plans on delete cascade,
  category        text not null,
  grp             text not null,
  topic           text not null,
  sort            int not null default 0,
  learned_on      date,
  reviews_done    int not null default 0 check (reviews_done >= 0),
  last_review_on  date,
  confidence      int check (confidence between 1 and 5),
  notes           text
);

create table public.study_mocks (
  id          bigint generated always as identity primary key,
  plan_id     bigint not null references public.study_plans on delete cascade,
  done_on     date not null,
  kind        text not null,
  source      text,
  topic       text,
  rating      int check (rating between 1 and 5),
  went_wrong  text,
  actions     text
);

create index on public.study_sessions (plan_id);
create index on public.study_problems (plan_id);
create index on public.study_topics (plan_id);
create index on public.study_mocks (plan_id);

-- ---------- security: signed-in users only ----------
alter table public.profiles enable row level security;
alter table public.study_plans    enable row level security;
alter table public.study_sessions enable row level security;
alter table public.study_problems enable row level security;
alter table public.study_topics   enable row level security;
alter table public.study_mocks    enable row level security;

-- profiles: keep the rules another app already set; only add one if there are none
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles') then
    create policy "signed-in full access" on public.profiles for all to authenticated using (true) with check (true);
  end if;
end $$;
create policy "signed-in full access" on public.study_plans    for all to authenticated using (true) with check (true);
create policy "signed-in full access" on public.study_sessions for all to authenticated using (true) with check (true);
create policy "signed-in full access" on public.study_problems for all to authenticated using (true) with check (true);
create policy "signed-in full access" on public.study_topics   for all to authenticated using (true) with check (true);
create policy "signed-in full access" on public.study_mocks    for all to authenticated using (true) with check (true);

-- make sure the app (signed-in users) and the email script (service role) can reach the tables
grant select, insert, update, delete on public.study_plans, public.study_sessions, public.study_problems, public.study_topics, public.study_mocks to authenticated;
grant all on public.study_plans, public.study_sessions, public.study_problems, public.study_topics, public.study_mocks to service_role;

-- The plan itself (sessions, problems, topics) is loaded from inside the app:
-- Settings > New plan > "Go SDE-2 / SSE-1 interview prep".

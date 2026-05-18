# Cornflake Phase 2C — Supabase Schema

## Overview

Phase 2C sets up the Supabase Postgres database that serves as the canonical cloud store. All access goes through the backend API (Phase 2B) — the Electron app never touches Supabase directly.

---

## Prerequisites

1. Create a Supabase project at supabase.com
2. Add to Railway environment variables:
   ```
   SUPABASE_URL=https://yourproject.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   ```
3. The schema SQL below is run manually in the Supabase SQL editor

---

## Schema SQL

Run in Supabase SQL editor:

```sql
-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Users (populated from WorkOS profile on first login)
create table users (
  id text primary key,           -- WorkOS user_id
  email text not null unique,
  name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Custom lists
create table lists (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Meetings
create table meetings (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  title text not null,
  start_ms bigint not null,
  end_ms bigint,
  calendar_event_id text,
  requires_manual_labelling boolean not null default false,
  summary text,
  structured_notes text,
  confirmed_at bigint,
  deleted_at bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Speakers
create table speakers (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  deepgram_id text,
  name text,
  email text,
  is_self boolean not null default false,
  confidence text,
  has_cornflake boolean not null default false,
  created_at timestamptz not null default now()
);

-- Utterances
create table utterances (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  speaker_id text not null references speakers(id),
  text text not null,
  start_ms bigint not null,
  end_ms bigint not null,
  created_at timestamptz not null default now()
);

-- Tasks
create table tasks (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  meeting_id text references meetings(id) on delete set null,
  assignee_speaker_id text references speakers(id) on delete set null,
  title text not null,
  list_name text not null default 'Reminders',
  origin_list text,
  deadline_text text,
  deadline_ms bigint,
  remind_offset_ms bigint,
  remind_at_ms bigint,
  transcript_quote text,
  extraction_confidence text,
  status text not null default 'pending',
  note text,
  sort_order integer,
  completed_at bigint,
  priority text not null default 'normal',
  notes_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Decisions
create table decisions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

-- Comms
create table comms (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  recipient_speaker_id text references speakers(id) on delete set null,
  message_body text not null,
  delivery_channel text not null default 'push',
  recipient_email text,
  has_cornflake boolean not null default false,
  include_install_invite boolean not null default false,
  send boolean not null default true,
  sent_at bigint,
  send_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Voice profiles (metadata only — binary stored in Supabase Storage)
create table voice_profiles (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  email text,
  embedding_path text,
  sample_count integer not null default 1,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(user_id, name)
);

-- Devices
create table devices (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  name text,
  platform text not null default 'mac',
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
```

---

## Storage Setup

In Supabase dashboard → Storage → New bucket:
- Name: `voice-profiles`
- Public: OFF (private)

---

## Notes on RLS

Because all Supabase access goes through the backend using the service role key, RLS policies are optional — the backend enforces `user_id` equality on every query. However, adding RLS is good defence-in-depth in case the service role key is ever compromised.

If you want RLS, add after the schema:

```sql
alter table users enable row level security;
alter table lists enable row level security;
alter table meetings enable row level security;
alter table speakers enable row level security;
alter table utterances enable row level security;
alter table tasks enable row level security;
alter table decisions enable row level security;
alter table comms enable row level security;
alter table voice_profiles enable row level security;
alter table devices enable row level security;

-- Service role bypasses RLS automatically — policies only
-- apply to anon/authenticated roles which we don't use
```

---

## Verification

1. All tables created in Supabase with correct columns
2. `voice-profiles` storage bucket exists and is private
3. Backend `GET /api/sync/pull` returns empty arrays for a new user
4. Backend `POST /api/sync/push` with a test task record creates a row in Supabase
5. Row appears in Supabase table editor with correct user_id

---

## Claude Code Session Prompt

```
Read these files before doing anything else:
@phase2-docs/phase2-cloud-architecture.md
@phase2-docs/phase2c-supabase-schema.md

Phase 2B (backend API) is complete. We are now setting up 
Phase 2C — Supabase schema.

The schema SQL and storage setup must be run manually in the 
Supabase dashboard — share the exact SQL for me to run, do 
not attempt to run it yourself.

After I confirm the schema is created:
1. Verify the backend can connect to Supabase by testing 
   GET /api/sync/pull with a valid auth token
2. Confirm the voice-profiles storage bucket is accessible 
   via the backend voice profiles endpoint

Verify all 5 items in the Verification section.
```

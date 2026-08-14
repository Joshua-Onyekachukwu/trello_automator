-- Minimal schema for the Trello auto-claim service.
-- Run once in the Supabase SQL editor (SQL editor → paste → Run).
--
-- Concurrency: the app claims the per-user daily slot with a single atomic
-- conditional UPDATE (or INSERT ... ON CONFLICT DO NOTHING) over the REST API.
-- Postgres serializes concurrent UPDATEs and re-evaluates the WHERE clause on
-- the committed row, so exactly one of any set of simultaneous claims wins —
-- no advisory lock, no extra infrastructure.

-- One row per user: the persistent daily claim state.
create table if not exists claim_state (
  user_member_id text primary key,
  date           text not null default '',   -- YYYY-MM-DD (Africa/Lagos) of the last claim
  card_id        text,                       -- currently claimed card, if any
  eligible       boolean not null default true,
  updated_at     timestamptz not null default now()
);

-- Append-only audit + timing log. Every claim-path decision writes one row
-- with the full timing breakdown in `details`.
create table if not exists claim_events (
  id                 bigint generated always as identity primary key,
  card_id            text,
  event_type         text not null,   -- CARD_CLAIMED | CARD_ALREADY_CLAIMED | USER_ALREADY_IN_TODO
                                      -- | USER_ALREADY_IN_DOING | NOT_ELIGIBLE | CARD_IGNORED
                                      -- | TRELLO_ERROR | INTERNAL_ERROR | ELIGIBILITY_UPDATED
  success            boolean not null,
  processing_time_ms integer,
  error_message      text,
  details            jsonb,           -- full timing breakdown (see lib/timing.ts)
  created_at         timestamptz not null default now()
);

create index if not exists claim_events_created_at_idx on claim_events (created_at desc);

-- Lock the tables down: the only credential that can touch them is the
-- server-side SECRET key (which bypasses RLS). The publishable/anon key gets
-- nothing because there are no policies granting it access.
alter table claim_state enable row level security;
alter table claim_events enable row level security;

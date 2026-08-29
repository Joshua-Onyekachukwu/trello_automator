-- Migration 002: Kill switch + scan support
-- Run in Supabase SQL Editor → Run

-- Add enabled column to claim_state (defaults to true = automation ON)
alter table claim_state add column if not exists enabled boolean not null default true;

-- Scan events audit trail (separate from claim_events for clarity)
create table if not exists scan_events (
  id                 bigint generated always as identity primary key,
  scan_type          text not null default 'cron',       -- 'cron' | 'manual'
  cards_scanned      integer not null default 0,
  cards_claimed      integer not null default 0,
  cards_skipped      integer not null default 0,
  external_claims_synced integer not null default 0,
  processing_time_ms integer,
  details            jsonb,
  created_at         timestamptz not null default now()
);

alter table scan_events enable row level security;

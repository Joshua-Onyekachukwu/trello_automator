-- Migration 004: today context + clearer eligibility reasoning
-- Run in Supabase SQL Editor -> Run
--
-- Adds columns the service uses to:
--  - remember which card it associated with the user today (claimed_card_id)
--  - record how the user came to be "taken" today (how_added)
--  - re-check live Trello membership and remember the result (last_membership_*)
--  - support removal-based re-eligibility and the manual "clear my today" reset
--     without changing the daily claim count.

alter table claim_state add column if not exists claimed_card_id text;
alter table claim_state add column if not exists how_added text;
alter table claim_state add column if not exists last_membership_checked_at timestamptz;
alter table claim_state add column if not exists last_membership_note text;

alter table claim_state enable row level security;

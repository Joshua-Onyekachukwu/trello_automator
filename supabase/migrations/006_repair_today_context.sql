-- Migration 006: repair the upgrade path — today context + clear_today function
-- Run in Supabase SQL Editor → Run
-- Idempotent: safe to re-run.
--
-- Why this file exists (verified read-only against the live project, 2026-10-09):
--   * Migration 004 added the today-context COLUMNS but never created the
--     clear_today() function — the function only ever landed in schema.sql, so
--     an installation upgraded through the migration chain (002 → 003 → 004)
--     from an older schema.sql is missing it. Symptom: "Clear my today" fails
--     with HTTP 404 PGRST202 "Searched for the function public.clear_today
--     with parameters p_card, p_how_added, p_note, p_user ... no matches".
--   * On that same installation the 004 columns and 005's DROP were also
--     absent, so this one file re-applies the whole gap. Every statement is
--     `if not exists` / `create or replace` — running it on a healthy
--     installation is a no-op.

-- 1) Today-context columns (migration 004, re-applied).
--    Without these, a successful Trello assignment's recordTodayContext write
--    400s, which the claim path treats as failure and releases the slot — so
--    this part matters beyond clear-today.
alter table claim_state add column if not exists claimed_card_id text;
alter table claim_state add column if not exists how_added text;
alter table claim_state add column if not exists last_membership_checked_at timestamptz;
alter table claim_state add column if not exists last_membership_note text;
alter table claim_state enable row level security;

-- 2) The clear_today RPC behind the status page's "Clear my today" button
--    (verbatim from supabase/schema.sql).
create or replace function clear_today(
  p_user text,
  p_card text,
  p_how_added text,
  p_note text
) returns void language plpgsql security invoker as $$
begin
  update claim_state
    set date = '',
        card_id = null,
        claimed_card_id = p_card,
        how_added = p_how_added,
        eligible = true,
        last_membership_checked_at = now(),
        last_membership_note = p_note,
        updated_at = now()
    where user_member_id = p_user;
end $$;

revoke all on function clear_today(text, text, text, text) from public;
grant execute on function clear_today(text, text, text, text) to service_role;

-- 3) Migration 005's cleanup (the vestigial scan_events audit table from the
--    removed cron scan). Re-applied because the earlier run left the table in
--    place; it holds only old audit rows and nothing in the app reads it.
drop table if exists scan_events;

-- Let PostgREST pick the new function up immediately.
notify pgrst, 'reload schema';

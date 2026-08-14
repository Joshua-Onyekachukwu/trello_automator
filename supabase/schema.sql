-- Minimal schema for the Trello auto-claim service.
-- Run once in the Supabase SQL editor (SQL editor → paste → Run).
--
-- Concurrency: the app claims the per-user daily slot with one atomic Postgres
-- function (claim_slot). Postgres serializes concurrent calls and re-evaluates
-- the WHERE clause on the committed row, so exactly the number of claims the
-- daily limit allows can ever succeed — no advisory lock, no extra
-- infrastructure. A failed Trello assignment is undone with release_slot.

-- One row per user: the persistent daily claim state.
create table if not exists claim_state (
  user_member_id text primary key,
  date           text not null default '',   -- YYYY-MM-DD (Africa/Lagos) of the last claim
  card_id        text,                       -- last claimed card, if any
  claim_count    integer not null default 0, -- cards claimed on `date`
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

-- ─── Daily-limit slot guard ──────────────────────────────────────────────────
-- Claim one slot for today, atomically. Wins when:
--   - the row is from another day (new Lagos day → count resets to 1), or
--   - the row is Code-Review-unlocked (eligible = true), or
--   - p_limit is 0 (unlimited), or
--   - today's claim_count is still below p_limit (→ count + 1).
-- If the row does not exist it is inserted with count 1 (ON CONFLICT means a
-- concurrent winner's insert wins and we lose). Returns whether we won.
create or replace function claim_slot(
  p_user  text,
  p_date  text,
  p_card  text,
  p_limit integer
) returns table (won boolean)
language plpgsql
security invoker
as $$
declare
  updated_rows integer;
begin
  update claim_state
    set date = p_date,
        card_id = p_card,
        eligible = false,
        claim_count = case when date = p_date then claim_count + 1 else 1 end,
        updated_at = now()
    where user_member_id = p_user
      and (date <> p_date or eligible <> false or p_limit = 0 or claim_count < p_limit);
  get diagnostics updated_rows = row_count;
  if updated_rows = 1 then
    return query select true;
    return;
  end if;

  insert into claim_state (user_member_id, date, card_id, eligible, claim_count, updated_at)
  values (p_user, p_date, p_card, false, 1, now())
  on conflict (user_member_id) do nothing;
  get diagnostics updated_rows = row_count;
  return query select (updated_rows = 1);
end;
$$;

-- Undo one failed claim: decrement today's count (never below 0). Safe under
-- concurrency — it never touches another in-flight claim's count or card.
create or replace function release_slot(p_user text)
returns void
language plpgsql
security invoker
as $$
begin
  update claim_state
    set claim_count = greatest(claim_count - 1, 0),
        updated_at = now()
    where user_member_id = p_user and claim_count > 0;
end;
$$;

-- The functions are server-side only: the publishable/anon key cannot call them.
revoke all on function claim_slot(text, text, text, integer) from public;
revoke all on function release_slot(text) from public;
grant execute on function claim_slot(text, text, text, integer) to service_role;
grant execute on function release_slot(text) to service_role;

-- Lock the tables down: the only credential that can touch them is the
-- server-side SECRET key (which bypasses RLS). The publishable/anon key gets
-- nothing because there are no policies granting it access.
alter table claim_state enable row level security;
alter table claim_events enable row level security;

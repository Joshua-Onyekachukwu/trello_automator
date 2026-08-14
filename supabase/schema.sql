-- Minimal schema for the Trello auto-claim service.
-- Run once in the Supabase SQL editor (SQL editor → paste → Run).
-- Idempotent: safe to re-run — an existing installation is upgraded in place.
--
-- Concurrency: the app claims the per-user daily slot with a single atomic
-- Postgres function (`claim_slot`). Postgres serializes concurrent UPDATEs and
-- re-evaluates the WHERE clause on the committed row, so exactly one of any
-- set of simultaneous claims wins — no advisory lock, no extra infrastructure.
-- The daily limit (DAILY_LIMIT env var) is enforced here in SQL, so the count
-- can never exceed the limit even under true concurrency.

-- One row per user: the persistent daily claim state.
create table if not exists claim_state (
  user_member_id text primary key,
  date           text not null default '',   -- YYYY-MM-DD (Africa/Lagos) of the last claim
  card_id        text,                       -- currently claimed card, if any
  eligible       boolean not null default true,
  claim_count    integer not null default 0, -- cards claimed on `date` (daily limit)
  daily_limit    integer,                    -- per-user override (1, 2, ... or 0 = unlimited);
                                              -- NULL = use the DAILY_LIMIT env default
  updated_at     timestamptz not null default now()
);

-- Upgrade path for an installation that predates the daily limit.
alter table claim_state add column if not exists claim_count integer not null default 0;
alter table claim_state add column if not exists daily_limit integer;
-- A pre-existing claim (card_id set) counts as one claim for its day.
update claim_state set claim_count = 1 where card_id is not null and claim_count = 0;

-- Membership cache for the claim fast path: one row per card the user is a
-- member of on the configured board, with its current list. Every webhook
-- event refreshes it from the payload (idMembers + list — zero extra Trello
-- calls), so the claim path can skip the my-cards GET when the cache is fresh.
create table if not exists user_cards (
  card_id    text primary key,
  board_id   text not null default '',
  list_id    text not null default '',
  updated_at timestamptz not null default now()
);
-- Same lockdown as the other tables: only the SECRET key (service_role) can
-- read or write the cache; anon/publishable gets nothing.
alter table user_cards enable row level security;

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

-- Atomic daily-slot claim. Returns won=true for exactly one of any set of
-- concurrent calls that the one-per-day rule allows: a new Lagos day (midnight
-- is the ONLY reset), unlimited (p_limit = 0), or still under the daily limit.
-- Code Review never unlocks the slot. p_unlock is retained in the signature
-- for API compatibility (the app always sends false) but is NOT consulted —
-- eligible is never used to grant a claim.
create or replace function claim_slot(
  p_user text, p_date text, p_card text, p_limit integer, p_unlock boolean
) returns table (won boolean)
language plpgsql security invoker as $$
declare updated_rows integer;
begin
  update claim_state
    set date = p_date, card_id = p_card, eligible = false,
        claim_count = case when date = p_date then claim_count + 1 else 1 end,
        updated_at = now()
    where user_member_id = p_user
      and (
        date <> p_date or        -- new Lagos day (midnight is the only reset)
        p_limit = 0 or           -- unlimited
        claim_count < p_limit    -- still under the daily limit
      );
  get diagnostics updated_rows = row_count;
  if updated_rows = 1 then
    return query select true;
    return;
  end if;

  -- No row yet (first claim): insert it. A concurrent insert for the same
  -- user loses to the ON CONFLICT guard.
  insert into claim_state (user_member_id, date, card_id, eligible, claim_count, updated_at)
  values (p_user, p_date, p_card, false, 1, now())
  on conflict (user_member_id) do nothing;
  get diagnostics updated_rows = row_count;
  return query select (updated_rows = 1);
end $$;

-- Undo one failed claim (Trello assignment error): decrements today's count.
create or replace function release_slot(p_user text)
returns void language plpgsql security invoker as $$
begin
  update claim_state set claim_count = greatest(claim_count - 1, 0), updated_at = now()
  where user_member_id = p_user and claim_count > 0;
end $$;

-- Only the server-side SECRET key (service_role) may call the functions; the
-- publishable/anon key gets nothing.
revoke all on function claim_slot(text, text, text, integer, boolean) from public;
revoke all on function release_slot(text) from public;
grant execute on function claim_slot(text, text, text, integer, boolean) to service_role;
grant execute on function release_slot(text) to service_role;

-- Lock the tables down: the only credential that can touch them is the
-- server-side SECRET key (which bypasses RLS). The publishable/anon key gets
-- nothing because there are no policies granting it access.
alter table claim_state enable row level security;
alter table claim_events enable row level security;

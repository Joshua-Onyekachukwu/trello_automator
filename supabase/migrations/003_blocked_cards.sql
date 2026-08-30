-- Blocked cards: cards the system should never claim.
-- Manage from the status page — no redeploy needed.
create table if not exists blocked_cards (
  card_id     text primary key,
  card_name   text not null default '',
  added_at    timestamptz not null default now()
);

alter table blocked_cards enable row level security;

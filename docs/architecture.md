# Phase 1 — Architecture Assessment (updated for the REST store)

**Trello Auto-Claim Service** — a single-purpose service that claims an eligible,
unclaimed Trello card the instant it enters the configured To Do list.

Scope discipline: no dashboards, no auth system, no teams/billing, no queues, no cron,
no Redis, no general-purpose automation. One user, one board, three lists.

---

## 1. Proposed architecture

```
Trello (board webhook)
   │  POST https://<domain>/api/trello/webhook/<WEBHOOK_SECRET>
   ▼
Vercel (Next.js App Router, Node runtime)
   ├─ app/api/trello/webhook/[secret]/route.ts ← POST (events) + HEAD (verification)
   ├─ app/api/trello/setup/route.ts     ← admin: create/delete/status of the Trello webhook
   ├─ app/api/trello/status/route.ts    ← admin: JSON status (webhook + last event + timings)
   ├─ app/page.tsx                      ← minimal public status page (server-rendered)
   │
   ├─ lib/config.ts    env validation (fails fast if a required var is missing)
   ├─ lib/trello.ts    Trello REST client (getCard, getMyCards, addMemberToCard,
   │                   createWebhook, deleteWebhook, listWebhooks) — fetch-based, no SDK
   ├─ lib/webhook.ts   payload parsing + event classification (thin, no I/O)
   ├─ lib/claim.ts     claimCard() — the single decision function (pure-ish, DI'd deps)
   ├─ lib/state.ts     Supabase REST store: state read, atomic daily-slot guard,
   │                   claim_events log insert — no SQL driver, no DATABASE_URL
   └─ lib/timing.ts    performance.now() instrumentation, structured timing snapshot
   │
   ▼
Supabase Postgres (2 tables, schema.sql; RLS on, no policies)
   ├─ claim_state   — one row per user: date, card_id, eligible, updated_at
   └─ claim_events  — append-only audit/timing log
```

- **Stack:** Next.js 15 (App Router) + TypeScript on Vercel; `fetch` against the
  Supabase REST API (PostgREST) — zero database drivers; `vitest` for tests. That's
  the entire dependency surface (`next`, `react`, `react-dom`).
- **No frontend work** beyond the one status page.
- **Deployment:** GitHub repo → Vercel (Git integration, auto-deploy on push to `main`)
  → Supabase (run `supabase/schema.sql` once).

---

## 2. Trello webhook flow

Trello fires one POST per board action. We parse, classify, and terminate as early
as possible. Classification is pure string logic — **no network, no DB** for the
common ignore path.

| Event | Classified as | Action |
|---|---|---|
| `createCard`, `data.list.id == TODO` | **claim** | full claim flow (card created directly in To Do) |
| `updateCard`, `data.listAfter.id == TODO` | **claim** | full claim flow (card moved into To Do) |
| `updateCard`, `listBefore.id == listAfter.id` | **ignore** | pure reorder inside a list — terminate |
| `updateCard`, `listAfter.id == CODE_REVIEW` | **eligibility** | if it's our claimed card, mark `eligible = true` (one cheap state update) |
| move to Doing / Done / any other list | **ignore** | terminate immediately |
| rename, description change, comment added, attachment, label, etc. | **ignore** | terminate immediately |
| board mismatch (`model.id != TRELLO_BOARD_ID`) | **ignore** | terminate immediately |

The eligibility path updates `claim_state` only when `card_id` matches the event
card. This satisfies "Code Review is only an eligibility event" — it **never**
enters the claim flow, and **never** triggers an assignment.

Trello webhook delivery details we rely on:
- Trello sends a **HEAD request** to the callback URL at registration time to verify
  it — the route exports `HEAD` returning 200.
- Trello does **not** sign webhook payloads (no HMAC). Validation therefore = secret
  embedded in the URL path + payload shape checks (see Security).

---

## 3. Vercel architecture

- **Runtime:** Node (`runtime = 'nodejs'`), `dynamic = 'force-dynamic'`. Edge is
  avoided because the hot path makes outbound network calls with the secret key.
- **Routes:** App Router route handlers (`route.ts`) — tiny handlers, all logic in
  `lib/`.
- **Cold starts:** minimized by keeping the dependency graph tiny (fetch only, no
  native modules). First event after idle may still pay a cold start; documented as
  inherent to serverless, measured in Phase 4, not hidden.
- **Timeout budget:** default 10 s (Hobby) is ample; we set our own inner timeouts
  (Trello fetch 5 s, Supabase REST 4 s) so a slow dependency can't hang the function.
- **Concurrency:** each invocation is independent; the atomic Postgres slot guard
  (below) provides cross-invocation serialization, which works across all warm
  instances.

---

## 4. Supabase schema

```sql
-- claim_state: one row per user (keyed now, trivial to extend to multiple users later)
create table if not exists claim_state (
  user_member_id text primary key,
  date           text not null default '',   -- YYYY-MM-DD in Africa/Lagos
  card_id        text,                       -- currently claimed card, if any
  eligible       boolean not null default true,
  updated_at     timestamptz not null default now()
);

-- claim_events: append-only audit + timing log
create table if not exists claim_events (
  id                 bigint generated always as identity primary key,
  card_id            text,
  event_type         text not null,   -- CARD_CLAIMED | CARD_ALREADY_CLAIMED | USER_ALREADY_IN_TODO |
                                      -- USER_ALREADY_IN_DOING | NOT_ELIGIBLE | TRELLO_ERROR | ELIGIBILITY_UPDATED
  success            boolean not null,
  processing_time_ms integer,
  error_message      text,
  details            jsonb,           -- full timing breakdown
  created_at         timestamptz not null default now()
);
create index if not exists claim_events_created_at_idx on claim_events (created_at desc);

alter table claim_state enable row level security;
alter table claim_events enable row level security;
```

Deliberate choices:
- **Access is REST-only** — the service authenticates with the server-side SECRET
  key (`sb_secret_...`, the modern equivalent of the old service-role key) via the
  `apikey`/`Authorization` headers. No `DATABASE_URL`, no SQL driver, no connection
  pool to size on serverless.
- **RLS is enabled with zero policies** — the publishable/anon key gets nothing; the
  SECRET key bypasses RLS, which is exactly the server-only access the service needs.
- **No dedup/events table for idempotency** — idempotency is achieved by
  re-verification (see §5), which is cheaper than a dedup write on the hot path and
  self-heals. `claim_events` is the audit log.
- **Log volume:** only the claim path and eligibility updates write `claim_events`
  rows. Fully ignored events (comments, renames, other-list moves) produce a single
  structured log line — no DB write.

---

## 5. Race-condition strategy

The core invariant: **the user may hold at most one claimed card per Lagos day
(unless it has moved to Code Review), and a card must be unclaimed at the moment of
assignment.**

Mechanism — one atomic Postgres conditional UPDATE as the per-user **daily slot
guard** (no advisory lock, no extra infrastructure):

```
T1: card A → TODO              T2: card B → TODO (near-simultaneous)
─────────────────────          ─────────────────────
parallel reads (my cards,      parallel reads (my cards,
  state; card from payload)      state; card from payload)
evaluate: all 5 conditions      evaluate: all 5 conditions
SELECT claim_slot(A)            SELECT claim_slot(B)   — one atomic Postgres call
  (UPDATE claim_state             (UPDATE claim_state
     SET date=today, card_id=A      SET date=today, card_id=B
     WHERE user_member_id=$me       WHERE user_member_id=$me
       AND (date <> today           AND (date <> today
            OR p_unlock                  OR p_unlock
            OR limit = 0                OR limit = 0
            OR claim_count < limit)     OR claim_count < limit)
     → 1 row: T1 WINS             → blocked by Postgres row lock; after T1
                                   commits the WHERE is re-evaluated on the
                                   committed row (date=today, eligible=false,
                                   claim_count = limit)
                                   → 0 rows: T2 LOSES, no POST
```

Fresh-day / first-run claims fall through to `INSERT ... ON CONFLICT DO NOTHING`
inside the same function, which is equally atomic: the loser's insert conflicts
and wins nothing.

Key properties:
- **Eligibility is evaluated from the parallel read fan-out** (`getMyCards` +
  `getState` in one `Promise.all`; the target card comes from the webhook payload
  itself when it carries `idList` + `idMembers`, with a `getCard` fallback), then
  the slot is claimed with **one atomic RPC call** (`claim_slot`). The guard's
  WHERE clause is exactly "the day's slot is free": no row yet, a row from an
  earlier day, still under the daily limit, or unlocked by Code Review.
- **The Code Review self-heal is folded into the slot call** as a `p_unlock`
  flag: when live Trello shows the claimed card in Code Review, the claim is
  accepted in the same atomic UPDATE — no separate eligibility write, one round
  trip instead of two.
- **The slot is taken only immediately before the Trello POST**, and released
  again (`DELETE` row, or restore of the prior values) if the POST fails. Trello's
  response is authoritative — a redelivered webhook can retry after a release.
- **Fail-closed:** a Supabase error (network, missing table, timeout) throws and
  becomes `INTERNAL_ERROR` — never a claim. Safer to miss a claim than to double-claim.
- **Cross-user contention on the same card** (two teammates both see "nobody
  assigned"): we cannot and must not lock Trello. We minimize the window by checking
  `idMembers` immediately before POST and treat Trello's response as the final word —
  exactly per your spec. No fake local lock that could block teammates.
- **Why not Redis / a queue:** a single atomic Postgres statement is simpler, free,
  and more than enough at this scale. No new infrastructure.

Idempotency (duplicate deliveries) falls out of the same design: the second delivery
re-enters the flow, re-verifies, and stops because (a) the target card now has a
member, and/or (b) the daily slot guard fails.

---

## 6. Performance strategy

Target flow per event:

```
receive webhook  →  classify (pure, ~0 ms)  →  parallel reads  →  decision  →  slot RPC  →  POST  →  log
                      │
                      ├── target card from the webhook payload
                      │     (idList + idMembers; GET /1/cards/{id} only as fallback)
                      ├── GET /1/members/{me}/cards?fields=idList,idBoard&filter=open   ┐
                      └── GET claim_state (Supabase REST)                                ├─ Promise.all
                                                                                        ┘
```

- **One request answers multiple conditions:** the webhook payload's card data
  answers conditions 1 + 2 (with `getCard` as a fallback when `idMembers` is
  absent); `getMyCards` answers conditions 3 + 4 (+ the Code Review eligibility
  check); `getState` joins the same fan-out at zero extra latency. Then at most
  **one** slot RPC and **one** Trello POST. No other network calls exist.
- **No polling, no queue, no cron, no artificial delay.** Midnight reset is computed
  (`Intl.DateTimeFormat` with `timeZone: 'Africa/Lagos'`), not scheduled.
- **DB writes minimized:** one slot write per successful claim, one event-log write
  per claim-path decision, one `eligible = true` update for Code Review unlocks.
  Zero DB I/O for ignored events.
- **Timing instrumentation** (`lib/timing.ts`): timestamps for webhook received,
  checks started/completed, assignment started/completed; `totalProcessingMs`,
  `trelloChecksMs`, `trelloAssignmentMs` stored in `claim_events.details` and echoed
  as a structured log line. Phase 4 will report real numbers — no unmeasured claims.
- **Cold start** is the only unavoidable latency; mitigated by minimal dependencies.

---

## 7. Security model

- Credentials exist **only** in Vercel env vars; `.env.example` ships placeholders;
  `.env*` is git-ignored. Nothing secret is ever rendered client-side.
- **Webhook validation:** Trello does not sign webhooks, so the callback URL embeds
  `WEBHOOK_SECRET` as a path segment (`/api/trello/webhook/<secret>`, compared with
  `crypto.timingSafeEqual`). Payloads are shape-validated before any work. TLS is
  guaranteed by Vercel. This is the strongest validation Trello permits — documented
  as a limitation, not hidden.
- **Admin endpoints** (`/setup`, `/status`) require header `x-admin-token` matching
  `WEBHOOK_SECRET` (one secret, fewer env vars), timing-safe compare, 401 otherwise.
- **Log hygiene:** a sanitizer strips tokens/URLs from logged errors; never log env
  vars or request headers.
- **Supabase:** the SECRET key never leaves the server; it is sent only in request
  headers and is never logged. RLS with zero policies means the publishable key is
  inert even if leaked.
- **Graceful degradation:** Trello/DB failures are caught, logged with the event type,
  and never crash the function.

---

## 8. Deployment model

1. **GitHub:** repository initialized at the project root, README + docs committed.
2. **Vercel:** import the repo → framework preset Next.js → add env vars → auto-deploy
   on push to `main` via Git integration.
3. **Supabase:** create project → run `supabase/schema.sql` in the SQL editor → copy
   `SUPABASE_URL` and the SECRET key into Vercel.
4. **Trello webhook registration:** `POST /api/trello/setup` with
   `x-admin-token` + `{ "action": "create" }` → Trello verifies with a HEAD request
   (handled) → webhook active. Lifecycle documented in README: create, verify, status,
   test (move a real card), delete.
5. **Verification:** move a test card into To Do → observe `CARD_CLAIMED` in
   `claim_events` with timings; status page + `/api/trello/status` show last result.

---

## 9. Risks / things that could prevent the required behavior

| Risk | Impact | Mitigation |
|---|---|---|
| Trello payload shape varies (e.g. `createCard` without `data.list` in rare cases) | Missed claims | Defensive extraction: `listAfter.id` → `data.list.id` → `data.card.idList`; classify on all three |
| Vercel cold start on first event after idle | Slow first claim | Tiny deps; measured and reported in Phase 4; warm functions are ms-fast |
| Trello sends no webhook signature | Spoofed POSTs | URL-path secret + payload validation; documented limitation |
| Cross-user race on the same card | Both users could be added | Unavoidable without controlling Trello; minimized (check-then-POST) and Trello is authoritative, per spec |
| Two events for different cards | Double claim | Atomic conditional UPDATE slot guard (§5) |
| Supabase REST slow/outage | Missed claims (fail-closed) | 4 s timeout; never double-claims; logged loudly |
| Crashing between slot claim and Trello POST | Stale slot blocks the day | Small window (one POST); a redelivered event after a failure releases the slot; documented trade-off |
| Trello API slow/timeout | Failed POST | 5 s fetch timeout; slot released on failure; retry on webhook redelivery |
| Claimed card moved to CR while Vercel was down (missed event) | Stale `eligible=false` | `claimCard` re-derives eligibility from live `getMyCards` (claimed card seen in Code Review) — self-healing |
| Board-wide webhook noise (every comment/rename) | Wasted invocations | Pure-string classification terminates ~everything before any I/O |

---

## 10. Deliberate deviations from the spec (flagged)

1. **Supabase access is REST-only** — the approved plan used a transaction-pooler
   `DATABASE_URL` + `pg_advisory_xact_lock`. The user provided Supabase SECRET-key
   credentials (no DB password), so the store was pivoted to the REST API. The race
   guarantee is preserved by an atomic conditional UPDATE / `ON CONFLICT DO NOTHING`
   slot guard — still a Postgres-level guarantee, one statement, no driver, faster
   cold starts. `DATABASE_URL` is therefore **not** an env var.
2. **No separate idempotency table** — re-verification is cheaper and self-healing;
   `claim_events` remains the audit trail.
3. **Slot guard precedes the Trello POST** — the slot is claimed (one write)
   immediately before assignment and released on failure; a post-POST-commit design
   would let concurrent events double-claim.
4. **`SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_JWKS_URL` are unused** — they're for
   Supabase Auth, which this service does not use. The SECRET key is the only one
   needed.
5. **`copyCard` and old-style `moveCard` action types are ignored** for now (spec
   names only createCard/updateCard); noted as future expansion.

Everything else follows the spec as written. `claimCard(cardId)` remains the single,
independently testable decision function.

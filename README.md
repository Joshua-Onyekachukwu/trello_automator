# Trello Auto Claim

A single-purpose service: **when a card enters the configured To Do list, claim it
for you automatically** — if and only if every eligibility condition passes. Built
for speed: it is effectively first-come-first-served against teammates.

```
Trello ──webhook──▶ Vercel (Next.js) ──parallel reads──▶ Trello API
                          │
                          ├── target card from the webhook payload itself
                          │     (in To Do? unclaimed? — GET only as a fallback)
                          ├── GET my cards (in To Do / Doing?)
                          └── Supabase REST: claim state read (eligible?)
                                  │
                                  ▼
                    Supabase: atomic daily-slot guard (claim_slot, one call)
                                  │
                                  ▼
                         POST add member to card (Trello is authoritative)
                                  │
                                  ▼
                         Supabase: confirm state + log claim_events
```

Exactly three lists matter: **TO DO**, **DOING**, **CODE REVIEW** (configured via
env vars). Everything else — other lists, other boards, renames, comments,
description changes — is ignored immediately, with zero I/O.

The full design rationale is in [`docs/architecture.md`](docs/architecture.md).

---

## How the claim decision works

`claimCard()` in `lib/claim.ts` evaluates, in order:

1. Target card is currently in the To Do list.
2. No one is already assigned to the target card (`idMembers.length === 0`).
3. You are not already assigned to a To Do card.
4. You are not already assigned to a Doing card.
5. You are eligible — at most `DAILY_LIMIT` cards per **Africa/Lagos** day
   (`1` by default, `2`, or `0` = unlimited), unless your claimed card has moved
   into Code Review (which makes you eligible again, but never triggers an
   assignment by itself).

If all conditions pass, the assignment request is sent to Trello immediately.
The state row is written only after Trello confirms the assignment.

### Race conditions & idempotency

- The per-user daily slot is claimed with a single **atomic Postgres function**
  (`claim_slot`) over the Supabase REST API — one round trip that enforces the
  daily limit in SQL (`WHERE user_member_id = $me AND (date <> today OR p_unlock
  OR limit = 0 OR claim_count < limit)`) and creates the row via `INSERT ... ON
  CONFLICT DO NOTHING` on a fresh day. Postgres serializes concurrent calls and
  re-evaluates the WHERE clause on the committed row, so exactly one of any set
  of simultaneous claims wins — two cards entering To Do at the same instant can
  never both be claimed, and the count can never exceed `DAILY_LIMIT`.
- Duplicate webhook deliveries re-verify Trello state before claiming, so the
  second delivery is a no-op (the card now has a member / you are already in To Do).
- Trello's response is authoritative. The slot is taken only immediately before
  the assignment POST; if the POST fails the slot is released again, so a
  redelivered webhook can retry. If a write fails after a successful POST, the
  next event self-heals by re-checking Trello.
- Cross-teammate races on the same card are inherently Trello's to resolve — we
  minimize the window (check-then-POST) and treat Trello's response as final.

### Midnight reset

There is no cron. Each event computes the current date in `Africa/Lagos`
(`Intl.DateTimeFormat`) and treats any date change as a fresh day with
`eligible = true`, regardless of yesterday's state.

---

## Repository layout

```
app/
  api/trello/webhook/[secret]/route.ts   POST (events) + HEAD (Trello callback verification)
  api/trello/setup/route.ts              admin: create / status / delete the Trello webhook
  api/trello/status/route.ts             admin: JSON status (state, last event, webhooks)
  page.tsx                               minimal status page
scripts/resolve-board.mjs                `npm run board` — resolve a board into env values
lib/
  config.ts   env validation     trello.ts   Trello REST client
  claim.ts    claimCard()        state.ts    Supabase REST store + atomic slot guard
  webhook.ts  payload parsing    timing.ts   performance instrumentation
  log.ts      structured logs    security.ts timing-safe comparisons
supabase/schema.sql              the only database schema
tests/                           vitest suite (the 10 spec tests + parsing/client/perf)
```

---

## Local development

```bash
npm install
cp .env.example .env.local    # fill in real values
npm run dev
```

No Docker required. `.env.local` is git-ignored.

Need the values? See [`docs/credentials-checklist.md`](docs/credentials-checklist.md)
for exactly where to get every ID and credential. Generate a `WEBHOOK_SECRET`
with `npm run secret`.

CI runs typecheck + tests + build on every push (`.github/workflows/ci.yml`).

**Minimum env vars** (all in `.env.example`):

| Variable | Purpose |
|---|---|
| `TRELLO_KEY`, `TRELLO_TOKEN` | Trello API credentials (https://trello.com/power-ups/admin) |
| `TRELLO_BOARD_ID` | Board the webhook watches |
| `TRELLO_MEMBER_ID` | Your member id (who gets added to cards) |
| `TODO_LIST_ID`, `DOING_LIST_ID`, `CODE_REVIEW_LIST_ID` | The three lists that matter |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Server-side SECRET key (Settings → API Keys); the only credential that can touch the tables |
| `DAILY_LIMIT` | Max claims per Africa/Lagos day: `1` (default), `2`, `0` = unlimited |
| `WEBHOOK_SECRET` | Long random string; webhook URL path secret + `x-admin-token` |
| `APP_BASE_URL` | Public URL of the deployed app (used by `/api/trello/setup`) |

---

## Supabase setup

1. Create a project at https://supabase.com.
2. Open **SQL Editor** and run the contents of [`supabase/schema.sql`](supabase/schema.sql)
   — two tables (`claim_state`, `claim_events`), RLS enabled with no policies,
   plus the `claim_slot` / `release_slot` functions that enforce the daily limit
   atomically (the app calls them over the REST API).
3. In **Project Settings → API Keys**, copy `SUPABASE_URL` (project URL) and the
   **SECRET key** (`sb_secret_...`) into the env vars. The secret key is the only
   credential the service uses — it bypasses RLS, and the publishable key gets
   nothing.

No connection string is needed — the app talks to the database through the
Supabase REST API, which is also why there is no `DATABASE_URL` env var.

### Daily claim limit (`DAILY_LIMIT`)

The limit is enforced by the database (`claim_slot`), so it can never be
exceeded even when several cards enter To Do at the same instant:

- `DAILY_LIMIT=1` — one card per Lagos day (default).
- `DAILY_LIMIT=2` — two cards per Lagos day.
- `DAILY_LIMIT=0` — unlimited.

The count resets at midnight Africa/Lagos (computed per event, no cron). Moving
the claimed card to Code Review still makes you eligible again regardless of the
limit. Change the env var in Vercel and redeploy (auto-deploys on push) to adjust
the limit anytime.

---

## Deploy to Vercel

1. Push this repository to GitHub.
2. In Vercel: **Add New Project → Import** the GitHub repo. Framework preset is
   auto-detected (Next.js).
3. Add all environment variables (including `SUPABASE_URL` and
   `SUPABASE_SECRET_KEY` from Supabase).
4. Deploy — Vercel auto-deploys on every push to `main`.

---

## Trello webhook lifecycle

The webhook callback URL is:

```
https://<your-domain>/api/trello/webhook/<WEBHOOK_SECRET>
```

All lifecycle operations run through the protected admin endpoint
(`x-admin-token: <WEBHOOK_SECRET>` header). Trello does not sign webhook payloads,
so the secret is embedded in the URL path — that, plus payload shape validation,
is the security boundary (documented limitation).

**1. Create** (Trello immediately sends a HEAD request to verify the URL — the
endpoint answers 200):

```bash
curl -X POST https://<your-domain>/api/trello/setup \
  -H 'Content-Type: application/json' \
  -H 'x-admin-token: <WEBHOOK_SECRET>' \
  -d '{"action":"create"}'
```

**2. Status / verify:**

```bash
curl https://<your-domain>/api/trello/status \
  -H 'x-admin-token: <WEBHOOK_SECRET>'
```

Look for `"webhooks": [...]` with `"active": true` and `idModel` matching your
board.

**3. Test:** create a throwaway card in the To Do list (or move an existing card
into To Do). Within moments you should see a `CARD_CLAIMED` event with timing
details in `claim_events` and in Vercel function logs. Also verify the negative
cases: a card with an existing member is never claimed, and you are never claimed
onto a card when you already have To Do/Doing work.

**4. Delete:**

```bash
curl -X POST https://<your-domain>/api/trello/setup \
  -H 'Content-Type: application/json' \
  -H 'x-admin-token: <WEBHOOK_SECRET>' \
  -d '{"action":"delete"}'
```

---

## Testing

```bash
npm test
```

The suite covers the ten required scenarios plus parsing/client/perf:

| # | Scenario | Expectation |
|---|---|---|
| 1 | Empty To Do card, user free | CLAIM |
| 2 | Someone already assigned to target | DON'T CLAIM |
| 3 | User already in To Do | DON'T CLAIM |
| 4 | User already in Doing | DON'T CLAIM |
| 5 | User not eligible (already claimed today) | DON'T CLAIM |
| 6 | Claimed card moved to Code Review | eligible becomes true |
| 7 | New Lagos day | eligible becomes true |
| 8 | Card not in To Do | IGNORE |
| 9 | Duplicate webhook | no double claim |
| 10 | Two cards nearly simultaneously | only one claimed |

---

## Switching boards

The service watches exactly one board — the one in `TRELLO_BOARD_ID`, with its
three list ids. To point it at a different board, resolve that board with the
helper (it reads `TRELLO_KEY`/`TRELLO_TOKEN` from `.env.local`):

```bash
npm run board -- <board-id-or-short-id>
```

It prints the four values for the board's **To Do** / **Doing** / **Code Review**
lists (matched by name — the board must use exactly those names). Paste them into
`.env.local` (local) or the Vercel env vars (deployed), then restart.

If the Trello webhook is registered for the previous board, re-register it after
switching env vars:

```bash
curl -X POST https://<your-domain>/api/trello/setup \
  -H 'Content-Type: application/json' -H 'x-admin-token: <WEBHOOK_SECRET>' \
  -d '{"action":"delete"}'
curl -X POST https://<your-domain>/api/trello/setup \
  -H 'Content-Type: application/json' -H 'x-admin-token: <WEBHOOK_SECRET>' \
  -d '{"action":"create"}'
```

## Safely testing the claim (throwaway card)

`npm run test-claim` proves the full pipeline without touching real work:

1. creates a throwaway card in the configured To Do list,
2. lets the service claim it — with `--url=<base>` it delivers the webhook
   payload itself (exactly what Trello would send, so it works against a local
   server too); without it, it waits for the real registered webhook,
3. reports the outcome and the timing recorded in `claim_events`,
4. **always archives the card afterwards** (a closed card never re-enters the
   claim path).

```bash
npm run test-claim -- --url=http://localhost:3105   # against a local app
npm run test-claim                                  # against the deployed app (real webhook)
```

Exit code: `0` = claimed, `1` = not claimed (reason printed — e.g.
`NOT_ELIGIBLE`, `USER_ALREADY_IN_TODO`), `2` = setup error. If it reports
`NOT CLAIMED`, check `/api/trello/status`; the common causes are an unregistered
webhook or already having an open card in To Do/Doing.

---

## Measuring performance

Every claim-path decision records a timing breakdown in `claim_events.details`
and in the structured Vercel log line:

```json
{
  "webhookReceivedAt": "...",
  "checksStartedAt": "...",
  "checksCompletedAt": "...",
  "assignmentStartedAt": "...",
  "assignmentCompletedAt": "...",
  "totalProcessingMs": 142,
  "trelloChecksMs": 61,
  "trelloAssignmentMs": 62
}
```

- `trelloChecksMs` is the parallel read time. On the hot path the target card
  comes from the webhook payload itself, so it is one Trello read (my cards) + one
  Supabase read (state) in parallel — ≈ the slower of the two, not the sum (the
  tests prove this). The target-card GET is only a fallback when the payload
  lacks the card's member list.
- `totalProcessingMs` is webhook receipt → successful Trello assignment.

No "within milliseconds" claims here: read the real numbers from the deployed
service. The `tests/perf.test.ts` simulation shows the application's own overhead
(in-memory, single-digit ms) and the parallel-read behavior under simulated
network latency; real figures come from Vercel logs / `claim_events` after deploy.

Measured in production on the test board (real Trello webhook → Vercel):
**~870–1070 ms** from webhook receipt to successful assignment (parallel checks
~350–530 ms, assignment POST ~170–180 ms). A speed pass removed the target-card
GET from the hot path (payload-trust) and folded the Code-Review unlock into the
atomic slot call — expect lower check times on the next measured claims.

---

## Security notes

- Credentials exist only in Vercel env vars / `.env.local`; `.env*` is
  git-ignored; only `.env.example` with placeholders is committed.
- Nothing sensitive is ever rendered client-side or written to logs
  (`sanitizeError` redacts key/token parameters and URLs).
- Admin endpoints require `x-admin-token` (timing-safe compare).
- Webhook validation = secret in URL path + payload shape checks (Trello provides
  no signature mechanism).
- Failures are logged and acknowledged (200) so Trello never marks the webhook
  inactive due to our errors.

## Future expansion (not implemented — by design)

Multiple boards / users, configurable lists and claim limits, admin dashboard,
analytics, notifications. The code is structured (`lib/` separation, store
interface, one decision function) so these are additive, not rewrites.

# Credentials status — what's provided, what's still needed

Status as of the credentials the user provided. Provided values are written only to
`.env.local` (git-ignored) — nothing secret is committed to the repository.

---

## ✅ Provided and verified

| Value | Status | Verified |
|---|---|---|
| `TRELLO_KEY` | ✅ provided | token + key authenticate (`GET /1/members/me` → `semek_`) |
| `TRELLO_TOKEN` | ✅ provided | ✅ |
| `TRELLO_BOARD_ID` | ✅ `6533a97e21d5a9c876f9edb8` | resolved from the To Do list |
| `TRELLO_MEMBER_ID` | ✅ `65567ddc9d55b0994df60107` | matches the token's owner |
| `TODO_LIST_ID` | ✅ `6533a97e21d5a9c876f9edbb` | board lists fetched and matched by name ("To Do") |
| `DOING_LIST_ID` | ✅ `6533a97e21d5a9c876f9edbc` | "Doing" |
| `CODE_REVIEW_LIST_ID` | ✅ `6533a97e21d5a9c876f9edbd` | "Code Review" |
| `SUPABASE_URL` | ✅ `https://nbnotdakvjxercjpqdca.supabase.co` | REST endpoint reachable |
| `SUPABASE_SECRET_KEY` | ✅ provided (`sb_secret_...`) | authenticates against the REST API |
| `WEBHOOK_SECRET` | ✅ generated (`npm run secret`) | in `.env.local` |

## ✅ Schema applied (user ran it in the SQL editor)

`supabase/schema.sql` was run — both tables answer the REST API (verified:
`claim_state` and `claim_events` return `200 []` and accept writes). The full
claim pipeline was exercised live against the test board: claim, Code Review
unlock, second claim, and the no-second-claim guard all verified.

## ⏳ Still needed (1 item)

1. **Deploy to Vercel** — needs the Vercel account: import the GitHub repo
   (`https://github.com/Joshua-Onyekachukwu/trello_automator`), add the env vars,
   deploy. After that, set `APP_BASE_URL` to the deployed URL and register the
   webhook with `POST /api/trello/setup {"action":"create"}` (I'll do this once the
   app is live).

## Test board

- **[TEST] Trello Auto-Claim** — https://trello.com/b/SW5giYqC (private).
  Currently pointed at in `.env.local`. When switching back to the main board,
  use `npm run board -- <id-or-short-id>` and swap the four values (see README →
  Switching boards).

## Not needed (Supabase Auth leftovers)

`SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_JWKS_URL` are for Supabase Auth — this
service has no users, so they're unused. Keep them out of Vercel env vars.

---

## Security reminder

- Rotate the **Trello token** if it was ever shared anywhere else; it grants
  read/write on the account.
- The Supabase SECRET key bypasses RLS — treat it like a database password.
- If you ever re-share these values, prefer putting them in the Vercel dashboard
  yourself rather than pasting them in chat.

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

## ⏳ Still needed (2 items)

1. **Run `supabase/schema.sql` in the Supabase SQL editor** — the only step that
   requires dashboard access. The REST API cannot create tables (no SQL-over-HTTP),
   and the management API needs an access token. Paste the file's contents into
   **SQL Editor → Run** (takes ~10 seconds). This creates `claim_state` +
   `claim_events` and enables RLS.
   - Alternative: send the database password (Project Settings → Database → Reset
     database password) and I can apply it via the Supabase CLI.
2. **Deploy to Vercel** — needs the Vercel account: import the GitHub repo
   (`https://github.com/Joshua-Onyekachukwu/trello_automator`), add the env vars,
   deploy. After that, set `APP_BASE_URL` to the deployed URL and register the
   webhook with `POST /api/trello/setup {"action":"create"}` (I'll do this once the
   app is live).

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

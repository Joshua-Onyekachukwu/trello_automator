#!/usr/bin/env node
/**
 * Live daily-guard + Code Review unlock lifecycle smoke test.
 *
 *   npm run smoke [-- --url=<app-base-url>] [-- --timeout=60] [-- --keep-state]
 *
 * Drives the whole lifecycle against a real Trello board + the deployed/local
 * app, so it can be re-run after any change to prove nothing regressed:
 *
 *   0. Pre-flight: probes the installed claim_slot function for the
 *      Code-Review-unlocked claim contract (eligible <> false at the daily
 *      limit). Fails fast with a clear message if the function body is stale —
 *      no cards are touched until this passes.
 *   1. (Re)sets today's claim slot unless --keep-state.
 *   2. Card A enters To Do      → must be CLAIMED.
 *   3. Card A moves to Code Review → must unlock (eligible=true).
 *   4. Card B enters To Do (same Lagos day) → must be CLAIMED (the CR unlock
 *      + daily guard working together).
 *   5. Card C enters To Do      → informational: reports which guard stops it.
 *   6. Always archives every card it created, even on failure.
 *
 * Modes:
 *   --url=<base>   delivers the webhook payloads itself (exactly what Trello
 *                  sends) — works against a local server too.
 *   (no --url)     waits for the real registered Trello webhook (deployed app).
 *
 * Exit codes: 0 = full lifecycle passed, 1 = a step failed (printed), 2 = setup.
 */

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const appUrl = getArg('url', '').replace(/\/+$/, '');
const timeoutMs = Number(getArg('timeout', '60')) * 1000;
const keepState = args.includes('--keep-state');

const {
  TRELLO_KEY,
  TRELLO_TOKEN,
  TRELLO_BOARD_ID,
  TRELLO_MEMBER_ID,
  TODO_LIST_ID,
  CODE_REVIEW_LIST_ID,
  WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
} = process.env;

const REQUIRED = {
  TRELLO_KEY,
  TRELLO_TOKEN,
  TRELLO_BOARD_ID,
  TRELLO_MEMBER_ID,
  TODO_LIST_ID,
  CODE_REVIEW_LIST_ID,
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
};
const missing = Object.entries(REQUIRED)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing env vars in .env.local: ${missing.join(', ')}`);
  process.exit(2);
}
if (appUrl && !WEBHOOK_SECRET) {
  console.error('--url given but WEBHOOK_SECRET is missing from .env.local');
  process.exit(2);
}

const trello = (path, init = {}) =>
  fetch(
    `https://api.trello.com/1${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`,
    init,
  );

const supabase = async (path, opts = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${path} -> HTTP ${res.status}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

const lagosToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function claimEvents(cardId) {
  try {
    return await supabase(
      `/claim_events?card_id=eq.${cardId}&order=id.desc&limit=1` +
        '&select=id,event_type,success,error_message,details,processing_time_ms',
    );
  } catch {
    return [];
  }
}

async function getState() {
  const rows = await supabase(
    `/claim_state?user_member_id=eq.${encodeURIComponent(TRELLO_MEMBER_ID)}` +
      '&select=date,card_id,eligible,claim_count',
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return row
    ? { date: row.date, cardId: row.card_id, eligible: row.eligible === true, claimCount: row.claim_count ?? 0 }
    : { date: null, cardId: null, eligible: true, claimCount: 0 };
}

async function waitForEvent(cardId, predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const evs = await claimEvents(cardId);
    if (evs.length > 0) last = evs[0];
    if (last && predicate(last)) return last;
    await sleep(2000);
  }
  return last;
}

async function waitForState(predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await getState();
    if (predicate(state)) return state;
    await sleep(2000);
  }
  return state;
}

async function createCard(name) {
  const res = await trello(`/cards?idList=${TODO_LIST_ID}&name=${encodeURIComponent(name)}`, { method: 'POST' });
  const created = await res.json();
  if (!created.id) throw new Error(`card creation failed: ${JSON.stringify(created).slice(0, 300)}`);
  return created;
}

async function moveCard(cardId, listId) {
  const res = await trello(`/cards/${cardId}/idList?value=${listId}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`move to list failed: HTTP ${res.status}`);
}

async function archiveCard(cardId) {
  await trello(`/cards/${cardId}?closed=true`, { method: 'PUT' });
}

/** Deliver a webhook payload ourselves (simulated mode) or wait for Trello's real one. */
async function fire(cardId, type, listId, members) {
  if (!appUrl) {
    console.log('  waiting for the real Trello webhook...');
    return;
  }
  const payload = {
    action: {
      type,
      data: {
        card: { id: cardId, idList: listId, closed: false, idMembers: members },
        listAfter: { id: listId },
      },
    },
    model: { id: TRELLO_BOARD_ID },
  };
  const res = await fetch(`${appUrl}/api/trello/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`webhook endpoint answered HTTP ${res.status} — is the app running?`);
}

function timingOf(event) {
  if (!event?.details) return '';
  const d = event.details;
  return ` (checks ${d.trelloChecksMs ?? '?'}ms + assignment ${d.trelloAssignmentMs ?? '—'}ms = ${event.processing_time_ms}ms total)`;
}

async function main() {
  console.log('── Pre-flight: claim_slot contract ──────────────────────────────');

  // The exact probe that caught the buggy function body: a row that is
  // eligible=true at the daily limit must be accepted via eligible <> false.
  const today = lagosToday();
  const probeUser = `smoke-probe-${Date.now()}`;
  await supabase('/claim_state', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates',
    body: { user_member_id: probeUser, date: today, card_id: 'probe', eligible: true, claim_count: 2 },
  });
  const rpc = await supabase('/rpc/claim_slot', {
    method: 'POST',
    prefer: 'return=representation',
    body: { p_user: probeUser, p_date: today, p_card: 'probe-new', p_limit: 2, p_unlock: false },
  });
  await supabase(`/claim_state?user_member_id=eq.${encodeURIComponent(probeUser)}`, { method: 'DELETE' });
  const probeWon = Array.isArray(rpc) && rpc[0]?.won === true;
  if (!probeWon) {
    console.error(
      '❌ claim_slot rejected an eligible-at-limit claim — the installed function body is stale ' +
        '(missing the `eligible <> false` condition). Re-run the `create or replace function claim_slot` ' +
        'block from supabase/schema.sql, then re-run this smoke.',
    );
    process.exit(2);
  }
  console.log('✅ claim_slot accepts the Code-Review-unlocked claim (eligible <> false live)');

  if (!keepState) {
    console.warn(
      `⚠️  Resetting today's claim slot for ${TRELLO_MEMBER_ID} (this makes you eligible again today — ` +
        'use --keep-state to skip)',
    );
    await supabase(`/claim_state?user_member_id=eq.${encodeURIComponent(TRELLO_MEMBER_ID)}`, { method: 'DELETE' });
  }

  const created = [];
  const steps = [];

  const fail = (msg) => {
    console.error(`\n❌ ${msg}`);
    console.log('   common causes: not eligible today, already on a To Do/Doing card, webhook not registered (no --url), app not deployed');
    process.exit(1);
  };

  try {
    console.log('\n── Step 1: card A enters To Do → should be CLAIMED ────────────');
    const a = await createCard('Lifecycle-Smoke-A');
    created.push(a.id);
    console.log(`  card A ${a.id} — https://trello.com/c/${a.shortLink}`);
    await fire(a.id, 'createCard', TODO_LIST_ID, []);
    const evA = await waitForEvent(a.id, (e) => e.event_type === 'CARD_CLAIMED' && e.success, 'claim A');
    if (!evA) fail(`card A was not claimed (last event: ${evA?.event_type ?? 'none'})`);
    steps.push(['A → To Do', 'CLAIMED', `${evA.processing_time_ms}ms${timingOf(evA)}`]);
    console.log(`  ✅ CLAIMED${timingOf(evA)}`);

    console.log('\n── Step 2: move A to Code Review → should unlock (eligible=true) ──');
    await moveCard(a.id, CODE_REVIEW_LIST_ID);
    await fire(a.id, 'updateCard', CODE_REVIEW_LIST_ID, [TRELLO_MEMBER_ID]);
    const unlocked = await waitForState((s) => s.eligible === true, 'CR unlock');
    if (!unlocked) fail(`Code Review move did not unlock eligibility (state: ${JSON.stringify(unlocked)})`);
    steps.push(['A → Code Review', 'UNLOCKED', `eligible=true, count=${unlocked.claimCount}`]);
    console.log(`  ✅ eligible=true (count stays ${unlocked.claimCount})`);

    console.log('\n── Step 3: card B enters To Do (same Lagos day) → should be CLAIMED ──');
    const b = await createCard('Lifecycle-Smoke-B');
    created.push(b.id);
    console.log(`  card B ${b.id} — https://trello.com/c/${b.shortLink}`);
    await fire(b.id, 'createCard', TODO_LIST_ID, []);
    const evB = await waitForEvent(b.id, (e) => e.event_type === 'CARD_CLAIMED' && e.success, 'claim B');
    if (!evB) fail(`card B was not claimed (last event: ${evB?.event_type ?? 'none'})`);
    steps.push(['B → To Do (same day)', 'CLAIMED', `${evB.processing_time_ms}ms${timingOf(evB)}`]);
    console.log(`  ✅ CLAIMED${timingOf(evB)}`);

    console.log('\n── Step 4 (informational): card C enters To Do ─────────────────');
    const c = await createCard('Lifecycle-Smoke-C');
    created.push(c.id);
    console.log(`  card C ${c.id} — https://trello.com/c/${c.shortLink}`);
    await fire(c.id, 'createCard', TODO_LIST_ID, []);
    const evC = await waitForEvent(c.id, () => true, 'outcome C');
    const outcomeC = evC?.event_type ?? 'none';
    steps.push(['C → To Do', outcomeC, evC?.processing_time_ms ? `${evC.processing_time_ms}ms` : 'no event']);
    console.log(`  ${outcomeC === 'CARD_CLAIMED' ? '⚠️' : '⛔ blocked'} — ${outcomeC}${timingOf(evC)} (expected: a guard stops it)`);

    const state = await getState();
    console.log('\n── Summary ─────────────────────────────────────────────────────');
    for (const [what, result, detail] of steps) {
      console.log(`  ${what.padEnd(26)} ${result.padEnd(10)} ${detail}`);
    }
    console.log(`  claim_state: date=${state.date} card=${state.cardId} eligible=${state.eligible} count=${state.claimCount}`);
    console.log('\n✅ Full lifecycle passed.');
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    process.exit(2);
  } finally {
    for (const cardId of created) {
      try {
        await archiveCard(cardId);
      } catch {
        // best-effort cleanup — the cards are clearly named for manual cleanup
      }
    }
    if (created.length) console.log(`\nArchived ${created.length} throwaway card(s).`);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(2);
});

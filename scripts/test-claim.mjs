#!/usr/bin/env node
/**
 * Throwaway end-to-end claim test — proves the full pipeline safely.
 *
 *   npm run test-claim [-- --url=<app-base-url>] [-- --timeout=45]
 *
 * 1. Creates a throwaway card in the configured To Do list.
 * 2. Lets the service claim it:
 *      - with --url: POSTs the webhook payload to
 *        <url>/api/trello/webhook/<WEBHOOK_SECRET> — exactly what Trello would
 *        deliver, so it works against a local server too;
 *      - without --url: waits for the real registered Trello webhook.
 * 3. Reports the outcome and the timing recorded in claim_events.
 * 4. Always archives the throwaway card afterwards — real work is never touched.
 *
 * Exit codes: 0 = claimed, 1 = not claimed (reason printed), 2 = setup error.
 */

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const appUrl = getArg('url', '').replace(/\/+$/, '');
const timeoutMs = Number(getArg('timeout', '45')) * 1000;

const {
  TRELLO_KEY,
  TRELLO_TOKEN,
  TRELLO_BOARD_ID,
  TRELLO_MEMBER_ID,
  TODO_LIST_ID,
  WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
} = process.env;

if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_BOARD_ID || !TRELLO_MEMBER_ID || !TODO_LIST_ID) {
  console.error('Missing Trello env vars (TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID, TRELLO_MEMBER_ID, TODO_LIST_ID) in .env.local');
  process.exit(2);
}
if (appUrl && !WEBHOOK_SECRET) {
  console.error('--url given but WEBHOOK_SECRET is missing from .env.local');
  process.exit(2);
}
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SECRET_KEY in .env.local (needed to read the result from claim_events)');
  process.exit(2);
}

const trello = (path, init = {}) =>
  fetch(
    `https://api.trello.com/1${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`,
    init,
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cardEvents(cardId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/claim_events?card_id=eq.${cardId}&order=id.desc&limit=1` +
        '&select=id,event_type,success,error_message,details,processing_time_ms',
      { headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}` } },
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function main() {
  const name = `Auto-Claim Test ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  console.log(`Creating throwaway card "${name}" in To Do...`);
  const created = await (
    await trello(`/cards?idList=${TODO_LIST_ID}&name=${encodeURIComponent(name)}`, { method: 'POST' })
  ).json();
  if (!created.id) {
    console.error('Card creation failed:', JSON.stringify(created).slice(0, 300));
    process.exit(2);
  }
  const cardId = created.id;
  console.log(`  card ${cardId} — https://trello.com/c/${created.shortLink}`);

  if (appUrl) {
    console.log(`Delivering webhook payload to ${appUrl}/api/trello/webhook/<secret> (as Trello would)...`);
    const payload = {
      action: {
        type: 'createCard',
        data: { card: { id: cardId, idList: TODO_LIST_ID }, list: { id: TODO_LIST_ID } },
      },
      model: { id: TRELLO_BOARD_ID },
    };
    const res = await fetch(`${appUrl}/api/trello/webhook/${WEBHOOK_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`  webhook endpoint answered HTTP ${res.status} — is the app running?`);
    } else {
      console.log('  webhook acknowledged (200)');
    }
  } else {
    console.log('Waiting for the real Trello webhook (no --url given)...');
  }

  const deadline = Date.now() + timeoutMs;
  let lastEvent = null;
  let claimed = false;

  while (Date.now() < deadline) {
    const events = await cardEvents(cardId);
    if (events.length > 0) lastEvent = events[0];
    if (lastEvent?.event_type === 'CARD_CLAIMED' && lastEvent.success) {
      claimed = true;
      break;
    }
    await sleep(2000);
  }

  // One last read to capture the outcome even when the loop timed out.
  const events = await cardEvents(cardId);
  if (events.length > 0) lastEvent = events[0];
  if (!claimed && lastEvent?.event_type === 'CARD_CLAIMED' && lastEvent.success) claimed = true;

  console.log('');
  if (claimed) {
    const card = await (await trello(`/cards/${cardId}?fields=idMembers,closed`)).json();
    const onCard = Array.isArray(card.idMembers) && card.idMembers.includes(TRELLO_MEMBER_ID);
    console.log(onCard ? '✅ CLAIMED — you are on the card.' : '✅ CLAIMED (event recorded; membership check pending)');
  } else if (lastEvent) {
    console.log(`⛔ NOT CLAIMED — latest event: ${lastEvent.event_type}`);
    if (lastEvent.error_message) console.log(`   error: ${lastEvent.error_message}`);
  } else {
    console.log('⛔ NOT CLAIMED — no claim event arrived (webhook registered? app deployed? timeout?)');
  }
  if (lastEvent?.details) {
    console.log(`  timing: ${JSON.stringify(lastEvent.details)}`);
  }

  console.log('Archiving the throwaway card...');
  const arch = await (await trello(`/cards/${cardId}?closed=true`, { method: 'PUT' })).json();
  console.log(arch.closed ? '  archived ✓' : '  archive failed (check token scope)');
  process.exit(claimed ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(2);
});

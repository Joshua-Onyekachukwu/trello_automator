/**
 * Keep-warm endpoint for the claim path.
 *
 *   GET /api/trello/warm
 *
 * Does the same two reads the claim checks phase does (Trello my-cards GET +
 * Supabase claim-state GET, in parallel) so the function instance and its
 * keep-alive connections to Trello/Supabase stay warm between webhook
 * deliveries. Read-only, no auth, no state changes — safe for an external
 * pinger (e.g. a scheduled GitHub Actions workflow) to hit every few minutes.
 * A failed read still returns ok:true so the pinger never sees errors.
 */

import { getConfig } from '@/lib/config';
import { getStore } from '@/lib/state';
import { createTrelloClient } from '@/lib/trello';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const start = performance.now();
  try {
    const cfg = getConfig();
    await Promise.all([
      createTrelloClient().getMyCards(cfg.trelloMemberId),
      getStore().getState(cfg.trelloMemberId),
    ]);
  } catch {
    // Warming must never fail the ping — a transient read error is fine.
  }
  return new Response(
    JSON.stringify({ ok: true, ms: Math.round(performance.now() - start) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Admin endpoint: clear today's slot and eligibility without changing the daily claim count.
 *
 *   POST /api/trello/config/clear-today   header: x-admin-token: <WEBHOOK_SECRET>
 *   body: { "reason"?: string }
 *
 * This is the manual override for "I no longer have a project for today".
 * It keeps the daily claim count intact (so repeated clears do not silently
 * inflate it) and records a clear-today note on the user's claim_state row.
 */

import { NextRequest } from 'next/server';

import { getConfig } from '@/lib/config';
import { safeEqual } from '@/lib/security';
import { getStore } from '@/lib/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const cfg = getConfig();
  const header = req.headers.get('x-admin-token') ?? '';
  if (!safeEqual(header, cfg.webhookSecret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body: { reason?: unknown };
  try {
    body = (await req.json()) as { reason?: unknown };
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const reason =
    typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : 'manual clear-today';

  const store = getStore();
  let prevCardId: string | null = null;
  let howAdded: string = 'membership_unknown';
  try {
    const state = await store.getState(cfg.trelloMemberId);
    prevCardId = state.claimedCardId ?? null;
    howAdded = state.howAdded ?? 'membership_unknown';
  } catch {
    // If we cannot read state, still allow the clear using conservative defaults.
  }

  try {
    await store.clearToday(cfg.trelloMemberId, prevCardId, howAdded, `manual clear-today: ${reason}`);
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }

  return json({
    ok: true,
    cleared: true,
    prevClaimedCardId: prevCardId,
    note: `manual clear-today: ${reason}`,
  });
}

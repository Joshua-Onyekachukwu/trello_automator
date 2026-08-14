/**
 * Admin status endpoint.
 *
 *   GET /api/trello/status   header: x-admin-token: <WEBHOOK_SECRET>
 *
 * Returns the claim state, the most recent claim event (with timings), and the
 * registered Trello webhooks. Read-only; no secrets beyond what the caller
 * already knows.
 */

import { NextRequest } from 'next/server';

import { getConfig } from '@/lib/config';
import { logError, sanitizeError } from '@/lib/log';
import { safeEqual } from '@/lib/security';
import { getStore } from '@/lib/state';
import { createTrelloClient } from '@/lib/trello';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const cfg = getConfig();
  const header = req.headers.get('x-admin-token') ?? '';
  if (!safeEqual(header, cfg.webhookSecret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const [state, lastEvent, webhooks] = await Promise.all([
      getStore().getState(cfg.trelloMemberId),
      getStore().getLatestEvent(),
      createTrelloClient().listWebhooks(),
    ]);

    return json({
      ok: true,
      time: new Date().toISOString(),
      timezone: 'Africa/Lagos',
      config: {
        boardId: cfg.trelloBoardId,
        memberId: cfg.trelloMemberId,
        todoListId: cfg.todoListId,
        doingListId: cfg.doingListId,
        codeReviewListId: cfg.codeReviewListId,
      },
      state,
      lastEvent,
      webhooks: webhooks.map((w) => ({
        id: w.id,
        idModel: w.idModel,
        active: w.active,
        description: w.description,
        callbackURL: w.callbackURL,
      })),
    });
  } catch (err) {
    logError('STATUS_ERROR', { error: sanitizeError(err) });
    return json({ ok: false, error: sanitizeError(err) }, 500);
  }
}

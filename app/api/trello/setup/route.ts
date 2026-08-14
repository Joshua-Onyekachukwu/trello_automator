/**
 * Admin endpoint for the Trello webhook lifecycle.
 *
 *   POST /api/trello/setup        header: x-admin-token: <WEBHOOK_SECRET>
 *     { "action": "create" }   → register the webhook for TRELLO_BOARD_ID
 *     { "action": "status" }   → list webhooks on the token
 *     { "action": "delete" }   → remove the webhook for TRELLO_BOARD_ID
 *
 * No UI: this is a curl-able endpoint. See README for the full lifecycle
 * (create → Trello HEAD verification → test → status → delete).
 */

import { NextRequest } from 'next/server';

import { getConfig } from '@/lib/config';
import { log, logError, sanitizeError } from '@/lib/log';
import { safeEqual } from '@/lib/security';
import { createTrelloClient } from '@/lib/trello';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(req: NextRequest, secret: string): boolean {
  const header = req.headers.get('x-admin-token') ?? '';
  return header.length > 0 && safeEqual(header, secret);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const cfg = getConfig();
  if (!authorized(req, cfg.webhookSecret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const trello = createTrelloClient();
  try {
    switch (body.action) {
      case 'create': {
        const existing = await trello.listWebhooks();
        const match = existing.find((w) => w.idModel === cfg.trelloBoardId);
        if (match) {
          return json({
            ok: true,
            status: 'exists',
            webhook: { id: match.id, active: match.active, callbackURL: match.callbackURL },
          });
        }
        if (!cfg.appBaseUrl) {
          return json({ ok: false, error: 'APP_BASE_URL is not configured' }, 500);
        }
        const callbackURL = `${cfg.appBaseUrl}/api/trello/webhook/${cfg.webhookSecret}`;
        const created = await trello.createWebhook(callbackURL, 'Trello auto-claim');
        log('WEBHOOK_CREATED', { webhookId: created.id, active: created.active });
        return json({
          ok: true,
          status: 'created',
          webhook: { id: created.id, active: created.active, callbackURL: created.callbackURL },
        });
      }

      case 'status': {
        const webhooks = await trello.listWebhooks();
        return json({
          ok: true,
          webhooks: webhooks.map((w) => ({
            id: w.id,
            idModel: w.idModel,
            active: w.active,
            description: w.description,
            callbackURL: w.callbackURL,
          })),
        });
      }

      case 'delete': {
        const webhooks = await trello.listWebhooks();
        const matches = webhooks.filter((w) => w.idModel === cfg.trelloBoardId);
        const deleted: string[] = [];
        for (const w of matches) {
          await trello.deleteWebhook(w.id);
          deleted.push(w.id);
        }
        log('WEBHOOK_DELETED', { count: deleted.length });
        return json({ ok: true, deleted });
      }

      default:
        return json({ ok: false, error: 'Unknown action; use create | status | delete' }, 400);
    }
  } catch (err) {
    logError('SETUP_ERROR', { action: body.action, error: sanitizeError(err) });
    return json({ ok: false, error: sanitizeError(err) }, 500);
  }
}

/**
 * Trello webhook endpoint.
 *
 *   HEAD /api/trello/webhook/<secret>  — Trello's callback verification
 *   POST /api/trello/webhook/<secret>  — board events
 *
 * The handler is intentionally tiny: parse → classify → route. All logic lives
 * in lib/. The vast majority of events (comments, renames, moves to unrelated
 * lists) terminate on pure string checks with zero I/O.
 */

import { NextRequest } from 'next/server';

import { claimCard, type ClaimDeps } from '@/lib/claim';
import { getConfig } from '@/lib/config';
import { initConnections } from '@/lib/connections';
import { log, logError, sanitizeError } from '@/lib/log';
import { safeEqual } from '@/lib/security';
import { getStore } from '@/lib/state';
import { Timing } from '@/lib/timing';
import { createTrelloClient } from '@/lib/trello';
import { classifyEvent, parseWebhookPayload } from '@/lib/webhook';

// Warm the Trello/Supabase keep-alive connections before any claim runs.
initConnections();

// Node runtime: the Vercel Edge runtime hangs this route (~15s per request,
// measured 2026-08-14), which would get Trello to deactivate the webhook.
// Cold-start mitigation for the race path is handled by a keep-warm ping
// instead. safeEqual is Edge-safe already, so this is a one-line change to
// revisit later.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildDeps(timing: Timing): ClaimDeps {
  return {
    config: getConfig(),
    trello: createTrelloClient(),
    store: getStore(),
    timing,
  };
}

export async function HEAD(): Promise<Response> {
  // Trello sends a HEAD request when a webhook is created to verify the
  // callback URL responds. Always answer 200.
  return new Response(null, { status: 200 });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ secret: string }> },
): Promise<Response> {
  const timing = new Timing();
  const { secret } = await ctx.params;
  const cfg = getConfig();

  if (!safeEqual(secret, cfg.webhookSecret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const parsed = parseWebhookPayload(payload);
  log('CARD_RECEIVED', {
    actionType: parsed?.actionType ?? 'malformed',
    cardId: parsed?.cardId,
    listId: parsed?.listId,
  });

  if (!parsed) {
    log('CARD_IGNORED', { reason: 'malformed-payload' });
    return new Response('OK', { status: 200 });
  }

  // Keep the membership cache fresh straight from the payload (zero extra
  // Trello calls): create/updateCard payloads carry idMembers + the card's
  // list. A card stays cached while the user is a member of it, open, on this
  // board; archived or no-longer-member removes it. A failing sync never fails
  // the webhook — the claim path falls back to the authoritative GET.
  if (
    parsed.cardId &&
    parsed.boardId === cfg.trelloBoardId &&
    Array.isArray(parsed.idMembers)
  ) {
    const isMember = parsed.idMembers.includes(cfg.trelloMemberId);
    const listId = isMember && parsed.closed !== true ? (parsed.listId ?? null) : null;
    try {
      await getStore().syncUserCard(parsed.cardId, cfg.trelloBoardId, listId);
    } catch (err) {
      logError('CACHE_SYNC_FAILED', { cardId: parsed.cardId, error: sanitizeError(err) });
    }
  }

  const classification = classifyEvent(parsed, cfg);

  try {
    if (classification.kind === 'claim') {
      // Pass the card facts the payload already carries so the claim path can
      // skip the target-card GET round trip (idMembers is not always present;
      // claimCard falls back to a GET when it is missing).
      const record = await claimCard(parsed.cardId!, buildDeps(timing), {
        idBoard: parsed.boardId,
        idList: parsed.listId,
        idMembers: parsed.idMembers,
      });
      log(record.eventType, {
        cardId: record.cardId,
        outcome: record.outcome,
        error: record.error,
        timing: record.details,
      });
      return new Response('OK', { status: 200 });
    }

    if (classification.kind === 'eligibility') {
      // Code Review is an eligibility event only — it never assigns a card, and
      // per the one-per-day rule it does NOT unlock the daily slot either.
      // Only a new Lagos midnight resets eligibility. Acknowledge and log.
      log('CODE_REVIEW_MOVE', { cardId: parsed.cardId, listId: parsed.listId });
      return new Response('OK', { status: 200 });
    }

    log('CARD_IGNORED', {
      reason: classification.reason,
      cardId: parsed.cardId,
      actionType: parsed.actionType,
    });
    return new Response('OK', { status: 200 });
  } catch (err) {
    // Never let an unexpected failure bubble up: Trello marks webhooks inactive
    // after repeated non-2xx responses. Log it loudly and acknowledge.
    logError('WEBHOOK_ERROR', { cardId: parsed.cardId, error: sanitizeError(err) });
    return new Response('OK', { status: 200 });
  }
}

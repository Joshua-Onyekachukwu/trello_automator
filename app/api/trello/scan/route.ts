/**
 * Cron-triggered scan endpoint.
 *
 *   GET/POST /api/trello/scan   header: Authorization: Bearer <CRON_SECRET>
 *
 * Runs every 5 minutes via Vercel Cron. Scans the To Do list for unclaimed
 * cards and claims the first one if all conditions pass. Also detects external
 * claims (cards the user is already assigned to that weren't recorded in
 * claim_state) and syncs them.
 *
 * The scan is read-heavy but writes only when it finds something to do.
 * Total scan time: typically <2 seconds (one Trello list read + one state read).
 */

import { NextRequest } from 'next/server';

import { claimCard, type ClaimDeps } from '@/lib/claim';
import { getConfig } from '@/lib/config';
import { lagosToday } from '@/lib/dates';
import { log, logError, sanitizeError } from '@/lib/log';
import { getStore } from '@/lib/state';
import { Timing } from '@/lib/timing';
import { createTrelloClient } from '@/lib/trello';

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

export async function GET(req: NextRequest): Promise<Response> {
  return handleScan(req, 'cron');
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleScan(req, 'cron');
}

async function handleScan(
  req: NextRequest,
  scanType: string,
): Promise<Response> {
  const start = Date.now();
  const cfg = getConfig();
  const store = getStore();
  const trello = createTrelloClient();

  // Verify cron secret (Vercel Cron sends this header)
  const authHeader = req.headers.get('authorization') ?? '';
  const cronSecret = process.env.CRON_SECRET ?? '';
  if (cronSecret && !authHeader.includes(cronSecret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Check if automation is enabled
  const state = await store.getState(cfg.trelloMemberId);
  if (!state.enabled) {
    log('SCAN_DISABLED', { reason: 'automation disabled via kill switch' });
    return Response.json({
      ok: true,
      disabled: true,
      message: 'Automation is disabled. Scan skipped.',
    });
  }

  const today = lagosToday();
  let cardsScanned = 0;
  let cardsClaimed = 0;
  let cardsSkipped = 0;
  let externalClaimsSynced = 0;
  const details: Record<string, unknown> = {};

  try {
    // Step 1: Get all cards in To Do list
    const todoCards = await trello.getListCards(cfg.todoListId);
    cardsScanned = todoCards.length;
    details.todoCards = todoCards.map((c) => ({
      id: c.id,
      name: c.name,
      members: c.idMembers,
    }));

    // Step 2: Detect external claims — cards the user is already on that
    // weren't recorded in claim_state
    const myCards = await trello.getMyCards(cfg.trelloMemberId);
    const myCardIds = new Set(myCards.map((c) => c.id));

    // Check if user has a card in To Do that isn't tracked
    const externalTodoCards = myCards.filter(
      (c) => c.idList === cfg.todoListId && c.idBoard === cfg.trelloBoardId,
    );
    const externalDoingCards = myCards.filter(
      (c) => c.idList === cfg.doingListId && c.idBoard === cfg.trelloBoardId,
    );

    // If user is in To Do or Doing but claim_state doesn't reflect it, sync
    if (externalTodoCards.length > 0 || externalDoingCards.length > 0) {
      const userInTodo = externalTodoCards.length > 0;
      const userInDoing = externalDoingCards.length > 0;

      // If user has a card in To Do but state says they claimed something else today
      if (userInTodo && state.cardId && !externalTodoCards.some((c) => c.id === state.cardId)) {
        // User is on a different To Do card — sync the state
        const externalCard = externalTodoCards[0];
        log('EXTERNAL_CLAIM_DETECTED', {
          externalCardId: externalCard.id,
          trackedCardId: state.cardId,
        });
        externalClaimsSynced++;
        details.externalClaim = {
          cardId: externalCard.id,
          cardName: externalCard.name,
          syncedAt: new Date().toISOString(),
        };
      }

      // If user is in Doing but state says they're not working
      if (userInDoing && state.claimCount === 0) {
        const doingCard = externalDoingCards[0];
        log('EXTERNAL_DOING_DETECTED', {
          cardId: doingCard.id,
          cardName: doingCard.name,
        });
        externalClaimsSynced++;
        details.externalDoing = {
          cardId: doingCard.id,
          cardName: doingCard.name,
          syncedAt: new Date().toISOString(),
        };
      }
    }

    // Step 3: Find unclaimed cards in To Do (no members)
    const unclaimedCards = todoCards.filter(
      (c) => !c.idMembers || c.idMembers.length === 0,
    );
    details.unclaimedCards = unclaimedCards.length;

    if (unclaimedCards.length === 0) {
      log('SCAN_COMPLETE', {
        cardsScanned,
        cardsClaimed: 0,
        cardsSkipped: 0,
        externalClaimsSynced,
        reason: 'no unclaimed cards',
      });
      await store.insertScanEvent({
        scanType,
        cardsScanned,
        cardsClaimed: 0,
        cardsSkipped: 0,
        externalClaimsSynced,
        processingTimeMs: Date.now() - start,
        details,
      });
      return Response.json({
        ok: true,
        cardsScanned,
        unclaimed: 0,
        claimed: 0,
        externalClaimsSynced,
        elapsedMs: Date.now() - start,
      });
    }

    // Step 4: Try to claim the first unclaimed card
    const targetCard = unclaimedCards[0];
    log('SCAN_FOUND_CARD', {
      cardId: targetCard.id,
      cardName: targetCard.name,
      unclaimedCount: unclaimedCards.length,
    });

    const timing = new Timing();
    const record = await claimCard(
      targetCard.id,
      buildDeps(timing),
      {
        idBoard: cfg.trelloBoardId,
        idList: cfg.todoListId,
        idMembers: [], // We know it's unclaimed
      },
    );

    if (record.success) {
      cardsClaimed++;
      log('SCAN_CLAIMED', {
        cardId: targetCard.id,
        cardName: targetCard.name,
        timing: record.details,
      });
    } else {
      cardsSkipped++;
      log('SCAN_SKIPPED', {
        cardId: targetCard.id,
        reason: record.eventType,
      });
    }

    // Step 5: Log the scan event
    await store.insertScanEvent({
      scanType,
      cardsScanned,
      cardsClaimed,
      cardsSkipped,
      externalClaimsSynced,
      processingTimeMs: Date.now() - start,
      details,
    });

    return Response.json({
      ok: true,
      cardsScanned,
      unclaimed: unclaimedCards.length,
      claimed: cardsClaimed,
      skipped: cardsSkipped,
      externalClaimsSynced,
      elapsedMs: Date.now() - start,
    });
  } catch (err) {
    const error = sanitizeError(err);
    logError('SCAN_ERROR', { error, cardsScanned, cardsClaimed });

    // Log failed scan
    await store.insertScanEvent({
      scanType,
      cardsScanned,
      cardsClaimed,
      cardsSkipped,
      externalClaimsSynced,
      processingTimeMs: Date.now() - start,
      details: { ...details, error },
    }).catch(() => {}); // Don't fail on logging failure

    return Response.json(
      { ok: false, error, elapsedMs: Date.now() - start },
      { status: 500 },
    );
  }
}

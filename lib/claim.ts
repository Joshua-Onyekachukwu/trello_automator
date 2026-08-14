/**
 * The one central claim function. Everything the service does funnels through
 * claimCard(): it evaluates all five conditions against freshly-fetched Trello
 * state and, if they pass, sends the assignment request immediately.
 *
 * Decision order (per spec):
 *   1. Target card is in To Do
 *   2. No one already assigned to the target card
 *   3. User is not already assigned to a To Do card
 *   4. User is not already assigned to a Doing card
 *   5. User is eligible (one card per Lagos day unless claimed card is in Code Review)
 *
 * Concurrency: conditions 1–5 are evaluated from the parallel read fan-out,
 * then the per-user daily slot is claimed with one atomic conditional UPDATE
 * before the assignment POST. Exactly one of any set of concurrent claims wins
 * the slot, so the user is never assigned two cards in one Lagos day.
 */

import type { Config } from './config';
import { lagosToday } from './dates';
import { logError, sanitizeError } from './log';
import type { ClaimOutcome, ClaimRecord, ClaimState, ClaimStore } from './state';
import type { Timing } from './timing';
import { TrelloApiError, type TrelloClient, type TrelloMyCard } from './trello';

export { lagosToday };

export interface ClaimDeps {
  config: Config;
  trello: TrelloClient;
  store: ClaimStore;
  timing: Timing;
}

/**
 * The target-card facts the claim decision needs. The webhook payload carries
 * them (data.card.idList / idMembers / board) for create/update actions, so the
 * claim path can skip the target-card GET round trip entirely — the payload is
 * delivered after the change, exactly as fresh as a GET made at check time.
 * Fields are optional: when the payload lacks one (idMembers is not always
 * present), the claim path falls back to the GET.
 */
export interface TargetCardInfo {
  idBoard?: string;
  idList?: string;
  idMembers?: string[];
}

/** True when the payload carries everything the target-card check needs. */
function payloadCardComplete(p: TargetCardInfo | null): p is TargetCardInfo & {
  idList: string;
  idMembers: string[];
} {
  return (
    p !== null &&
    typeof p.idList === 'string' &&
    p.idList.length > 0 &&
    Array.isArray(p.idMembers)
  );
}

/**
 * Condition 5 — daily claim state.
 *
 * Eligible when:
 *   - it is a new Lagos day (or the user has never claimed), or
 *   - DAILY_LIMIT is 0 (unlimited), or
 *   - the number of cards claimed today is still under the daily limit, or
 *   - the claimed card has moved into Code Review (freshly derived from the
 *     user's live cards, so a missed webhook self-heals), or
 *   - the state already says eligible for today (Code Review unlock persisted).
 *
 * The limit is also enforced atomically by the database (claim_slot), so this
 * check is the fast path — a race can only make us stop, never exceed the limit.
 */
export function isEligible(
  state: ClaimState,
  myBoardCards: TrelloMyCard[],
  cfg: Config,
  today: string,
): boolean {
  if (state.date !== today) return true; // new Lagos day or first run
  if (cfg.dailyLimit === 0) return true; // unlimited
  if (state.claimCount < cfg.dailyLimit) return true; // still within the daily limit
  if (state.eligible) return true;
  if (
    state.cardId &&
    myBoardCards.some(
      (c) =>
        c.id === state.cardId &&
        c.idBoard === cfg.trelloBoardId &&
        c.idList === cfg.codeReviewListId,
    )
  ) {
    return true; // claimed card moved to Code Review
  }
  return false;
}

export async function claimCard(
  cardId: string,
  deps: ClaimDeps,
  /** Card facts from the webhook payload — skips the target-card GET when complete. */
  payloadCard: TargetCardInfo | null = null,
): Promise<ClaimRecord> {
  const { config, trello, store, timing } = deps;
  const memberId = config.trelloMemberId;

  let slotWon = false;

  try {
    // Parallel fan-out. The target card is already in hand when the webhook
    // payload carries it (idList + idMembers), so the GET is skipped — the hot
    // path does one Trello read (my cards) + one Supabase read (state), in
    // parallel. The state read stays in the fan-out: it is hidden behind the
    // Trello read's latency and is what the daily-limit decision needs.
    timing.markChecksStarted();
    const payloadComplete = payloadCardComplete(payloadCard);
    const [myCards, state, fetchedCard] = await Promise.all([
      trello.getMyCards(memberId),
      store.getState(memberId),
      payloadComplete ? Promise.resolve(null) : trello.getCard(cardId),
    ]);
    timing.markChecksCompleted();
    const today = lagosToday();
    const targetCard: TargetCardInfo = fetchedCard ?? payloadCard!;

    // Condition 1 — the target card must be in To Do (defensive; the webhook
    // classifier filters non-To-Do events first). When the payload has no board
    // id we skip the board check — the classifier already filtered by board.
    if (
      targetCard.idList !== config.todoListId ||
      (targetCard.idBoard !== undefined &&
        targetCard.idBoard !== '' &&
        targetCard.idBoard !== config.trelloBoardId)
    ) {
      return await finish(store, makeRecord(cardId, 'CARD_IGNORED', timing));
    }

    // Condition 2 — nobody may already own the target card.
    if (targetCard.idMembers !== undefined && targetCard.idMembers.length > 0) {
      return await finish(store, makeRecord(cardId, 'CARD_ALREADY_CLAIMED', timing));
    }

    // Conditions 3 & 4 — user must not already be working in To Do or Doing.
    const mine = myCards.filter((c) => c.idBoard === config.trelloBoardId);
    if (mine.some((c) => c.idList === config.todoListId)) {
      return await finish(store, makeRecord(cardId, 'USER_ALREADY_IN_TODO', timing));
    }
    if (mine.some((c) => c.idList === config.doingListId)) {
      return await finish(store, makeRecord(cardId, 'USER_ALREADY_IN_DOING', timing));
    }

    // Condition 5 — daily claim state.
    if (!isEligible(state, mine, config, today)) {
      return await finish(store, makeRecord(cardId, 'NOT_ELIGIBLE', timing));
    }

    // The Code Review unlock can be self-healed from live Trello data even if
    // the CR webhook was missed. It is folded into the same atomic slot call as
    // a p_unlock flag — one round trip, no separate eligibility write.
    const crUnlock =
      state.date === today &&
      state.eligible === false &&
      state.cardId !== null &&
      mine.some(
        (c) =>
          c.id === state.cardId &&
          c.idBoard === config.trelloBoardId &&
          c.idList === config.codeReviewListId,
      );

    // Atomically take today's slot (enforcing the daily limit in the database).
    // A losing caller must stop immediately, before any Trello POST.
    const slot = await store.tryClaim(memberId, today, cardId, config.dailyLimit, crUnlock);
    slotWon = slot.won;
    if (!slot.won) {
      return await finish(store, makeRecord(cardId, 'NOT_ELIGIBLE', timing, { raceLost: true }));
    }

    // All conditions pass → assign immediately. Trello's response is
    // authoritative; if the POST fails the slot is released again below.
    timing.markAssignmentStarted();
    try {
      await trello.addMemberToCard(cardId, memberId);
    } finally {
      timing.markAssignmentCompleted();
    }
    return await finish(store, makeRecord(cardId, 'CLAIMED', timing, { date: today }));
  } catch (err) {
    const error = sanitizeError(err);
    // If we held the slot but the assignment (or anything after) failed, undo
    // it so the day is not burned — a redelivered webhook can then retry.
    if (slotWon) {
      try {
        await store.releaseClaim(memberId);
      } catch (dbErr) {
        logError('DB_WRITE_FAILED', { cardId, error: sanitizeError(dbErr) });
      }
      slotWon = false;
    }
    const outcome: ClaimOutcome = err instanceof TrelloApiError ? 'TRELLO_ERROR' : 'INTERNAL_ERROR';
    logError(outcome, { cardId, error });
    return await finish(store, makeRecord(cardId, outcome, timing, { error }));
  }
}

/** Persist the decision's event log row; a failing log write never changes the outcome. */
async function finish(store: ClaimStore, record: ClaimRecord): Promise<ClaimRecord> {
  try {
    await store.insertEvent({
      cardId: record.cardId,
      eventType: record.eventType,
      success: record.success,
      processingTimeMs: record.processingTimeMs,
      details: record.details,
      errorMessage: record.error ?? null,
    });
  } catch (err) {
    logError('DB_WRITE_FAILED', { cardId: record.cardId, error: sanitizeError(err) });
  }
  return record;
}

/** Spec log-event names per decision outcome. */
const EVENT_TYPE: Record<ClaimOutcome, string> = {
  CLAIMED: 'CARD_CLAIMED',
  CARD_ALREADY_CLAIMED: 'CARD_ALREADY_CLAIMED',
  USER_ALREADY_IN_TODO: 'USER_ALREADY_IN_TODO',
  USER_ALREADY_IN_DOING: 'USER_ALREADY_IN_DOING',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  CARD_IGNORED: 'CARD_IGNORED',
  TRELLO_ERROR: 'TRELLO_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

function makeRecord(
  cardId: string,
  outcome: ClaimOutcome,
  timing: Timing,
  opts: { date?: string | null; error?: string; raceLost?: boolean } = {},
): ClaimRecord {
  const snapshot = timing.snapshot();
  const details: Record<string, unknown> = { ...(snapshot as unknown as Record<string, unknown>) };
  if (opts.raceLost) details.raceLost = true;
  return {
    outcome,
    eventType: EVENT_TYPE[outcome],
    cardId,
    date: opts.date ?? null,
    success: outcome === 'CLAIMED',
    processingTimeMs: snapshot.totalProcessingMs,
    details,
    error: opts.error,
  };
}

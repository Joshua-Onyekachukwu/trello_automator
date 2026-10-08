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
 *   5. User is eligible (one card per Lagos day)
 *
 * Daily rule: ONE claim per Lagos day. Moving the claimed card to Code Review
 * never unlocks the same-day slot — only a new Lagos midnight resets it. The
 * slot is claimed with one atomic conditional UPDATE (claim_slot) before the
 * assignment POST, so exactly one of any set of concurrent claims wins.
 */

import type { Config } from './config';
import { lagosToday } from './dates';
import { logError, sanitizeError } from './log';
import type {
  ClaimOutcome,
  ClaimRecord,
  ClaimState,
  ClaimStore,
  EligibilityReason,
  TodayAddSource,
} from './state';
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
 * Condition 5 — daily claim state. ONE claim per Lagos day.
 *
 * Eligible only when:
 *   - it is a new Lagos day (or the user has never claimed), or
 *   - the limit is 0 (unlimited), or
 *   - the number of cards claimed today is still under the daily limit.
 *
 * This no longer grants eligibility from eligible=true alone. Removal from the
 * claimed card can re-open eligibility for the rest of the day via a separate
 * path (see claimCard -> removeClaimedMember logic), not via this helper.
 *
 * `dailyLimit` is the effective limit — the per-user database override
 * (state.dailyLimit) when set, otherwise the DAILY_LIMIT env default.
 * Code Review does NOT unlock the slot — the user's rule: after moving the
 * claimed card to Code Review, the next chance to pick another card comes
 * after the next Lagos midnight. The limit is also enforced atomically by the
 * database (claim_slot), so this check is the fast path — a race can only
 * make us stop, never exceed the limit.
 */
export function isEligible(state: ClaimState, dailyLimit: number, today: string): boolean {
  if (state.date !== today) return true; // new Lagos day or first run
  if (dailyLimit === 0) return true; // unlimited
  return state.claimCount < dailyLimit; // still within the daily limit
}

/** Based on current live membership + today state, explain why the user is eligible/no. */
export function eligibilityReason(
  state: ClaimState,
  today: string,
  dailyLimit: number,
  onTodo: boolean,
  onDoing: boolean,
  claimedCardStillMine: boolean | null,
): EligibilityReason {
  if (state.date !== today) return 'new_day';
  if (dailyLimit === 0) return 'unlimited';
  if (onTodo || onDoing) {
    return onTodo ? 'on_todo_card' : 'on_doing_card';
  }
  if (state.claimCount < dailyLimit) return 'under_limit';
  // Claimed today and still taken.
  const stillTaken =
    claimedCardStillMine === null
      ? null
      : claimedCardStillMine;
  if (state.claimCount > 0 && !stillTaken) {
    return 'removed_from_claimed_card';
  }
  if (state.claimCount > 0) {
    return 'already_claimed_today';
  }
  if (state.howAdded === 'removed') {
    return 'removed_from_claimed_card';
  }
  return 'unknown';
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
    const [state, cached, fetchedCard] = await Promise.all([
      store.getState(memberId),
      // Membership cache (webhook-fed). A missing table (pre-migration) or a
      // read error returns null here and we fall back to the authoritative GET.
      store.getMyBoardCards(memberId, config.trelloBoardId).catch(() => null),
      payloadComplete ? Promise.resolve(null) : trello.getCard(cardId),
    ]);

    // Conditions 3 & 4 need the user's current cards on this board. Use the
    // cache when it is fresh (fast path — no my-cards GET on the hot path);
    // an empty or stale cache is never trusted and falls back to Trello.
    const mine =
      cached && cached.fresh
        ? cached.cards
        : (await trello.getMyCards(memberId)).filter((c) => c.idBoard === config.trelloBoardId);
    timing.markChecksCompleted();
    const today = lagosToday();
    const targetCard: TargetCardInfo = fetchedCard ?? payloadCard!;

    // Condition 1 — the target card must be in To Do (defensive; the webhook
    // classifier filters non-To-Do events first). When we do not have a board
    // id, we skip the board check — the classifier already filtered by board.
    if (
      targetCard.idList !== config.todoListId ||
      (targetCard.idBoard != null &&
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
    // This now covers any board membership on To Do/Doing, including external
    // adds and self-adds, not only cards the automation previously claimed.
    const onTodo = mine.some((c) => c.idList === config.todoListId);
    const onDoing = mine.some((c) => c.idList === config.doingListId);
    if (onTodo) {
      await noteTodayContext(store, memberId, {
        howAdded: 'external_add',
        note: 'already a member of a To Do card on this board',
      });
      return await finish(store, makeRecord(cardId, 'USER_ALREADY_IN_TODO', timing));
    }
    if (onDoing) {
      await noteTodayContext(store, memberId, {
        howAdded: 'external_add',
        note: 'already a member of a Doing card on this board',
      });
      return await finish(store, makeRecord(cardId, 'USER_ALREADY_IN_DOING', timing));
    }

    // Condition 5 — daily claim state. Code Review never unlocks the slot;
    // only a new Lagos day resets it. The effective limit is the per-user DB
    // override when set (changeable from the status page), else the env default.
    const dailyLimit = state.dailyLimit ?? config.dailyLimit;
    if (!isEligible(state, dailyLimit, today)) {
      return await finish(store, makeRecord(cardId, 'NOT_ELIGIBLE', timing));
    }

    // Atomically take today's slot (enforcing the daily limit in the database).
    // p_unlock is always false: Code Review does not unlock the same-day slot
    // (the SQL keeps the parameter for compatibility; the app never triggers
    // it, so the effective rule is one claim per Lagos day). A losing caller
    // must stop immediately, before any Trello POST.
    const slot = await store.tryClaim(memberId, today, cardId, dailyLimit, false);
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

    // Record that the automation claimed this card today.
    await store.recordTodayContext(memberId, cardId, 'automation', 'automation claimed this card');

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

/** Persist a short today-context note when we detect an interesting membership change. */
async function noteTodayContext(
  store: ClaimStore,
  memberId: string,
  opts: { howAdded: TodayAddSource; note: string; cardId?: string | null },
): Promise<void> {
  try {
    if (opts.cardId != null) {
      await store.recordTodayContext(memberId, opts.cardId, opts.howAdded, opts.note);
    } else {
      await store.recordMembershipNote(memberId, opts.howAdded, opts.note);
    }
  } catch (err) {
    // Membership/today-context bookkeeping must never change the claim outcome.
    logError('TODAY_CONTEXT_WRITE_FAILED', { memberId, error: sanitizeError(err) });
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

/** Return true when the user is still a member of the previously claimed card. */
export async function isStillOnClaimedCard(
  trello: TrelloClient,
  memberId: string,
  boardId: string,
  claimedCardId: string | null,
): Promise<boolean | null> {
  if (!claimedCardId) return null;
  try {
    const card = await trello.getCard(claimedCardId);
    return card.idBoard === boardId && card.idMembers.includes(memberId);
  } catch {
    return null;
  }
}

/** If the user is no longer on the claimed card, clear today and make them eligible again. */
export async function tryReleaseOnRemoval(
  store: ClaimStore,
  memberId: string,
  boardId: string,
  trello: TrelloClient,
  claimedCardId: string | null,
  prevHowAdded: TodayAddSource,
): Promise<boolean> {
  if (!claimedCardId) return false;
  const stillOn = await isStillOnClaimedCard(trello, memberId, boardId, claimedCardId);
  if (stillOn === true) return false;

  // User is no longer on the claimed card -> treat the project as gone for today.
  await store.clearToday(
    memberId,
    claimedCardId,
    'removed',
    `removed from claimed card ${claimedCardId}; day cleared for the rest of Lagos day`,
  );
  return true;
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

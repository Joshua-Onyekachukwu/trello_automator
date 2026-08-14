/**
 * Trello webhook payload parsing + event classification.
 *
 * Pure string logic — no network, no database. This is the first thing the
 * webhook handler runs, so the common case (comments, renames, moves to
 * unrelated lists) terminates before any I/O happens.
 */

import type { Config } from './config';

export interface ParsedWebhook {
  actionType: string;
  cardId: string | undefined;
  boardId: string | undefined;
  /** The list the card is currently in: listAfter → data.list → card.idList. */
  listId: string | undefined;
  listBeforeId: string | undefined;
  /** Archive/close flag — an archived card is not a list move. */
  closed: boolean | undefined;
  /**
   * Members on the card at event time (from data.card.idMembers). Present on
   * create/update card actions — lets the claim path skip the target-card GET
   * round trip. Undefined when the payload does not carry the array.
   */
  idMembers: string[] | undefined;
}

export type EventKind = 'claim' | 'eligibility' | 'ignore';

export interface EventClassification {
  kind: EventKind;
  reason?: string;
}

/**
 * Extract the fields we care about from a Trello webhook payload.
 * Returns null for anything that is not shaped like a Trello webhook.
 */
export function parseWebhookPayload(payload: unknown): ParsedWebhook | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const action = root.action as Record<string, unknown> | undefined;
  if (typeof action !== 'object' || action === null) return null;

  const actionType = action.type;
  if (typeof actionType !== 'string' || actionType.length === 0) return null;
  const data = (action.data ?? {}) as Record<string, unknown>;
  const card = data.card as Record<string, unknown> | undefined;
  const model = root.model as Record<string, unknown> | undefined;
  const board = data.board as Record<string, unknown> | undefined;

  const listAfter = data.listAfter as Record<string, unknown> | undefined;
  const listBefore = data.listBefore as Record<string, unknown> | undefined;
  const createdInList = data.list as Record<string, unknown> | undefined;

  return {
    actionType,
    cardId: typeof card?.id === 'string' ? card.id : undefined,
    boardId:
      typeof model?.id === 'string'
        ? model.id
        : typeof board?.id === 'string'
          ? board.id
          : undefined,
    listId: firstString(listAfter?.id, createdInList?.id, card?.idList),
    listBeforeId: typeof listBefore?.id === 'string' ? listBefore.id : undefined,
    closed: typeof card?.closed === 'boolean' ? card.closed : undefined,
    idMembers: Array.isArray(card?.idMembers)
      ? (card.idMembers as unknown[]).filter((m): m is string => typeof m === 'string')
      : undefined,
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Decide whether an event enters the claim logic, only touches eligibility
 * state, or should be ignored entirely.
 *
 *   - claim:       card created directly in To Do, or moved into To Do
 *   - eligibility: card moved into Code Review (never triggers an assignment)
 *   - ignore:      everything else (other lists, renames, comments, reorders,
 *                  other boards, non-card actions)
 */
export function classifyEvent(parsed: ParsedWebhook, cfg: Config): EventClassification {
  if (!parsed.cardId) return { kind: 'ignore', reason: 'missing-card-id' };
  if (parsed.boardId && parsed.boardId !== cfg.trelloBoardId) {
    return { kind: 'ignore', reason: 'other-board' };
  }

  if (parsed.actionType === 'createCard') {
    if (parsed.listId === cfg.todoListId) return { kind: 'claim' };
    return { kind: 'ignore', reason: 'created-in-other-list' };
  }

  if (parsed.actionType === 'updateCard') {
    // Archiving a card (closed = true) is not a list move — the card still
    // reports its old list, so without this check an archived To Do card would
    // re-enter the claim path (and could be claimed while archived).
    if (parsed.closed === true) return { kind: 'ignore', reason: 'card-archived' };
    // Reorder within the same list carries listBefore === listAfter.
    if (parsed.listId && parsed.listBeforeId === parsed.listId) {
      return { kind: 'ignore', reason: 'reorder-in-list' };
    }
    if (parsed.listId === cfg.todoListId) return { kind: 'claim' };
    if (parsed.listId === cfg.codeReviewListId) return { kind: 'eligibility' };
    return { kind: 'ignore', reason: 'other-list-move' };
  }

  return { kind: 'ignore', reason: `action-${parsed.actionType}` };
}

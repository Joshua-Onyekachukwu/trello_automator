/**
 * Webhook payload parsing and classification — the pure first stage of the
 * handler. Proves that only the two claim triggers enter the claim logic and
 * that everything else terminates immediately.
 */

import { describe, expect, it } from 'vitest';

import { getConfig } from '../lib/config';
import { classifyEvent, parseWebhookPayload, type ParsedWebhook } from '../lib/webhook';
import { makeConfig } from './fakes';

const cfg = makeConfig();

interface ActionOpts {
  type?: string;
  cardId?: string;
  listId?: string;
  listBeforeId?: string;
  boardId?: string;
  closed?: boolean;
}

function payload(opts: ActionOpts = {}): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (opts.listId) {
    data.list = { id: opts.listId };
    data.listAfter = { id: opts.listId };
  }
  if (opts.listBeforeId) data.listBefore = { id: opts.listBeforeId };
  if (opts.cardId) data.card = { id: opts.cardId, idList: opts.listId ?? null, closed: opts.closed };
  if (opts.boardId) data.board = { id: opts.boardId };
  return {
    action: { type: opts.type ?? 'updateCard', data },
    model: { id: opts.boardId ?? cfg.trelloBoardId },
  };
}

function classify(opts: ActionOpts) {
  return classifyEvent(parseWebhookPayload(payload(opts))!, cfg);
}

describe('parseWebhookPayload', () => {
  it('extracts card, board, and list fields', () => {
    const parsed = parseWebhookPayload(payload({ type: 'updateCard', cardId: 'abc', listId: 'list-todo', listBeforeId: 'list-backlog' }));
    expect(parsed).toEqual({
      actionType: 'updateCard',
      cardId: 'abc',
      boardId: 'board-1',
      listId: 'list-todo',
      listBeforeId: 'list-backlog',
      closed: undefined,
    });
  });

  it('falls back to data.list and card.idList when listAfter is absent', () => {
    const p = payload({ type: 'createCard', cardId: 'abc', listId: 'list-todo' }) as {
      action: { data: Record<string, unknown> };
    };
    delete p.action.data.listAfter;
    const parsed = parseWebhookPayload(p);
    expect(parsed?.listId).toBe('list-todo');
  });

  it('returns null for non-object payloads and non-action payloads', () => {
    expect(parseWebhookPayload(null)).toBeNull();
    expect(parseWebhookPayload('nope')).toBeNull();
    expect(parseWebhookPayload({ noAction: true })).toBeNull();
    expect(parseWebhookPayload({ action: { type: 42 } })).toBeNull();
  });
});

describe('classifyEvent — claim triggers', () => {
  it('card created directly in To Do → claim', () => {
    expect(classify({ type: 'createCard', cardId: 'A', listId: 'list-todo' })).toEqual({ kind: 'claim' });
  });

  it('card moved into To Do → claim', () => {
    expect(classify({ type: 'updateCard', cardId: 'A', listId: 'list-todo', listBeforeId: 'list-backlog' })).toEqual({ kind: 'claim' });
  });
});

describe('classifyEvent — eligibility only', () => {
  it('card moved into Code Review → eligibility (never claim)', () => {
    expect(classify({ type: 'updateCard', cardId: 'A', listId: 'list-cr' })).toEqual({ kind: 'eligibility' });
  });
});

describe('classifyEvent — ignored', () => {
  it('card moved to Doing → ignore', () => {
    expect(classify({ type: 'updateCard', cardId: 'A', listId: 'list-doing' })).toEqual({ kind: 'ignore', reason: 'other-list-move' });
  });

  it('card moved to any other list (Backlog/Done/Testing) → ignore', () => {
    for (const list of ['list-done', 'list-backlog', 'list-testing', 'list-blocked']) {
      expect(classify({ type: 'updateCard', cardId: 'A', listId: list })).toEqual({ kind: 'ignore', reason: 'other-list-move' });
    }
  });

  it('card renamed / description changed (updateCard without list fields) → ignore', () => {
    expect(classify({ type: 'updateCard', cardId: 'A' })).toEqual({ kind: 'ignore', reason: 'other-list-move' });
  });

  it('comment added → ignore', () => {
    expect(classify({ type: 'commentCard', cardId: 'A' })).toEqual({ kind: 'ignore', reason: 'action-commentCard' });
  });

  it('reorder within To Do (listBefore === listAfter) → ignore', () => {
    expect(classify({ type: 'updateCard', cardId: 'A', listId: 'list-todo', listBeforeId: 'list-todo' })).toEqual({ kind: 'ignore', reason: 'reorder-in-list' });
  });

  it('archiving a card in To Do → ignore (never re-enters the claim path)', () => {
    expect(classify({ type: 'updateCard', cardId: 'A', listId: 'list-todo', closed: true })).toEqual({ kind: 'ignore', reason: 'card-archived' });
  });

  it('card created in another list → ignore', () => {
    expect(classify({ type: 'createCard', cardId: 'A', listId: 'list-backlog' })).toEqual({ kind: 'ignore', reason: 'created-in-other-list' });
  });

  it('event from another board → ignore', () => {
    expect(classify({ type: 'createCard', cardId: 'A', listId: 'list-todo', boardId: 'other-board' })).toEqual({ kind: 'ignore', reason: 'other-board' });
  });
});

describe('classifyEvent — real env vars are honored', () => {
  it('uses configured list ids, not hardcoded ones', () => {
    const other = makeConfig({ todoListId: 'l1', doingListId: 'l2', codeReviewListId: 'l3' });
    const parsed = parseWebhookPayload(payload({ type: 'updateCard', cardId: 'A', listId: 'l1' }))!;
    expect(classifyEvent(parsed, other)).toEqual({ kind: 'claim' });
  });
});

describe('getConfig validation', () => {
  it('throws when a required variable is missing', () => {
    const env = { TRELLO_KEY: 'k', TRELLO_TOKEN: 't' };
    expect(() => getConfig(env)).toThrow(/TRELLO_BOARD_ID/);
  });
});

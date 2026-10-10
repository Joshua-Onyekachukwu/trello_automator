/**
 * HTTP-layer tests for the webhook route: secret validation, HEAD callback
 * verification, and routing of events to claim / eligibility / ignore paths.
 * The lib modules are mocked; everything about the route itself is real.
 */

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { claimCard } from '@/lib/claim';
import { getConfig } from '@/lib/config';
import { getStore } from '@/lib/state';
import { createTrelloClient } from '@/lib/trello';
import { HEAD, POST } from '../app/api/trello/webhook/[secret]/route';
import { card, FakeClaimStore, FakeTrello, makeConfig } from './fakes';

vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/state', () => ({ getStore: vi.fn() }));
// Only claimCard is faked; tryReleaseOnRemoval etc. stay real (they are part
// of what these tests exercise via the route).
vi.mock('@/lib/claim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/claim')>()),
  claimCard: vi.fn(),
}));
// Only the factory is faked — everything else (TrelloApiError, types) is real
// so the fakes in ./fakes keep working.
vi.mock('@/lib/trello', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/trello')>()),
  createTrelloClient: vi.fn(),
}));

const cfg = makeConfig();

function callPost(payload: unknown, secret = 'test-secret'): Promise<Response> {
  return POST(
    new NextRequest('http://localhost/api/trello/webhook/test-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ secret }) },
  );
}

function trelloPayload(type: string, cardId: string, listId?: string, boardId?: string): unknown {
  const data: Record<string, unknown> = { card: { id: cardId, idList: listId ?? null } };
  if (listId) data.listAfter = { id: listId };
  if (boardId) data.board = { id: boardId };
  return { action: { type, data }, model: { id: boardId ?? cfg.trelloBoardId } };
}

describe('webhook route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue(cfg);
    const store = new FakeClaimStore();
    vi.mocked(getStore).mockReturnValue(store);
    vi.mocked(claimCard).mockResolvedValue({
      outcome: 'CLAIMED',
      eventType: 'CARD_CLAIMED',
      cardId: 'cardA',
      date: '2026-08-14',
      success: true,
      processingTimeMs: 42,
      details: {},
    });
  });

  it('HEAD answers 200 (Trello callback verification)', async () => {
    const res = await HEAD();
    expect(res.status).toBe(200);
  });

  it('rejects a request with the wrong secret', async () => {
    const res = await callPost({}, 'wrong-secret');
    expect(res.status).toBe(401);
    expect(claimCard).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/trello/webhook/test-secret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      }),
      { params: Promise.resolve({ secret: 'test-secret' }) },
    );
    expect(res.status).toBe(400);
  });

  it('routes a card created in To Do into the claim path', async () => {
    const res = await callPost(trelloPayload('createCard', 'cardA', 'list-todo'));
    expect(res.status).toBe(200);
    expect(claimCard).toHaveBeenCalledOnce();
    expect(vi.mocked(claimCard).mock.calls[0][0]).toBe('cardA');
  });

  it('routes a card moved into To Do into the claim path', async () => {
    await callPost(trelloPayload('updateCard', 'cardA', 'list-todo'));
    expect(claimCard).toHaveBeenCalledOnce();
  });

  it('ignores a card moved to Doing (no claim, no eligibility)', async () => {
    const res = await callPost(trelloPayload('updateCard', 'cardA', 'list-doing'));
    expect(res.status).toBe(200);
    expect(claimCard).not.toHaveBeenCalled();
  });

  it('routes a Code Review move to the eligibility path (never claims, never unlocks)', async () => {
    const store = new FakeClaimStore();
    store.state = { userMemberId: 'member-1', date: '2026-08-14', cardId: 'cardA', claimCount: 1, eligible: false, enabled: true, updatedAt: null, claimedCardId: 'cardA', howAdded: 'automation', lastMembershipCheckedAt: null, lastMembershipNote: null };
    vi.mocked(getStore).mockReturnValue(store);

    const res = await callPost(trelloPayload('updateCard', 'cardA', 'list-cr'));
    expect(res.status).toBe(200);
    expect(claimCard).not.toHaveBeenCalled();
    // One card per day: the Code Review move must NOT touch claim state.
    expect(store.state.eligible).toBe(false);
    expect(store.state.claimCount).toBe(1);
  });

  it('ignores comments and renames', async () => {
    const res = await callPost(trelloPayload('commentCard', 'cardA'));
    expect(res.status).toBe(200);
    expect(claimCard).not.toHaveBeenCalled();
  });

  it('ignores events from other boards', async () => {
    const res = await callPost(trelloPayload('createCard', 'cardA', 'list-todo', 'other-board'));
    expect(res.status).toBe(200);
    expect(claimCard).not.toHaveBeenCalled();
  });

  it('acknowledges (200) even when the claim path throws', async () => {
    vi.mocked(claimCard).mockRejectedValue(new Error('boom'));
    const res = await callPost(trelloPayload('createCard', 'cardA', 'list-todo'));
    expect(res.status).toBe(200);
  });

  it('manual self-add: addMemberToCard for the configured member syncs the card into the cache', async () => {
    // Trello's addMemberToCard payload has no idMembers/idList — the route
    // must fetch the card live so the next claim sees the manual pick.
    const fakeTrello = new FakeTrello([card('X', 'list-todo', { idMembers: ['member-1'] })]);
    vi.mocked(createTrelloClient).mockReturnValue(fakeTrello);
    const store = new FakeClaimStore();
    vi.mocked(getStore).mockReturnValue(store);

    const res = await callPost({
      action: { type: 'addMemberToCard', data: { card: { id: 'X' }, idMember: 'member-1' } },
      model: { id: cfg.trelloBoardId },
    });

    expect(res.status).toBe(200);
    expect(fakeTrello.getCardCalls).toBe(1);
    expect(store.syncUserCardCalls).toEqual([{ cardId: 'X', boardId: 'board-1', listId: 'list-todo' }]);
    expect(claimCard).not.toHaveBeenCalled(); // membership events never claim
  });

  it('addMemberToCard about another member is ignored (no Trello call, no sync)', async () => {
    const fakeTrello = new FakeTrello([card('X', 'list-todo', { idMembers: ['someone-else'] })]);
    vi.mocked(createTrelloClient).mockReturnValue(fakeTrello);
    const store = new FakeClaimStore();
    vi.mocked(getStore).mockReturnValue(store);

    const res = await callPost({
      action: { type: 'addMemberToCard', data: { card: { id: 'X' }, idMember: 'someone-else' } },
      model: { id: cfg.trelloBoardId },
    });

    expect(res.status).toBe(200);
    expect(fakeTrello.getCardCalls).toBe(0);
    expect(store.syncUserCardCalls).toHaveLength(0);
  });

  it('removal: removeMemberFromCard from the claimed card clears the day (re-eligible, count kept)', async () => {
    // The user is no longer on card X (live GET shows empty idMembers): the
    // day must open up again for the rest of Lagos day, without touching the
    // daily claim count.
    const fakeTrello = new FakeTrello([card('X', 'list-todo')]);
    vi.mocked(createTrelloClient).mockReturnValue(fakeTrello);
    const store = new FakeClaimStore();
    store.state = {
      userMemberId: 'member-1',
      date: '2026-08-14',
      cardId: 'X',
      claimCount: 1,
      eligible: false,
      enabled: true,
      updatedAt: null,
      claimedCardId: 'X',
      howAdded: 'automation',
      lastMembershipCheckedAt: null,
      lastMembershipNote: null,
    };
    vi.mocked(getStore).mockReturnValue(store);

    const res = await callPost({
      action: { type: 'removeMemberFromCard', data: { card: { id: 'X' }, idMember: 'member-1' } },
      model: { id: cfg.trelloBoardId },
    });

    expect(res.status).toBe(200);
    expect(store.syncUserCardCalls).toEqual([{ cardId: 'X', boardId: 'board-1', listId: null }]);
    expect(store.state.eligible).toBe(true);
    expect(store.state.date).toBe('');
    expect(store.state.claimCount).toBe(1); // count is never inflated/cleared
    expect(store.state.howAdded).toBe('removed');
    expect(claimCard).not.toHaveBeenCalled();
  });
});

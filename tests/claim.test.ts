/**
 * The ten required tests, exercised through claimCard() with in-memory fakes.
 *  1. Empty To Do card + user free            → CLAIM
 *  2. Someone already assigned to target      → DON'T CLAIM
 *  3. User already in To Do                   → DON'T CLAIM
 *  4. User already in Doing                   → DON'T CLAIM
 *  5. User not eligible                       → DON'T CLAIM
 *  6. Claimed card moved to Code Review       → eligible becomes true
 *  7. New day                                 → eligible becomes true
 *  8. Card not in To Do                       → IGNORE
 *  9. Duplicate webhook                       → must not claim twice
 * 10. Two cards arrive nearly simultaneously  → must not claim both
 */

import { describe, expect, it } from 'vitest';

import { claimCard, isEligible, lagosToday, type ClaimDeps } from '../lib/claim';
import { Timing } from '../lib/timing';
import { TrelloApiError, type TrelloCard } from '../lib/trello';
import { card, FakeClaimStore, FakeTrello, makeConfig } from './fakes';

const TODAY = lagosToday();

function makeDeps(trello: FakeTrello, store: FakeClaimStore): ClaimDeps {
  return { config: makeConfig(), trello, store, timing: new Timing() };
}

function claimedDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return lagosToday(d);
}

describe('claimCard', () => {
  it('Test 1 — empty To Do card + user free → CLAIM', async () => {
    const trello = new FakeTrello([card('A', 'list-todo')]);
    const store = new FakeClaimStore();
    const record = await claimCard('A', makeDeps(trello, store));

    expect(record.outcome).toBe('CLAIMED');
    expect(record.success).toBe(true);
    expect(record.eventType).toBe('CARD_CLAIMED');
    expect(trello.addMemberCalls).toEqual([{ cardId: 'A', memberId: 'member-1' }]);
    expect(store.state.cardId).toBe('A');
    expect(store.state.eligible).toBe(false);
    expect(store.state.date).toBe(TODAY);
  });

  it('Test 2 — someone already assigned to target → DON\'T CLAIM', async () => {
    const trello = new FakeTrello([
      card('A', 'list-todo', { idMembers: ['alice'] }),
    ]);
    const store = new FakeClaimStore();
    const record = await claimCard('A', makeDeps(trello, store));

    expect(record.outcome).toBe('CARD_ALREADY_CLAIMED');
    expect(trello.addMemberCalls).toHaveLength(0);
    expect(store.state.cardId).toBeNull();
  });

  it('Test 3 — user already in To Do → DON\'T CLAIM', async () => {
    const trello = new FakeTrello([
      card('A', 'list-todo'),
      card('X', 'list-todo', { idMembers: ['member-1'] }),
    ]);
    const store = new FakeClaimStore();
    const record = await claimCard('A', makeDeps(trello, store));

    expect(record.outcome).toBe('USER_ALREADY_IN_TODO');
    expect(trello.addMemberCalls).toHaveLength(0);
  });

  it('Test 4 — user already in Doing → DON\'T CLAIM', async () => {
    const trello = new FakeTrello([
      card('A', 'list-todo'),
      card('X', 'list-doing', { idMembers: ['member-1'] }),
    ]);
    const store = new FakeClaimStore();
    const record = await claimCard('A', makeDeps(trello, store));

    expect(record.outcome).toBe('USER_ALREADY_IN_DOING');
    expect(trello.addMemberCalls).toHaveLength(0);
  });

  it('Test 5 — user not eligible (already claimed today, card not in Code Review) → DON\'T CLAIM', async () => {
    const trello = new FakeTrello([card('A', 'list-todo')]);
    const store = new FakeClaimStore();
    store.state = { userMemberId: 'member-1', date: TODAY, cardId: 'X', claimCount: 1, eligible: false, updatedAt: null };
    const record = await claimCard('A', makeDeps(trello, store));

    expect(record.outcome).toBe('NOT_ELIGIBLE');
    expect(trello.addMemberCalls).toHaveLength(0);
    expect(store.state.cardId).toBe('X');
  });

  it('Test 6 — claimed card moved to Code Review → eligible becomes true and next card can be claimed', async () => {
    const trello = new FakeTrello([
      card('A', 'list-todo'),
      card('X', 'list-cr', { idMembers: ['member-1'] }),
    ]);
    const store = new FakeClaimStore();
    store.state = { userMemberId: 'member-1', date: TODAY, cardId: 'X', claimCount: 1, eligible: false, updatedAt: null };

    // Code Review is an eligibility event only — it never assigns a card itself.
    const updated = await store.setEligible('member-1', 'X');
    expect(updated).toBe(true);
    expect(store.state.eligible).toBe(true);

    const record = await claimCard('A', makeDeps(trello, store));
    expect(record.outcome).toBe('CLAIMED');
    expect(store.state.cardId).toBe('A');
    expect(store.state.eligible).toBe(false);
  });

  it('Test 6b — self-healing: missed Code Review webhook is derived from live cards', async () => {
    const trello = new FakeTrello([
      card('A', 'list-todo'),
      card('X', 'list-cr', { idMembers: ['member-1'] }),
    ]);
    const store = new FakeClaimStore();
    store.state = { userMemberId: 'member-1', date: TODAY, cardId: 'X', claimCount: 1, eligible: false, updatedAt: null };

    // No setEligible call — claimCard must still notice X is in Code Review.
    const record = await claimCard('A', makeDeps(trello, store));
    expect(record.outcome).toBe('CLAIMED');
  });

  it('Test 7 — new Lagos day → eligible becomes true regardless of yesterday', async () => {
    const trello = new FakeTrello([card('A', 'list-todo')]);
    const store = new FakeClaimStore();
    store.state = {
      userMemberId: 'member-1',
      date: claimedDaysAgo(1),
      cardId: 'X',
      claimCount: 1,
      eligible: false,
      updatedAt: null,
    };
    const record = await claimCard('A', makeDeps(trello, store));

    expect(record.outcome).toBe('CLAIMED');
    expect(store.state.date).toBe(TODAY);
  });

  it('Test 8 — card not in To Do → IGNORE (defensive check inside claimCard)', async () => {
    const trello = new FakeTrello([card('A', 'list-doing')]);
    const store = new FakeClaimStore();
    const record = await claimCard('A', makeDeps(trello, store));

    expect(record.outcome).toBe('CARD_IGNORED');
    expect(trello.addMemberCalls).toHaveLength(0);
  });

  it('Test 9 — duplicate webhook for the same card → no second claim', async () => {
    const trello = new FakeTrello([card('A', 'list-todo')]);
    const store = new FakeClaimStore();

    const first = await claimCard('A', makeDeps(trello, store));
    expect(first.outcome).toBe('CLAIMED');

    // Second delivery re-verifies: Trello now shows the user on the card.
    const second = await claimCard('A', makeDeps(trello, store));
    expect(second.outcome).toBe('CARD_ALREADY_CLAIMED');
    expect(trello.addMemberCalls).toHaveLength(1);
    expect(store.records.filter((r) => r.eventType === 'CARD_CLAIMED')).toHaveLength(1);
  });

  it('Test 10 — two cards arrive nearly simultaneously → only one is claimed', async () => {
    const trello = new FakeTrello([card('A', 'list-todo'), card('B', 'list-todo')]);
    const store = new FakeClaimStore();

    const [ra, rb] = await Promise.all([
      claimCard('A', makeDeps(trello, store)),
      claimCard('B', makeDeps(trello, store)),
    ]);

    const outcomes = [ra.outcome, rb.outcome];
    expect(outcomes.filter((o) => o === 'CLAIMED')).toHaveLength(1);
    expect(trello.addMemberCalls).toHaveLength(1);
    // The loser must be a clean "stop", never a second claim.
    for (const o of outcomes) {
      expect(['CLAIMED', 'NOT_ELIGIBLE', 'USER_ALREADY_IN_TODO']).toContain(o);
    }
    expect(store.records.filter((r) => r.eventType === 'CARD_CLAIMED')).toHaveLength(1);
  });

  it('Test 10b — daily limit 2: two claims per day, a third is refused', async () => {
    const cfg = makeConfig({ dailyLimit: 2 });
    const trello = new FakeTrello([card('A', 'list-todo'), card('B', 'list-todo'), card('C', 'list-todo')]);
    const store = new FakeClaimStore();
    const deps = { config: cfg, trello, store, timing: new Timing() };

    // Real workflow: claim A, work it to Code Review → eligible again → claim B.
    const ra = await claimCard('A', deps);
    expect(ra.outcome).toBe('CLAIMED');
    trello.cards.get('A')!.idList = 'list-cr';

    const rb = await claimCard('B', deps);
    expect(rb.outcome).toBe('CLAIMED');
    expect(store.state.claimCount).toBe(2);

    // B finishes (moved past review): now 2 claims are used, nothing is in
    // To Do/Doing, and nothing is in Code Review to unlock → the count ceiling
    // binds: a third claim is refused.
    trello.cards.get('B')!.idList = 'list-done';
    const rc = await claimCard('C', deps);
    expect(rc.outcome).toBe('NOT_ELIGIBLE');
    expect(trello.addMemberCalls).toHaveLength(2);
    expect(store.state.claimCount).toBe(2);
  });

  it('Test 10c — unlimited (DAILY_LIMIT=0): all cards are claimed', async () => {
    const cfg = makeConfig({ dailyLimit: 0 });
    const trello = new FakeTrello([card('A', 'list-todo'), card('B', 'list-todo'), card('C', 'list-todo')]);
    const store = new FakeClaimStore();
    const deps = { config: cfg, trello, store, timing: new Timing() };

    const [ra, rb, rc] = await Promise.all([
      claimCard('A', deps),
      claimCard('B', deps),
      claimCard('C', deps),
    ]);
    expect([ra.outcome, rb.outcome, rc.outcome].filter((o) => o === 'CLAIMED')).toHaveLength(3);
    expect(trello.addMemberCalls).toHaveLength(3);
    expect(store.state.claimCount).toBe(3);
  });

  it('Trello POST failure → TRELLO_ERROR, slot released, retry can claim', async () => {
    class PostDownTrello extends FakeTrello {
      override async addMemberToCard(): Promise<void> {
        throw new TrelloApiError(500, 'server error');
      }
    }
    const trello = new PostDownTrello([card('A', 'list-todo')]);
    const store = new FakeClaimStore();
    const record = await claimCard('A', makeDeps(trello, store));

    expect(record.outcome).toBe('TRELLO_ERROR');
    expect(store.state.claimCount).toBe(0); // the failed claim was released

    // The day is not burned: a retry (or a different card) can still claim.
    const retry = await claimCard('A', makeDeps(new FakeTrello([card('A', 'list-todo')]), store));
    expect(retry.outcome).toBe('CLAIMED');
    expect(store.state.claimCount).toBe(1);
  });

  it('Trello API failure during checks → TRELLO_ERROR, no claim, lock released', async () => {
    class NetworkDownTrello extends FakeTrello {
      override async getCard(): Promise<TrelloCard> {
        throw new TrelloApiError(0, 'Trello request failed: network down');
      }
    }
    const trello = new NetworkDownTrello([card('A', 'list-todo')]);
    const store = new FakeClaimStore();
    const deps = makeDeps(trello, store);
    const record = await claimCard('A', deps);
    expect(record.outcome).toBe('TRELLO_ERROR');
    expect(trello.addMemberCalls).toHaveLength(0);

    // The lock must have been released — a later event can still claim.
    const retry = await claimCard('A', makeDeps(new FakeTrello([card('A', 'list-todo')]), store));
    expect(retry.outcome).toBe('CLAIMED');
  });
});

describe('isEligible', () => {
  const cfg = makeConfig();

  it('first run (no state) is eligible', () => {
    const state = { userMemberId: 'member-1', date: null, cardId: null, claimCount: 0, eligible: true, updatedAt: null };
    expect(isEligible(state, [], cfg, TODAY)).toBe(true);
  });

  it('new day resets eligibility', () => {
    const state = { userMemberId: 'member-1', date: claimedDaysAgo(1), cardId: 'X', claimCount: 1, eligible: false, updatedAt: null };
    expect(isEligible(state, [], cfg, TODAY)).toBe(true);
  });

  it('same day, claimed, no Code Review → not eligible', () => {
    const state = { userMemberId: 'member-1', date: TODAY, cardId: 'X', claimCount: 1, eligible: false, updatedAt: null };
    expect(isEligible(state, [], cfg, TODAY)).toBe(false);
  });

  it('same day, claimed card in Code Review → eligible', () => {
    const state = { userMemberId: 'member-1', date: TODAY, cardId: 'X', claimCount: 1, eligible: false, updatedAt: null };
    const myCards = [{ id: 'X', idList: 'list-cr', idBoard: 'board-1', name: 'X' }];
    expect(isEligible(state, myCards, cfg, TODAY)).toBe(true);
  });

  it('cards on other boards never count toward eligibility', () => {
    const state = { userMemberId: 'member-1', date: TODAY, cardId: 'X', claimCount: 1, eligible: false, updatedAt: null };
    const myCards = [{ id: 'X', idList: 'list-cr', idBoard: 'other-board', name: 'X' }];
    expect(isEligible(state, myCards, cfg, TODAY)).toBe(false);
  });
});

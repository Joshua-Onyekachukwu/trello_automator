/**
 * In-memory fakes so the claim logic can be tested independently of Trello and
 * Supabase. FakeClaimStore serializes the atomic slot operations with a promise
 * chain that mirrors the real REST store: concurrent tryClaim() calls are
 * processed one at a time and exactly one wins.
 */

import type { Config } from '../lib/config';
import type { ClaimEventInsert, ClaimEventRow, ClaimState, ClaimStore, SlotResult } from '../lib/state';
import {
  TrelloApiError,
  type TrelloCard,
  type TrelloClient,
  type TrelloMyCard,
  type TrelloWebhookModel,
} from '../lib/trello';

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    trelloKey: 'test-key',
    trelloToken: 'test-token',
    trelloBoardId: 'board-1',
    trelloMemberId: 'member-1',
    todoListId: 'list-todo',
    doingListId: 'list-doing',
    codeReviewListId: 'list-cr',
    supabaseUrl: 'https://test.supabase.co',
    supabaseSecretKey: 'sb_secret_test',
    webhookSecret: 'test-secret',
    appBaseUrl: 'https://example.com',
    ...overrides,
  };
}

export function card(
  id: string,
  listId: string,
  opts: { idMembers?: string[]; idBoard?: string } = {},
): TrelloCard {
  return {
    id,
    idList: listId,
    idBoard: opts.idBoard ?? 'board-1',
    idMembers: [...(opts.idMembers ?? [])],
    name: `card-${id}`,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeTrello implements TrelloClient {
  readonly cards = new Map<string, TrelloCard>();
  readonly addMemberCalls: Array<{ cardId: string; memberId: string }> = [];
  private latencyMs = 0;
  private postLatencyMs = 0;

  constructor(cards: TrelloCard[] = [], latencyMs = 0, postLatencyMs = 0) {
    for (const c of cards) this.cards.set(c.id, { ...c, idMembers: [...c.idMembers] });
    this.latencyMs = latencyMs;
    this.postLatencyMs = postLatencyMs;
  }

  async getCard(cardId: string): Promise<TrelloCard> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    const c = this.cards.get(cardId);
    if (!c) throw new TrelloApiError(404, `card not found: ${cardId}`);
    return { ...c, idMembers: [...c.idMembers] };
  }

  async getMyCards(memberId: string): Promise<TrelloMyCard[]> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    return [...this.cards.values()]
      .filter((c) => c.idMembers.includes(memberId))
      .map((c) => ({ id: c.id, idList: c.idList, idBoard: c.idBoard, name: c.name }));
  }

  async addMemberToCard(cardId: string, memberId: string): Promise<void> {
    if ((this.postLatencyMs || this.latencyMs) > 0) await sleep(this.postLatencyMs || this.latencyMs);
    const c = this.cards.get(cardId);
    if (!c) throw new TrelloApiError(404, `card not found: ${cardId}`);
    if (!c.idMembers.includes(memberId)) c.idMembers.push(memberId);
    this.addMemberCalls.push({ cardId, memberId });
  }

  async listWebhooks(): Promise<TrelloWebhookModel[]> {
    return [];
  }

  async createWebhook(): Promise<TrelloWebhookModel> {
    throw new Error('not implemented in fake');
  }

  async deleteWebhook(): Promise<void> {
    throw new Error('not implemented in fake');
  }
}

/**
 * Mirrors the real REST store semantics: slot-critical operations run through a
 * serialized chain so concurrent claims behave exactly like concurrent UPDATEs
 * on the same Postgres row (first wins, the rest see the committed state).
 */
export class FakeClaimStore implements ClaimStore {
  state: ClaimState = {
    userMemberId: 'member-1',
    date: null,
    cardId: null,
    eligible: true,
    updatedAt: null,
  };
  readonly records: ClaimEventInsert[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async getState(memberId: string): Promise<ClaimState> {
    return { ...this.state, userMemberId: memberId };
  }

  tryClaim(memberId: string, date: string, cardId: string, known: ClaimState): Promise<SlotResult> {
    return this.serial(async () => {
      const s = this.state;
      // Mirrors the real guard: the slot is free when there is no row, the row
      // is from another day, or the row is Code-Review-unlocked (eligible=true).
      const slotFree = s.cardId === null || s.date !== date || s.eligible === true;
      if (!slotFree) return { won: false, previous: known };
      const previous = known.date === null && known.cardId === null ? null : { ...known };
      this.state = {
        userMemberId: memberId,
        date,
        cardId,
        eligible: false,
        updatedAt: new Date().toISOString(),
      };
      return { won: true, previous };
    });
  }

  releaseClaim(memberId: string, previous: ClaimState | null): Promise<void> {
    return this.serial(async () => {
      this.state =
        previous === null
          ? { userMemberId: memberId, date: null, cardId: null, eligible: true, updatedAt: null }
          : { ...previous, updatedAt: new Date().toISOString() };
    });
  }

  setEligible(memberId: string, cardId: string): Promise<boolean> {
    return this.serial(async () => {
      if (this.state.cardId === cardId && this.state.eligible === false) {
        this.state = { ...this.state, eligible: true, updatedAt: new Date().toISOString() };
        return true;
      }
      return false;
    });
  }

  async insertEvent(event: ClaimEventInsert): Promise<void> {
    this.records.push({ ...event, details: event.details ? { ...event.details } : null });
  }

  async getLatestEvent(): Promise<ClaimEventRow | null> {
    const last = this.records[this.records.length - 1];
    if (!last) return null;
    return {
      id: this.records.length,
      cardId: last.cardId,
      eventType: last.eventType,
      success: last.success,
      processingTimeMs: last.processingTimeMs,
      details: last.details,
      errorMessage: last.errorMessage,
      createdAt: new Date().toISOString(),
    };
  }
}

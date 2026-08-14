/**
 * Tests for the Supabase REST store — the layer between the claim logic and
 * Postgres.
 *
 * These pin down the HTTP contract the concurrency guarantee depends on:
 *   - tryClaim() is ONE atomic call to the claim_slot RPC (the daily-limit
 *     guard lives in SQL, so the count can never exceed the limit under
 *     concurrency — the app never reads-then-writes);
 *   - releaseClaim() calls release_slot (a SQL-side decrement);
 *   - a losing claim reports won:false;
 *   - missing tables/functions fail loudly (fail-closed) instead of looking
 *     like a legitimate "already claimed" result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getConfig } from '../lib/config';
import { createStore, type ClaimState } from '../lib/state';

vi.mock('../lib/config', () => ({ getConfig: vi.fn() }));

const cfg = {
  trelloKey: 'k',
  trelloToken: 't',
  trelloBoardId: 'b',
  trelloMemberId: 'm',
  todoListId: 'todo',
  doingListId: 'doing',
  codeReviewListId: 'cr',
  supabaseUrl: 'https://proj.supabase.co',
  supabaseSecretKey: 'sb_secret_test_key',
  webhookSecret: 'ws',
  appBaseUrl: 'https://app.example.com',
  dailyLimit: 1,
};

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type FetchHandler = (req: CapturedRequest, index: number) => { status?: number; body?: unknown };

function stubFetch(handler: FetchHandler): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  const fetchMock = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const req: CapturedRequest = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(init.body as string) as unknown) : undefined,
    };
    calls.push(req);
    const res = handler(req, calls.length - 1);
    const status = res.status ?? 200;
    if (status === 204 || res.body === undefined) return new Response(null, { status });
    return new Response(JSON.stringify(res.body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return calls;
}

const KNOWN_EMPTY: ClaimState = {
  userMemberId: 'm',
  date: null,
  cardId: null,
  claimCount: 0,
  eligible: true,
  updatedAt: null,
};

beforeEach(() => {
  vi.mocked(getConfig).mockReturnValue(cfg);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getState', () => {
  it('returns default eligible state when no row exists', async () => {
    stubFetch(() => ({ body: [] }));
    const state = await createStore().getState('m');
    expect(state).toEqual(KNOWN_EMPTY);
  });

  it('normalizes a stored row including the daily claim count', async () => {
    stubFetch(() => ({
      body: [
        {
          date: '2026-08-14',
          card_id: 'A',
          claim_count: 2,
          eligible: false,
          updated_at: '2026-08-14T10:00:00Z',
        },
      ],
    }));
    const state = await createStore().getState('m');
    expect(state.date).toBe('2026-08-14');
    expect(state.cardId).toBe('A');
    expect(state.claimCount).toBe(2);
    expect(state.eligible).toBe(false);
    expect(state.updatedAt).toBe('2026-08-14T10:00:00.000Z');
  });
});

describe('tryClaim (claim_slot RPC)', () => {
  it('calls the atomic claim_slot function with the daily limit and unlock flag', async () => {
    const calls = stubFetch(() => ({ body: [{ won: true }] }));
    const result = await createStore().tryClaim('m', '2026-08-14', 'A', 2, true);

    expect(result).toEqual({ won: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/rpc/claim_slot');
    expect(calls[0].headers['apikey']).toBe('sb_secret_test_key');
    expect(calls[0].headers['Authorization']).toBe('Bearer sb_secret_test_key');
    expect(calls[0].body).toEqual({
      p_user: 'm',
      p_date: '2026-08-14',
      p_card: 'A',
      p_limit: 2,
      p_unlock: true,
    });
  });

  it('passes p_unlock:false when no Code-Review unlock applies', async () => {
    const calls = stubFetch(() => ({ body: [{ won: true }] }));
    await createStore().tryClaim('m', '2026-08-14', 'A', 1, false);
    expect(calls[0].body).toMatchObject({ p_unlock: false });
  });

  it('setDailyLimit upserts the per-user override (works before the first claim)', async () => {
    const calls = stubFetch(() => ({ status: 201, body: [{ user_member_id: 'm', daily_limit: 2 }] }));
    await createStore().setDailyLimit('m', 2);
    expect(calls[0].method).toBe('POST');
    expect(decodeURIComponent(calls[0].url)).toContain('on_conflict=user_member_id');
    expect(calls[0].headers.Prefer).toBe('resolution=merge-duplicates');
    expect(calls[0].body).toMatchObject({ user_member_id: 'm', daily_limit: 2 });
  });

  it('setDailyLimit(null) restores the env default', async () => {
    const calls = stubFetch(() => ({ status: 201, body: [{ user_member_id: 'm', daily_limit: null }] }));
    await createStore().setDailyLimit('m', null);
    expect(calls[0].body).toMatchObject({ user_member_id: 'm', daily_limit: null });
  });

  it('reports won:false when the database rejects the claim', async () => {
    stubFetch(() => ({ body: [{ won: false }] }));
    const result = await createStore().tryClaim('m', '2026-08-14', 'A', 1, false);
    expect(result.won).toBe(false);
  });

  it('passes dailyLimit 0 for unlimited', async () => {
    const calls = stubFetch(() => ({ body: [{ won: true }] }));
    await createStore().tryClaim('m', '2026-08-14', 'A', 0, false);
    expect(calls[0].body).toEqual({
      p_user: 'm',
      p_date: '2026-08-14',
      p_card: 'A',
      p_limit: 0,
      p_unlock: false,
    });
  });
});

describe('releaseClaim (release_slot RPC)', () => {
  it('decrements today\'s count via the release_slot function', async () => {
    const calls = stubFetch(() => ({ status: 204 }));
    await createStore().releaseClaim('m');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/rpc/release_slot');
    expect(calls[0].body).toEqual({ p_user: 'm' });
  });
});

describe('setEligible', () => {
  it('returns true when the claimed card matched and was unlocked', async () => {
    const calls = stubFetch(() => ({ body: [{ eligible: true }] }));
    expect(await createStore().setEligible('m', 'X')).toBe(true);
    expect(decodeURIComponent(calls[0].url)).toContain('card_id=eq.X');
    expect(decodeURIComponent(calls[0].url)).toContain('eligible=eq.false');
    expect(calls[0].body).toMatchObject({ eligible: true });
  });

  it('returns false when nothing matched (already unlocked or not the claimed card)', async () => {
    stubFetch(() => ({ body: [] }));
    expect(await createStore().setEligible('m', 'X')).toBe(false);
  });

  it('treats a 404 PGRST116 (no rows) as a non-match, not an error', async () => {
    stubFetch(() => ({ status: 404, body: { code: 'PGRST116', message: 'no rows' } }));
    expect(await createStore().setEligible('m', 'X')).toBe(false);
  });
});

describe('events', () => {
  it('inserts an event row with the timing details', async () => {
    const calls = stubFetch(() => ({ status: 201, body: [] }));
    await createStore().insertEvent({
      cardId: 'A',
      eventType: 'CARD_CLAIMED',
      success: true,
      processingTimeMs: 42,
      details: { totalProcessingMs: 42 },
      errorMessage: null,
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/claim_events');
    expect(calls[0].headers['Prefer']).toBe('return=minimal');
    expect(calls[0].body).toEqual({
      card_id: 'A',
      event_type: 'CARD_CLAIMED',
      success: true,
      processing_time_ms: 42,
      error_message: null,
      details: { totalProcessingMs: 42 },
    });
  });

  it('reads the latest event', async () => {
    stubFetch(() => ({
      body: [
        {
          id: 7,
          card_id: 'A',
          event_type: 'CARD_CLAIMED',
          success: true,
          processing_time_ms: 42,
          details: { totalProcessingMs: 42 },
          error_message: null,
          created_at: '2026-08-14T10:00:00Z',
        },
      ],
    }));
    const row = await createStore().getLatestEvent();
    expect(row?.id).toBe(7);
    expect(row?.eventType).toBe('CARD_CLAIMED');
    expect(row?.processingTimeMs).toBe(42);
    expect(row?.createdAt).toBe('2026-08-14T10:00:00.000Z');
  });

  it('returns null when there are no events', async () => {
    stubFetch(() => ({ body: [] }));
    expect(await createStore().getLatestEvent()).toBeNull();
  });
});

describe('failure modes (fail-closed)', () => {
  it('propagates network failures as plain errors', async () => {
    vi.stubGlobal(
      'fetch',
      (async () => {
        throw new Error('ENOTFOUND');
      }) as unknown as typeof fetch,
    );
    await expect(createStore().getState('m')).rejects.toThrow(/Supabase GET \/claim_state failed/);
  });

  it('throws when the claim_slot function does not exist (migration not run) instead of pretending we lost the race', async () => {
    stubFetch(() => ({
      status: 404,
      body: { code: 'PGRST202', message: "Could not find the function public.claim_slot" },
    }));
    await expect(createStore().tryClaim('m', '2026-08-14', 'A', 1, false)).rejects.toThrow(/HTTP 404/);
  });

  it('throws when the table does not exist (PGRST205) instead of pretending we lost the race', async () => {
    stubFetch(() => ({
      status: 404,
      body: { code: 'PGRST205', message: "Could not find the table 'public.claim_state'" },
    }));
    await expect(createStore().getState('m')).rejects.toThrow(/HTTP 404/);
  });
});

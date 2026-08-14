/**
 * Tests for the Supabase REST store — the layer that replaced the SQL driver.
 *
 * These pin down the exact HTTP contract the concurrency guarantee depends on:
 *   - tryClaim() uses one atomic conditional PATCH (the WHERE guard) or an
 *     INSERT with resolution=ignore-duplicates, never a read-then-write;
 *   - a losing claim (empty result / conflict) reports won:false;
 *   - releaseClaim() restores or deletes the slot;
 *   - missing tables fail loudly (fail-closed) instead of looking like a
 *     legitimate "already claimed" result.
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
  eligible: true,
  updatedAt: null,
};
const KNOWN_ROW: ClaimState = {
  userMemberId: 'm',
  date: '2026-08-13',
  cardId: 'X',
  eligible: false,
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

  it('normalizes a stored row', async () => {
    stubFetch(() => ({
      body: [{ date: '2026-08-14', card_id: 'A', eligible: false, updated_at: '2026-08-14T10:00:00Z' }],
    }));
    const state = await createStore().getState('m');
    expect(state.date).toBe('2026-08-14');
    expect(state.cardId).toBe('A');
    expect(state.eligible).toBe(false);
    expect(state.updatedAt).toBe('2026-08-14T10:00:00.000Z');
  });
});

describe('tryClaim', () => {
  it('claims a fresh day via INSERT with ignore-duplicates', async () => {
    const calls = stubFetch(() => ({
      status: 201,
      body: [{ user_member_id: 'm', date: '2026-08-14', card_id: 'A', eligible: false }],
    }));
    const result = await createStore().tryClaim('m', '2026-08-14', 'A', KNOWN_EMPTY);

    expect(result).toEqual({ won: true, previous: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/claim_state');
    expect(calls[0].headers['Prefer']).toContain('resolution=ignore-duplicates');
    expect(calls[0].headers['Prefer']).toContain('return=representation');
    expect(calls[0].headers['apikey']).toBe('sb_secret_test_key');
    expect(calls[0].headers['Authorization']).toBe('Bearer sb_secret_test_key');
    expect(calls[0].body).toEqual({
      user_member_id: 'm',
      date: '2026-08-14',
      card_id: 'A',
      eligible: false,
    });
  });

  it('loses the insert race when a row already exists (conflict → empty result)', async () => {
    stubFetch(() => ({ status: 201, body: [] }));
    const result = await createStore().tryClaim('m', '2026-08-14', 'A', KNOWN_EMPTY);
    expect(result.won).toBe(false);
  });

  it('claims an existing row with the atomic PATCH guard', async () => {
    const calls = stubFetch(() => ({
      body: [{ user_member_id: 'm', date: '2026-08-14', card_id: 'A', eligible: false }],
    }));
    const result = await createStore().tryClaim('m', '2026-08-14', 'A', KNOWN_ROW);

    expect(result).toEqual({ won: true, previous: KNOWN_ROW });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(decodeURIComponent(calls[0].url)).toContain(
      'or=(date.neq.2026-08-14,eligible.neq.false)',
    );
    expect(calls[0].url).toContain('user_member_id=eq.m');
    expect(calls[0].body).toMatchObject({ date: '2026-08-14', card_id: 'A', eligible: false });
  });

  it('loses when the PATCH guard matches nothing and the INSERT conflicts', async () => {
    let patch = true;
    stubFetch(() => {
      if (patch) {
        patch = false;
        return { body: [] }; // guard failed — another claim took today
      }
      return { status: 201, body: [] }; // INSERT conflict
    });
    const result = await createStore().tryClaim('m', '2026-08-14', 'A', KNOWN_ROW);
    expect(result.won).toBe(false);
  });

  it('wins via INSERT when the PATCH matched nothing because the row was released', async () => {
    let patch = true;
    stubFetch(() => {
      if (patch) {
        patch = false;
        return { body: [] }; // row vanished (a failed claim released it)
      }
      return { status: 201, body: [{ date: '2026-08-14', card_id: 'A', eligible: false }] };
    });
    const result = await createStore().tryClaim('m', '2026-08-14', 'A', KNOWN_ROW);
    expect(result).toEqual({ won: true, previous: null });
  });
});

describe('releaseClaim', () => {
  it('deletes the row when there was no prior state', async () => {
    const calls = stubFetch(() => ({ status: 204 }));
    await createStore().releaseClaim('m', null);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('user_member_id=eq.m');
  });

  it('restores the previous state when there was a prior row', async () => {
    const calls = stubFetch(() => ({ body: [] }));
    await createStore().releaseClaim('m', KNOWN_ROW);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toMatchObject({ date: '2026-08-13', card_id: 'X', eligible: false });
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

  it('throws when the table does not exist (PGRST205) instead of pretending we lost the race', async () => {
    stubFetch(() => ({
      status: 404,
      body: { code: 'PGRST205', message: "Could not find the table 'public.claim_state'" },
    }));
    await expect(createStore().getState('m')).rejects.toThrow(/HTTP 404/);
  });
});

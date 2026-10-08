/** HTTP tests for the admin config endpoint — card-visibility round-trip.
 *
 *  Pins the contract:
 *    - key absent  -> persisted value untouched
 *    - '' / null   -> cleared (env default restored)
 *    - allowlisted -> persisted
 *    - anything else -> 400, nothing written
 *    - auth is required on both the JSON and form paths.
 */

import { NextRequest } from 'next/server';
import { type MockInstance, beforeEach, describe, expect, it, vi } from 'vitest';

import { getConfig } from '@/lib/config';
import { getStore } from '@/lib/state';
import { POST } from '../app/api/trello/config/route';
import { FakeClaimStore, makeConfig } from './fakes';

vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/state', () => ({ getStore: vi.fn() }));

const cfg = makeConfig();
const URL = 'http://localhost/api/trello/config';

function jsonRequest(body: unknown, token?: string): NextRequest {
  return new NextRequest(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

function formRequest(fields: Array<[string, string]>): NextRequest {
  const params = new URLSearchParams();
  for (const [k, v] of fields) params.append(k, v);
  return new NextRequest(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
}

describe('config route — card visibility', () => {
  let store: FakeClaimStore;
  let setVis: MockInstance<(memberId: string, value: 'visible_card' | 'is_a_card' | null) => Promise<void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue(cfg);
    store = new FakeClaimStore();
    vi.mocked(getStore).mockReturnValue(store);
    setVis = vi.spyOn(store, 'setCardVisibilityState');
  });

  it('persists an allowlisted value', async () => {
    const res = await POST(jsonRequest({ cardVisibilityState: 'is_a_card' }, 'test-secret'));
    expect(res.status).toBe(200);
    expect(setVis).toHaveBeenCalledExactlyOnceWith('member-1', 'is_a_card');
  });

  it('clears with null to restore the env default', async () => {
    const res = await POST(jsonRequest({ cardVisibilityState: null }, 'test-secret'));
    expect(res.status).toBe(200);
    expect(setVis).toHaveBeenCalledExactlyOnceWith('member-1', null);
  });

  it('leaves the persisted value untouched when the key is absent', async () => {
    const res = await POST(jsonRequest({ dailyLimit: 1 }, 'test-secret'));
    expect(res.status).toBe(200);
    expect(setVis).not.toHaveBeenCalled();
  });

  it('rejects an invalid value with 400 and writes nothing', async () => {
    const res = await POST(jsonRequest({ cardVisibilityState: '<script>' }, 'test-secret'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; errors: string[] };
    expect(body.ok).toBe(false);
    expect(body.errors.join(' ')).toContain('cardVisibilityState');
    expect(setVis).not.toHaveBeenCalled();
  });

  it('form path: clears when the select is set to the env-default option', async () => {
    const res = await POST(
      formRequest([
        ['token', 'test-secret'],
        ['dailyLimit', '1'],
        ['cardVisibilityState', ''],
      ]),
    );
    expect(res.status).toBe(303);
    expect(setVis).toHaveBeenCalledExactlyOnceWith('member-1', null);
  });

  it('form path: persists a chosen value', async () => {
    const res = await POST(
      formRequest([
        ['token', 'test-secret'],
        ['cardVisibilityState', 'visible_card'],
      ]),
    );
    expect(res.status).toBe(303);
    expect(setVis).toHaveBeenCalledExactlyOnceWith('member-1', 'visible_card');
  });

  it('form path: an invalid crafted value is a 400', async () => {
    const res = await POST(
      formRequest([
        ['token', 'test-secret'],
        ['cardVisibilityState', 'evil'],
      ]),
    );
    expect(res.status).toBe(400);
    expect(setVis).not.toHaveBeenCalled();
  });

  it('rejects a wrong token before writing anything', async () => {
    const res = await POST(
      formRequest([
        ['token', 'wrong'],
        ['cardVisibilityState', 'is_a_card'],
      ]),
    );
    expect(res.status).toBe(401);
    expect(setVis).not.toHaveBeenCalled();
  });
});

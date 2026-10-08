/** HTTP tests for the manual clear-today endpoint.
 *
 *  Regression coverage for the status-page 401: the page posts an HTML form
 *  with the admin token in a `token` field (two inputs share the name), so the
 *  route must authenticate from form data, parse the form body, and redirect —
 *  not require an x-admin-token header and req.json().
 */

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getConfig } from '@/lib/config';
import { getStore } from '@/lib/state';
import { POST } from '../app/api/trello/config/clear-today/route';
import { FakeClaimStore, makeConfig } from './fakes';

vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/state', () => ({ getStore: vi.fn() }));

const cfg = makeConfig();
const URL = 'http://localhost/api/trello/config/clear-today';

function formRequest(fields: Array<[string, string]>): NextRequest {
  const params = new URLSearchParams();
  for (const [k, v] of fields) params.append(k, v);
  return new NextRequest(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
}

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

describe('clear-today route', () => {
  let store: FakeClaimStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue(cfg);
    store = new FakeClaimStore();
    vi.mocked(getStore).mockReturnValue(store);
    // A claimed-today state so the clear has something to clear.
    store.state.date = '2026-10-08';
    store.state.cardId = 'X';
    store.state.eligible = false;
    store.state.claimCount = 1;
    store.state.claimedCardId = 'X';
    store.state.howAdded = 'automation';
  });

  it('status-page form with the token field clears and redirects (the 401 regression)', async () => {
    const res = await POST(formRequest([['token', 'test-secret']]));
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/?cleared=1');
    expect(store.state.date).toBe('');
    expect(store.state.cardId).toBeNull();
    expect(store.state.eligible).toBe(true);
    expect(store.state.claimCount).toBe(1); // count untouched
    expect(store.state.lastMembershipNote).toContain('manual clear-today');
  });

  it('accepts the token from either of the two token inputs in the form', async () => {
    // First input left empty, second filled (same name, FormData.getAll).
    const res = await POST(
      formRequest([
        ['token', ''],
        ['token', 'test-secret'],
        ['dailyLimit', '1'],
      ]),
    );
    expect(res.status).toBe(303);
    expect(store.state.date).toBe('');
  });

  it('rejects a form without a valid token', async () => {
    const res = await POST(formRequest([['token', 'wrong-secret']]));
    expect(res.status).toBe(401);
    // Nothing was cleared.
    expect(store.state.date).toBe('2026-10-08');
    expect(store.state.lastMembershipNote).toBeNull();
  });

  it('JSON API with the admin header still works', async () => {
    const res = await POST(jsonRequest({ reason: 'testing' }, 'test-secret'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cleared: boolean; note: string };
    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(true);
    expect(body.note).toContain('manual clear-today: testing');
    expect(store.state.date).toBe('');
  });

  it('JSON without the header is 401', async () => {
    const res = await POST(jsonRequest({}));
    expect(res.status).toBe(401);
    expect(store.state.date).toBe('2026-10-08');
  });

  it('malformed JSON body is 400', async () => {
    const res = await POST(
      new NextRequest(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': 'test-secret' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
    expect(store.state.date).toBe('2026-10-08');
  });
});

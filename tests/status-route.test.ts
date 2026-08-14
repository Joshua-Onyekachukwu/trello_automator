/**
 * HTTP-layer tests for the admin status endpoint.
 */

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getConfig } from '@/lib/config';
import { getStore } from '@/lib/state';
import { createTrelloClient } from '@/lib/trello';
import { GET } from '../app/api/trello/status/route';
import { FakeClaimStore, makeConfig } from './fakes';

vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/state', () => ({ getStore: vi.fn() }));
vi.mock('@/lib/trello', () => ({ createTrelloClient: vi.fn() }));

const cfg = makeConfig();

const trelloMock = {
  getCard: vi.fn(),
  getMyCards: vi.fn(),
  getBoard: vi.fn(),
  addMemberToCard: vi.fn(),
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
};

function callStatus(token?: string): Promise<Response> {
  return GET(
    new NextRequest('http://localhost/api/trello/status', {
      headers: token ? { 'x-admin-token': token } : {},
    }),
  );
}

describe('status route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue(cfg);
    vi.mocked(getStore).mockReturnValue(new FakeClaimStore());
    vi.mocked(createTrelloClient).mockReturnValue(trelloMock as never);
    trelloMock.listWebhooks.mockResolvedValue([]);
    trelloMock.getBoard.mockResolvedValue({ id: cfg.trelloBoardId, name: 'Unique Sites' });
  });

  it('rejects without the admin token', async () => {
    const res = await callStatus();
    expect(res.status).toBe(401);
  });

  it('returns state, last event, and webhooks', async () => {
    const res = await callStatus('test-secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      state: { eligible: boolean };
      webhooks: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.state.eligible).toBe(true);
    expect(Array.isArray(body.webhooks)).toBe(true);
  });

  it('never includes secrets in the response', async () => {
    const res = await callStatus('test-secret');
    const text = await res.text();
    expect(text).not.toContain('test-key');
    expect(text).not.toContain('test-token');
    expect(text).not.toContain('test-secret');
  });
});

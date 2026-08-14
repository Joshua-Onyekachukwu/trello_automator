/**
 * HTTP-layer tests for the webhook lifecycle endpoint: admin auth, and the
 * create / status / delete actions against a mocked Trello client.
 */

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getConfig } from '@/lib/config';
import { createTrelloClient } from '@/lib/trello';
import { POST } from '../app/api/trello/setup/route';
import { makeConfig } from './fakes';

vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/trello', () => ({ createTrelloClient: vi.fn() }));

const cfg = makeConfig({ appBaseUrl: 'https://app.example.com' });

const trelloMock = {
  getCard: vi.fn(),
  getMyCards: vi.fn(),
  addMemberToCard: vi.fn(),
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
};

function callSetup(body: unknown, token?: string): Promise<Response> {
  return POST(
    new NextRequest('http://localhost/api/trello/setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-admin-token': token } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('setup route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue(cfg);
    vi.mocked(createTrelloClient).mockReturnValue(trelloMock as never);
    trelloMock.listWebhooks.mockResolvedValue([]);
    trelloMock.createWebhook.mockResolvedValue({ id: 'wh-1', idModel: 'board-1', callbackURL: 'https://app.example.com/api/trello/webhook/test-secret', description: null, active: true });
    trelloMock.deleteWebhook.mockResolvedValue(undefined);
  });

  it('rejects without the admin token', async () => {
    const res = await callSetup({ action: 'status' });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown action', async () => {
    const res = await callSetup({ action: 'explode' }, 'test-secret');
    expect(res.status).toBe(400);
  });

  it('create: reports an existing webhook for the board', async () => {
    trelloMock.listWebhooks.mockResolvedValue([
      { id: 'wh-1', idModel: 'board-1', callbackURL: 'x', description: null, active: true },
    ]);
    const res = await callSetup({ action: 'create' }, 'test-secret');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('exists');
    expect(trelloMock.createWebhook).not.toHaveBeenCalled();
  });

  it('create: registers the webhook with the secret in the callback URL', async () => {
    const res = await callSetup({ action: 'create' }, 'test-secret');
    expect(res.status).toBe(200);
    expect(trelloMock.createWebhook).toHaveBeenCalledWith(
      'https://app.example.com/api/trello/webhook/test-secret',
      expect.any(String),
    );
  });

  it('status: returns the registered webhooks', async () => {
    trelloMock.listWebhooks.mockResolvedValue([
      { id: 'wh-1', idModel: 'board-1', callbackURL: 'x', description: null, active: true },
    ]);
    const res = await callSetup({ action: 'status' }, 'test-secret');
    const body = (await res.json()) as { webhooks: unknown[] };
    expect(body.webhooks).toHaveLength(1);
  });

  it('delete: removes only webhooks for the configured board', async () => {
    trelloMock.listWebhooks.mockResolvedValue([
      { id: 'wh-1', idModel: 'board-1', callbackURL: 'x', description: null, active: true },
      { id: 'wh-2', idModel: 'other-board', callbackURL: 'y', description: null, active: true },
    ]);
    const res = await callSetup({ action: 'delete' }, 'test-secret');
    expect(res.status).toBe(200);
    expect(trelloMock.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(trelloMock.deleteWebhook).toHaveBeenCalledWith('wh-1');
  });
});

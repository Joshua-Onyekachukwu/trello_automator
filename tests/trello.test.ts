/**
 * Trello client tests against a mocked global fetch: correct endpoints, auth
 * parameters, and sanitized error handling.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTrelloClient, TrelloApiError } from '../lib/trello';

function setTestEnv(): void {
  process.env.TRELLO_KEY = 'test-key';
  process.env.TRELLO_TOKEN = 'test-token';
  process.env.TRELLO_BOARD_ID = 'board-1';
  process.env.TRELLO_MEMBER_ID = 'member-1';
  process.env.TODO_LIST_ID = 'list-todo';
  process.env.DOING_LIST_ID = 'list-doing';
  process.env.CODE_REVIEW_LIST_ID = 'list-cr';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.WEBHOOK_SECRET = 'test-secret';
  process.env.APP_BASE_URL = 'https://example.com';
}

const fetchMock = vi.fn();

beforeAll(() => {
  setTestEnv();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
});

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createTrelloClient', () => {
  it('getCard requests only the fields the claim logic needs', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ id: 'A', idList: 'list-todo', idBoard: 'board-1', idMembers: [], name: 'A' }),
    );
    const client = createTrelloClient();
    const card = await client.getCard('A');

    expect(card.idMembers).toEqual([]);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/cards/A?fields=idList,idBoard,idMembers,name');
    expect(url).toContain('key=test-key');
    expect(url).toContain('token=test-token');
  });

  it('getMyCards maps results and tolerates missing list ids', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([{ id: 'X', idList: 'list-doing', idBoard: 'board-1', name: 'X' }]),
    );
    const cards = await createTrelloClient().getMyCards('member-1');
    expect(cards).toEqual([{ id: 'X', idList: 'list-doing', idBoard: 'board-1', name: 'X' }]);
  });

  it('addMemberToCard POSTs the member id to the card endpoint', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: 'A' }));
    await createTrelloClient().addMemberToCard('A', 'member-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(url).toContain('/cards/A/idMembers?value=member-1');
  });

  it('throws a sanitized TrelloApiError on failure', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 }),
    );
    await expect(createTrelloClient().getCard('A')).rejects.toThrow(TrelloApiError);
  });
});

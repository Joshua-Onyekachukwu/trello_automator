/**
 * Trello REST client — the only place Trello API logic lives.
 *
 * Auth is the standard Trello key/token pair, passed as query parameters on
 * every request. URLs are never logged. Every call has a 5 s timeout so a slow
 * Trello cannot hang a webhook invocation.
 */

import { getConfig } from './config';

const TRELLO_API = 'https://api.trello.com/1';
const TIMEOUT_MS = 5_000;

export class TrelloApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'TrelloApiError';
    this.status = status;
  }
}

export interface TrelloCard {
  id: string;
  idList: string;
  idBoard: string;
  idMembers: string[];
  name: string;
}

/** A card the user is a member of — only the fields the claim logic needs. */
export interface TrelloMyCard {
  id: string;
  idList: string;
  idBoard: string;
  name: string;
}

export interface TrelloWebhookModel {
  id: string;
  idModel: string;
  callbackURL: string;
  description: string | null;
  active: boolean;
}

export interface TrelloBoard {
  id: string;
  name: string;
}

export interface TrelloClient {
  getCard(cardId: string): Promise<TrelloCard>;
  getMyCards(memberId: string): Promise<TrelloMyCard[]>;
  getBoard(boardId: string): Promise<TrelloBoard>;
  addMemberToCard(cardId: string, memberId: string): Promise<void>;
  listWebhooks(): Promise<TrelloWebhookModel[]>;
  createWebhook(callbackURL: string, description: string): Promise<TrelloWebhookModel>;
  deleteWebhook(webhookId: string): Promise<void>;
}

async function trelloFetch(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: Record<string, unknown>,
): Promise<unknown> {
  const cfg = getConfig();
  const separator = path.includes('?') ? '&' : '?';
  const url = `${TRELLO_API}${path}${separator}key=${cfg.trelloKey}&token=${cfg.trelloToken}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Network failures, timeouts, DNS errors — all Trello-origin failures are
    // TrelloApiError so the claim logic can classify them correctly.
    const detail = err instanceof Error ? err.message : String(err);
    throw new TrelloApiError(0, `Trello request failed: ${detail}`);
  }

  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      // ignore body read failures — the status line is enough
    }
    // Trello usually returns JSON {"message": "..."}; fall back to the status text.
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // not JSON — keep the raw text
    }
    throw new TrelloApiError(res.status, message || `HTTP ${res.status}`);
  }

  if (res.status === 204) return null;
  return (await res.json()) as unknown;
}

export function createTrelloClient(): TrelloClient {
  return {
    async getCard(cardId) {
      const data = (await trelloFetch(
        `/cards/${cardId}?fields=idList,idBoard,idMembers,name`,
      )) as Partial<TrelloCard>;
      return {
        id: data.id ?? cardId,
        idList: data.idList ?? '',
        idBoard: data.idBoard ?? '',
        idMembers: Array.isArray(data.idMembers) ? data.idMembers : [],
        name: data.name ?? '',
      };
    },

    async getMyCards(memberId) {
      const data = (await trelloFetch(
        `/members/${memberId}/cards?fields=idList,idBoard,name&filter=open`,
      )) as Array<Partial<TrelloMyCard>>;
      if (!Array.isArray(data)) return [];
      return data.map((c) => ({
        id: c.id ?? '',
        idList: c.idList ?? '',
        idBoard: c.idBoard ?? '',
        name: c.name ?? '',
      }));
    },

    async getBoard(boardId) {
      const data = (await trelloFetch(`/boards/${boardId}?fields=name`)) as Partial<TrelloBoard>;
      return { id: data.id ?? boardId, name: data.name ?? '' };
    },

    async addMemberToCard(cardId, memberId) {
      await trelloFetch(`/cards/${cardId}/idMembers?value=${memberId}`, 'POST');
    },

    async listWebhooks() {
      const data = (await trelloFetch(
        `/tokens/${getConfig().trelloToken}/webhooks`,
      )) as Array<Partial<TrelloWebhookModel>>;
      if (!Array.isArray(data)) return [];
      return data.map((w) => ({
        id: w.id ?? '',
        idModel: w.idModel ?? '',
        callbackURL: w.callbackURL ?? '',
        description: w.description ?? null,
        active: w.active ?? false,
      }));
    },

    async createWebhook(callbackURL, description) {
      const data = (await trelloFetch(`/tokens/${getConfig().trelloToken}/webhooks`, 'POST', {
        callbackURL,
        idModel: getConfig().trelloBoardId,
        description,
      })) as Partial<TrelloWebhookModel>;
      return {
        id: data.id ?? '',
        idModel: data.idModel ?? '',
        callbackURL: data.callbackURL ?? callbackURL,
        description: data.description ?? null,
        active: data.active ?? true,
      };
    },

    async deleteWebhook(webhookId) {
      await trelloFetch(`/tokens/${getConfig().trelloToken}/webhooks/${webhookId}`, 'DELETE');
    },
  };
}

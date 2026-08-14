/**
 * Claim state + events store backed by Supabase Postgres, accessed through the
 * Supabase REST API — no SQL driver and no DATABASE_URL required.
 *
 * Concurrency safety: the per-user daily slot is claimed by one atomic Postgres
 * function (`claim_slot`, defined in supabase/schema.sql) that serializes
 * concurrent claims and enforces the daily limit at the database level:
 *
 *   UPDATE claim_state
 *     SET date=today, card_id=$new, eligible=false,
 *         claim_count = CASE WHEN date = today THEN claim_count + 1 ELSE 1 END
 *     WHERE user_member_id=$u
 *       AND (date <> today OR eligible <> false OR limit = 0 OR claim_count < limit)
 *   → if 0 rows and no row exists, INSERT ... ON CONFLICT DO NOTHING
 *
 * Exactly one of any set of simultaneous claims that the limit allows wins
 * (Postgres re-evaluates the WHERE clause on the committed row), and the count
 * can never exceed the limit. A failed Trello assignment is undone with
 * `release_slot`, which decrements the count.
 */

import { getConfig } from './config';

const TIMEOUT_MS = 4_000;

export type ClaimOutcome =
  | 'CLAIMED'
  | 'CARD_ALREADY_CLAIMED'
  | 'USER_ALREADY_IN_TODO'
  | 'USER_ALREADY_IN_DOING'
  | 'NOT_ELIGIBLE'
  | 'CARD_IGNORED'
  | 'TRELLO_ERROR'
  | 'INTERNAL_ERROR';

export interface ClaimState {
  userMemberId: string;
  /** YYYY-MM-DD (Africa/Lagos) of the last claim; null before the first claim. */
  date: string | null;
  cardId: string | null;
  /** Number of cards claimed on `date`. */
  claimCount: number;
  eligible: boolean;
  updatedAt: string | null;
}

/** Everything recorded about one claim-path decision. */
export interface ClaimRecord {
  outcome: ClaimOutcome;
  eventType: string;
  cardId: string;
  date: string | null;
  success: boolean;
  processingTimeMs: number;
  details: Record<string, unknown>;
  error?: string;
}

export interface ClaimEventInsert {
  cardId: string | null;
  eventType: string;
  success: boolean;
  processingTimeMs: number | null;
  details: Record<string, unknown> | null;
  errorMessage: string | null;
}

export interface ClaimEventRow {
  id: number;
  cardId: string | null;
  eventType: string;
  success: boolean;
  processingTimeMs: number | null;
  details: unknown;
  errorMessage: string | null;
  createdAt: string;
}

export interface SlotResult {
  /** true if this caller won the slot; a losing caller must stop. */
  won: boolean;
}

export interface ClaimStore {
  getState(memberId: string): Promise<ClaimState>;
  /** Atomically claim a slot for today, enforcing the daily limit. Exactly one concurrent caller wins per allowed slot. */
  tryClaim(memberId: string, date: string, cardId: string, dailyLimit: number): Promise<SlotResult>;
  /** Undo a won slot whose Trello assignment failed (decrements today's count). */
  releaseClaim(memberId: string): Promise<void>;
  /** Code Review move: unlock today's claim for this card. Returns true if changed. */
  setEligible(memberId: string, cardId: string): Promise<boolean>;
  insertEvent(event: ClaimEventInsert): Promise<void>;
  getLatestEvent(): Promise<ClaimEventRow | null>;
}

interface StateRow {
  date: string | null;
  card_id: string | null;
  claim_count: number | null;
  eligible: boolean | null;
  updated_at: string | null;
}

interface EventRow {
  id: number;
  card_id: string | null;
  event_type: string;
  success: boolean;
  processing_time_ms: number | null;
  details: unknown;
  error_message: string | null;
  created_at: string;
}

function normalizeState(row: StateRow | undefined, memberId: string): ClaimState {
  if (!row) {
    // First run / never claimed → eligible by default.
    return {
      userMemberId: memberId,
      date: null,
      cardId: null,
      claimCount: 0,
      eligible: true,
      updatedAt: null,
    };
  }
  return {
    userMemberId: memberId,
    date: row.date && row.date.length > 0 ? row.date : null,
    cardId: row.card_id ?? null,
    claimCount: typeof row.claim_count === 'number' ? row.claim_count : 0,
    eligible: row.eligible === true,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

interface SupabaseOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: string;
  body?: unknown;
  prefer?: string;
}

/**
 * Minimal Supabase REST client. Credentials go in the apikey/Authorization
 * headers only — never in URLs or logs. Failures throw plain Errors; the claim
 * layer classifies them as INTERNAL_ERROR (fail-closed: no claim).
 */
async function supabase<T>(table: string, opts: SupabaseOptions): Promise<T> {
  const cfg = getConfig();
  const url = `${cfg.supabaseUrl}/rest/v1/${table}${opts.query ? `?${opts.query}` : ''}`;
  const headers: Record<string, string> = {
    apikey: cfg.supabaseSecretKey,
    Authorization: `Bearer ${cfg.supabaseSecretKey}`,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.prefer) headers['Prefer'] = opts.prefer;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Supabase ${opts.method} ${table} failed: ${detail}`);
  }

  if (res.status === 404) {
    // PostgREST can return 404 "no rows" for a bulk PATCH that matched nothing.
    // Distinguish that from a genuinely missing table/function (PGRST205/202).
    const text = await res.text().catch(() => '');
    try {
      const err = JSON.parse(text) as { code?: string };
      if (err.code === 'PGRST116') return [] as unknown as T;
    } catch {
      // not JSON — fall through to the error path below
    }
    throw new Error(`Supabase ${opts.method} ${table} failed: HTTP 404 ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${opts.method} ${table} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  if (res.status === 204) return null as T;
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null as T;
  }
}

let storeSingleton: ClaimStore | null = null;
/** Shared store instance for the process (Vercel keeps it warm between calls). */
export function getStore(): ClaimStore {
  storeSingleton ??= createStore();
  return storeSingleton;
}

export function createStore(): ClaimStore {
  return {
    async getState(memberId: string): Promise<ClaimState> {
      const rows = await supabase<StateRow[]>('/claim_state', {
        method: 'GET',
        query: `user_member_id=eq.${encodeURIComponent(memberId)}&select=date,card_id,claim_count,eligible,updated_at`,
      });
      return normalizeState(Array.isArray(rows) ? rows[0] : undefined, memberId);
    },

    async tryClaim(memberId, date, cardId, dailyLimit): Promise<SlotResult> {
      // One atomic Postgres call: enforces the daily limit and the CR-unlock
      // condition in the WHERE clause, increments claim_count in SQL, and
      // creates the row via ON CONFLICT DO NOTHING when it doesn't exist.
      const rows = await supabase<Array<{ won: boolean }>>('/rpc/claim_slot', {
        method: 'POST',
        prefer: 'return=representation',
        body: { p_user: memberId, p_date: date, p_card: cardId, p_limit: dailyLimit },
      });
      return { won: Array.isArray(rows) && rows[0]?.won === true };
    },

    async releaseClaim(memberId): Promise<void> {
      // Decrement today's count — undoes one failed claim. Safe under
      // concurrency: never clobbers another in-flight claim's count.
      await supabase('/rpc/release_slot', {
        method: 'POST',
        prefer: 'return=minimal',
        body: { p_user: memberId },
      });
    },

    async setEligible(memberId, cardId): Promise<boolean> {
      const updated = await supabase<StateRow[]>('/claim_state', {
        method: 'PATCH',
        query:
          `user_member_id=eq.${encodeURIComponent(memberId)}` +
          `&card_id=eq.${encodeURIComponent(cardId)}&eligible=eq.false`,
        prefer: 'return=representation',
        body: { eligible: true, updated_at: new Date().toISOString() },
      });
      return Array.isArray(updated) && updated.length > 0;
    },

    async insertEvent(event): Promise<void> {
      await supabase('/claim_events', {
        method: 'POST',
        prefer: 'return=minimal',
        body: {
          card_id: event.cardId,
          event_type: event.eventType,
          success: event.success,
          processing_time_ms: event.processingTimeMs,
          error_message: event.errorMessage,
          details: event.details,
        },
      });
    },

    async getLatestEvent(): Promise<ClaimEventRow | null> {
      const rows = await supabase<EventRow[]>('/claim_events', {
        method: 'GET',
        query:
          'order=id.desc&limit=1' +
          '&select=id,card_id,event_type,success,processing_time_ms,details,error_message,created_at',
      });
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) return null;
      return {
        id: row.id,
        cardId: row.card_id ?? null,
        eventType: row.event_type,
        success: row.success,
        processingTimeMs: row.processing_time_ms,
        details: row.details,
        errorMessage: row.error_message,
        createdAt: new Date(row.created_at).toISOString(),
      };
    },
  };
}

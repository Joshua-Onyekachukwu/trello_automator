/**
 * Minimal status page — deliberately plain, no UI framework. Shows the board
 * the service watches, whether the webhook is registered, the most recent
 * claim event with its measured processing time, and the daily claim limit.
 * The limit can be changed right here (1 / 2 / unlimited) — it is stored in
 * the database and applies immediately, no redeploy needed.
 */

import { getConfig } from '@/lib/config';
import { getStore } from '@/lib/state';
import { createTrelloClient } from '@/lib/trello';

export const dynamic = 'force-dynamic';

const row: React.CSSProperties = { display: 'flex', gap: '12px', padding: '6px 0' };
const label: React.CSSProperties = { width: 180, color: '#555' };
const value: React.CSSProperties = { fontFamily: 'ui-monospace, monospace' };
const select: React.CSSProperties = { padding: '4px 8px', marginRight: 8 };
const input: React.CSSProperties = { padding: '4px 8px', marginRight: 8, width: 200 };
const button: React.CSSProperties = { padding: '4px 14px' };

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const saved = params.saved === '1';

  let config: ReturnType<typeof getConfig> | null = null;
  let state: Awaited<ReturnType<ReturnType<typeof getStore>['getState']>> | null = null;
  let lastEvent: Awaited<ReturnType<ReturnType<typeof getStore>['getLatestEvent']>> | null = null;
  let webhookStatus: 'connected' | 'disconnected' | 'unknown' = 'unknown';
  let boardName = '';

  try {
    config = getConfig();
  } catch {
    // env not configured (e.g. local dev without .env.local) — show placeholders
  }

  if (config) {
    const store = getStore();
    const trello = createTrelloClient();
    try {
      state = await store.getState(config.trelloMemberId);
    } catch {
      state = null;
    }
    try {
      lastEvent = await store.getLatestEvent();
    } catch {
      lastEvent = null;
    }
    try {
      const webhooks = await trello.listWebhooks();
      const match = webhooks.find((w) => w.idModel === config!.trelloBoardId);
      webhookStatus = match ? (match.active ? 'connected' : 'disconnected') : 'disconnected';
    } catch {
      webhookStatus = 'unknown';
    }
    try {
      const board = await trello.getBoard(config.trelloBoardId);
      boardName = board.name;
    } catch {
      boardName = '';
    }
  }

  const effectiveLimit = state?.dailyLimit ?? config?.dailyLimit ?? null;
  const limitSource = state?.dailyLimit != null ? 'custom' : config ? 'env' : null;

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '32px 16px' }}>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Trello Auto Claim</h1>
      <p style={{ margin: '0 0 20px', color: '#777', fontSize: 13 }}>
        Claims an eligible, unclaimed card the moment it enters the To Do list.
      </p>

      {saved && (
        <p style={{ color: '#1a7f37', fontSize: 13, margin: '0 0 16px' }}>✓ Daily limit saved.</p>
      )}

      <div style={row}>
        <div style={label}>Status</div>
        <div style={value}>
          {config ? <span style={{ color: '#1a7f37' }}>ONLINE</span> : 'NOT CONFIGURED'}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Board</div>
        <div style={value}>
          {boardName || '—'}
          {config ? ` (${config.trelloBoardId.slice(0, 8)}…)` : ''}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Webhook</div>
        <div style={value}>
          {webhookStatus === 'connected' && <span style={{ color: '#1a7f37' }}>CONNECTED</span>}
          {webhookStatus === 'disconnected' && <span style={{ color: '#c62828' }}>DISCONNECTED</span>}
          {webhookStatus === 'unknown' && 'UNKNOWN'}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Daily Limit</div>
        <div style={value}>
          {effectiveLimit === 0
            ? 'Unlimited'
            : `${effectiveLimit} per day`}
          {limitSource === 'custom' && ' (custom)'}
          {limitSource === 'env' && ` (env default)`}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Last Event</div>
        <div style={value}>
          {lastEvent ? `${lastEvent.cardId ?? '—'} (${lastEvent.eventType})` : '—'}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Last Result</div>
        <div style={value}>
          {lastEvent
            ? `${lastEvent.eventType}${lastEvent.errorMessage ? ` — ${lastEvent.errorMessage}` : ''}`
            : '—'}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Last Processing Time</div>
        <div style={value}>
          {lastEvent?.processingTimeMs != null ? `${lastEvent.processingTimeMs}ms` : '—'}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Eligible</div>
        <div style={value}>{state ? String(state.eligible) : '—'}</div>
      </div>
      <div style={row}>
        <div style={label}>Claimed Today</div>
        <div style={value}>{state ? `${state.claimCount} card(s)` : '—'}</div>
      </div>
      <div style={row}>
        <div style={label}>Claimed Card</div>
        <div style={value}>{state?.cardId ?? '—'}</div>
      </div>
      <div style={row}>
        <div style={label}>Time Zone</div>
        <div style={value}>Africa/Lagos (resets at midnight)</div>
      </div>

      {config && (
        <form
          method="POST"
          action="/api/trello/config"
          style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #e0e0e0' }}
        >
          <div style={{ marginBottom: 6, color: '#333', fontSize: 14, fontWeight: 600 }}>
            Daily limit
          </div>
          <p style={{ margin: '0 0 10px', color: '#777', fontSize: 12 }}>
            One card per day by default. Choose 2 per day, or Unlimited (0). Code Review never
            unlocks the slot — only midnight resets it. Saved instantly, no redeploy.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <select name="dailyLimit" defaultValue={effectiveLimit ?? ''} style={select}>
              <option value="1">1 per day</option>
              <option value="2">2 per day</option>
              <option value="0">Unlimited</option>
              {config && (
                <option value="">Default (env: {config.dailyLimit})</option>
              )}
            </select>
            <input type="password" name="token" placeholder="Admin token" required style={input} />
            <button type="submit" style={button}>
              Save
            </button>
          </div>
        </form>
      )}
    </main>
  );
}

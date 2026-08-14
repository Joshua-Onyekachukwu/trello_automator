/**
 * Minimal status page — deliberately plain, no UI framework. Shows whether the
 * service is up, whether the Trello webhook is registered, and the most recent
 * claim event with its measured processing time. Nothing sensitive is rendered.
 */

import { getConfig } from '@/lib/config';
import { getStore } from '@/lib/state';
import { createTrelloClient } from '@/lib/trello';

export const dynamic = 'force-dynamic';

const row: React.CSSProperties = { display: 'flex', gap: '12px', padding: '6px 0' };
const label: React.CSSProperties = { width: 180, color: '#555' };
const value: React.CSSProperties = { fontFamily: 'ui-monospace, monospace' };

export default async function HomePage() {
  let config: ReturnType<typeof getConfig> | null = null;
  let state: Awaited<ReturnType<ReturnType<typeof getStore>['getState']>> | null = null;
  let lastEvent: Awaited<ReturnType<ReturnType<typeof getStore>['getLatestEvent']>> | null = null;
  let webhookStatus: 'connected' | 'disconnected' | 'unknown' = 'unknown';

  try {
    config = getConfig();
  } catch {
    // env not configured (e.g. local dev without .env.local) — show placeholders
  }

  if (config) {
    const store = getStore();
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
      const webhooks = await createTrelloClient().listWebhooks();
      const match = webhooks.find((w) => w.idModel === config!.trelloBoardId);
      webhookStatus = match ? (match.active ? 'connected' : 'disconnected') : 'disconnected';
    } catch {
      webhookStatus = 'unknown';
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '32px 16px' }}>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Trello Auto Claim</h1>
      <p style={{ margin: '0 0 20px', color: '#777', fontSize: 13 }}>
        Claims an eligible, unclaimed card the moment it enters the To Do list.
      </p>

      <div style={row}>
        <div style={label}>Status</div>
        <div style={value}>
          {config ? <span style={{ color: '#1a7f37' }}>ONLINE</span> : 'NOT CONFIGURED'}
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
        <div style={label}>Claimed Card</div>
        <div style={value}>{state?.cardId ?? '—'}</div>
      </div>
      <div style={row}>
        <div style={label}>Time Zone</div>
        <div style={value}>Africa/Lagos</div>
      </div>
    </main>
  );
}

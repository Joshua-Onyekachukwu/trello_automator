/**
 * Minimal status page — deliberately plain, no UI framework. Shows the board
 * the service watches, whether the webhook is registered, the most recent
 * claim event with its measured processing time, and the daily claim limit.
 * The limit can be changed right here (1 / 2 / unlimited) — it is stored in
 * the database and applies immediately, no redeploy needed.
 */

import { getConfig } from '@/lib/config';
import { lagosToday } from '@/lib/dates';
import { getStore } from '@/lib/state';
import { createTrelloClient } from '@/lib/trello';
import CountdownTimer from './components/CountdownTimer';

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
  // Real-time Trello state — checked on every page load
  let realTodoCards: { id: string; name: string; members: string[] }[] = [];
  let realDoingCards: { id: string; name: string; members: string[] }[] = [];
  let realMyTodo = false;
  let realMyDoing = false;

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
    // Check real Trello state on every page load
    try {
      const [todoCards, doingCards] = await Promise.all([
        trello.getListCards(config.todoListId),
        trello.getListCards(config.doingListId),
      ]);
      realTodoCards = todoCards.map((c) => ({ id: c.id, name: c.name, members: c.idMembers }));
      realDoingCards = doingCards.map((c) => ({ id: c.id, name: c.name, members: c.idMembers }));
      realMyTodo = realTodoCards.some((c) => c.members.includes(config!.trelloMemberId));
      realMyDoing = realDoingCards.some((c) => c.members.includes(config!.trelloMemberId));
    } catch {
      // Trello read failed — fall back to DB-only state
    }
  }

  const effectiveLimit = state?.dailyLimit ?? config?.dailyLimit ?? null;
  const limitSource = state?.dailyLimit != null ? 'custom' : config ? 'env' : null;

  // Compute real-time eligibility: if it's a new Lagos day, the user is
  // eligible regardless of what the DB says (midnight reset). This prevents
  // stale DB state from showing "Daily limit reached" after midnight.
  const today = lagosToday();
  const isNewDay = state ? state.date !== today : true;
  const effectiveEligible = state ? (isNewDay || state.eligible) : true;
  const effectiveClaimCount = state ? (isNewDay ? 0 : state.claimCount) : 0;

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
        <div style={value}>{state ? String(effectiveEligible) : '—'}</div>
      </div>
      <div style={row}>
        <div style={label}>Claimed Today</div>
        <div style={value}>{state ? `${effectiveClaimCount} card(s)` : '—'}</div>
      </div>
      <div style={row}>
        <div style={label}>Claimed Card</div>
        <div style={value}>{state?.cardId ?? '—'}</div>
      </div>

      {/* Real-time Trello state — your cards highlighted */}
      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #e0e0e0' }}>
        <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: 8 }}>
          🔍 Your Active Cards (live from Trello)
        </div>

        {/* To Do list */}
        <div style={row}>
          <div style={label}>To Do</div>
          <div style={{ ...value, flex: 1 }}>
            {realTodoCards.length === 0 && <span style={{ color: '#888', fontSize: 12 }}>empty</span>}
            {realTodoCards.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {realTodoCards.map((c) => {
                  const isMine = c.members.includes(config?.trelloMemberId ?? '');
                  return (
                    <li key={c.id} style={{ fontSize: 12, marginBottom: 2 }}>
                      {isMine && <span style={{ color: '#1a7f37', fontWeight: 600 }}>👤 YOU → </span>}
                      <span style={{ color: isMine ? '#1a7f37' : '#333' }}>{c.name}</span>
                      {c.members.length > 0 && (
                        <span style={{ color: '#888' }}> ({c.members.length} member{c.members.length > 1 ? 's' : ''})</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Doing list */}
        <div style={row}>
          <div style={label}>Doing</div>
          <div style={{ ...value, flex: 1 }}>
            {realDoingCards.length === 0 && <span style={{ color: '#888', fontSize: 12 }}>empty</span>}
            {realDoingCards.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {realDoingCards.map((c) => {
                  const isMine = c.members.includes(config?.trelloMemberId ?? '');
                  return (
                    <li key={c.id} style={{ fontSize: 12, marginBottom: 2 }}>
                      {isMine && <span style={{ color: '#1a7f37', fontWeight: 600 }}>👤 YOU → </span>}
                      <span style={{ color: isMine ? '#1a7f37' : '#333' }}>{c.name}</span>
                      {c.members.length > 0 && (
                        <span style={{ color: '#888' }}> ({c.members.length} member{c.members.length > 1 ? 's' : ''})</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Summary: cards you're on */}
        <div style={{ ...row, marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e0e0e0' }}>
          <div style={label}>Cards you're on</div>
          <div style={value}>
            {(() => {
              const myTodo = realTodoCards.filter((c) => c.members.includes(config?.trelloMemberId ?? ''));
              const myDoing = realDoingCards.filter((c) => c.members.includes(config?.trelloMemberId ?? ''));
              const total = myTodo.length + myDoing.length;
              if (total === 0) {
                return <span style={{ color: '#1a7f37' }}>None — eligible to claim</span>;
              }
              return (
                <span style={{ color: '#c62828' }}>
                  ⚠️ {total} card{total > 1 ? 's' : ''} — cannot claim ({myTodo.length} in To Do, {myDoing.length} in Doing)
                </span>
              );
            })()}
          </div>
        </div>

        <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
          Checked live from Trello on each page load. DB: eligible={String(state?.eligible)} (effective: {String(effectiveEligible)}), claimed={state?.claimCount ?? 0} (today: {effectiveClaimCount}), card={state?.cardId?.slice(0, 8) ?? '—'}
          {isNewDay && state?.date && (
            <> · New day detected — eligibility reset automatically</>
          )}
          {(realMyTodo || realMyDoing) && state?.eligible === false && state?.claimCount === 0 && (
            <> · DB out of sync — you{'\''}re on a card externally but DB doesn{'\''}t know yet</>
          )}
          {!(realMyTodo || realMyDoing) && state?.eligible === false && !isNewDay && (
            <> · You{'\''}re not on any card now (moved to Code Review?). DB state persists until midnight reset.</>
          )}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Automation</div>
        <div style={value}>
          {state?.enabled !== false ? (
            <span style={{ color: '#1a7f37' }}>ENABLED</span>
          ) : (
            <span style={{ color: '#c62828' }}>DISABLED</span>
          )}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Time Zone</div>
        <div style={value}>Africa/Lagos (resets at midnight)</div>
      </div>

      {/* Countdown Timer */}
      {state && (
        <CountdownTimer
          hasClaimedToday={effectiveClaimCount > 0}
          claimedAt={state.updatedAt}
          dailyLimit={effectiveLimit ?? 1}
          claimCount={effectiveClaimCount}
          enabled={state.enabled !== false}
          isEligible={effectiveEligible}
        />
      )}

      {config && (
        <form
          method="POST"
          action="/api/trello/config"
          style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #e0e0e0' }}
        >
          <div style={{ marginBottom: 6, color: '#333', fontSize: 14, fontWeight: 600 }}>
            Settings
          </div>
          <p style={{ margin: '0 0 16px', color: '#777', fontSize: 12 }}>
            Change settings below and click Save. All changes apply instantly, no redeploy.
          </p>

          {/* Daily limit */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 4, color: '#555', fontSize: 13, fontWeight: 500 }}>
              Daily limit
            </div>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <select name="dailyLimit" defaultValue={effectiveLimit ?? ''} style={select}>
                <option value="1">1 per day</option>
                <option value="2">2 per day</option>
                <option value="0">Unlimited</option>
                {config && (
                  <option value="">Default (env: {config.dailyLimit})</option>
                )}
              </select>
            </div>
          </div>

          {/* Kill switch */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 4, color: '#555', fontSize: 13, fontWeight: 500 }}>
              Automation
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                name="enabled"
                value="true"
                defaultChecked={state?.enabled !== false}
                style={{ width: '18px', height: '18px' }}
              />
              <span style={{ fontSize: '13px' }}>Enable auto-claim</span>
            </label>
            <p style={{ margin: '4px 0 0', color: '#777', fontSize: 11 }}>
              When disabled, webhooks are logged but no cards are claimed.
            </p>
          </div>

          {/* Token + save */}
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
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

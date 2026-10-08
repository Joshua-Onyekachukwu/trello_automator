/**
 * Minimal status page — deliberately plain, no UI framework. Shows the board
 * the service watches, whether the webhook is registered, the most recent
 * claim event with its measured processing time, and the daily claim limit.
 * The limit can be changed right here (1 / 2 / unlimited) — it is stored in
 * the database and applies immediately, no redeploy needed.
 */

import { getConfig } from '@/lib/config';
import { lagosToday } from '@/lib/dates';
import {
  type ClaimState,
  type EligibilityReason,
  type TodayAddSource,
  getStore,
} from '@/lib/state';
import { createTrelloClient } from '@/lib/trello';
import BlockedCards from './components/BlockedCards';
import CountdownTimer from './components/CountdownTimer';

function formatHowAdded(source: TodayAddSource): string {
  return {
    automation: 'automation claimed it',
    external_add: 'someone added you / you were added from outside',
    self_add: 'you added yourself to a card',
    removed: 'you were removed from the claimed card',
    code_review: 'your claimed card is in Code Review',
    membership_unknown: 'membership not yet checked',
    not_taken: 'no project taken today',
  }[source] ?? source;
}

function formatEligibilityReason(
  reason: EligibilityReason,
  howAdded: TodayAddSource,
  onTodo: boolean,
  onDoing: boolean,
): string {
  if (reason === 'new_day') return 'new Lagos day — eligible again';
  if (reason === 'unlimited') return 'unlimited — eligible again';
  if (reason === 'under_limit') return 'under today\'s limit — eligible';
  if (reason === 'on_todo_card') return 'you are already on a To Do card';
  if (reason === 'on_doing_card') return 'you are already on a Doing card';
  if (reason === 'already_claimed_today') {
    if (howAdded === 'code_review') {
      return 'claimed today and card is in Code Review — still taken until midnight';
    }
    return 'already claimed today — still taken until midnight';
  }
  if (reason === 'removed_from_claimed_card') {
    if (howAdded === 'removed') {
      return 'removed from the claimed card — eligible again for the rest of the day';
    }
    return 'no longer on the claimed card — eligible again for the rest of the day';
  }
  if (reason === 'not_taken') return 'no project taken today';
  if (onTodo) return 'you are already on a To Do card';
  if (onDoing) return 'you are already on a Doing card';
  return 'eligibility unclear — rechecking live membership';
}

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
  searchParams: Promise<{ saved?: string; cleared?: string }>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const saved = params.saved === '1';
  const cleared = params.cleared === '1';

  let config: ReturnType<typeof getConfig> | null = null;
  let state: Awaited<ReturnType<ReturnType<typeof getStore>['getState']>> | null = null;
  let lastEvent: Awaited<ReturnType<ReturnType<typeof getStore>['getLatestEvent']>> | null = null;
  let webhookStatus: 'connected' | 'disconnected' | 'unknown' = 'unknown';
  let boardName = '';
  let blockedCards: { cardId: string; cardName: string }[] = [];
  // Real-time Trello state — checked on every page load
  let realTodoCards: { id: string; name: string; members: string[] }[] = [];
  let realDoingCards: { id: string; name: string; members: string[] }[] = [];
  let realMyTodo = false;
  let realMyDoing = false;
  // Today-context interpretation
  let todayReason: EligibilityReason | null = null;
  let todayNote: string | null = null;
  let todayOnTodo = false;
  let todayOnDoing = false;
  let todayClaimedStillMine: boolean | null = null;

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
    try {
      blockedCards = await store.getBlockedCards();
    } catch {
      blockedCards = [];
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

      // Interpret today's eligibility using live membership + today context.
      if (state) {
        const today = lagosToday();
        const dailyLimit = state.dailyLimit ?? config!.dailyLimit;
        const claimedStillMine =
          state?.claimedCardId
            ? realTodoCards.some((c) => c.id === state!.claimedCardId && c.members.includes(config!.trelloMemberId)) ||
              realDoingCards.some((c) => c.id === state!.claimedCardId && c.members.includes(config!.trelloMemberId))
            : null;

        const todayState = state as NonNullable<typeof state>;
        todayOnTodo = realTodoCards.some((c) => c.members.includes(config!.trelloMemberId));
        todayOnDoing = realDoingCards.some((c) => c.members.includes(config!.trelloMemberId));
        todayClaimedStillMine = claimedStillMine !== null ? claimedStillMine : null;

        const reason: EligibilityReason = todayState.date !== today
          ? 'new_day'
          : dailyLimit === 0
            ? 'unlimited'
            : todayOnTodo
              ? 'on_todo_card'
              : todayOnDoing
                ? 'on_doing_card'
                : todayState.claimCount < dailyLimit
                  ? 'under_limit'
                  : todayState.claimCount > 0 && claimedStillMine === false
                    ? 'removed_from_claimed_card'
                    : todayState.claimCount > 0
                      ? 'already_claimed_today'
                      : todayState.howAdded === 'removed'
                        ? 'removed_from_claimed_card'
                        : 'unknown';

        todayReason = reason as EligibilityReason;
        todayNote = state.lastMembershipNote ?? null;
        todayClaimedStillMine = claimedStillMine;
      }
    } catch {
      // Trello read failed — fall back to DB-only state
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '32px 16px' }}>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Trello Auto Claim</h1>
      <p style={{ margin: '0 0 20px', color: '#777', fontSize: 13 }}>
        Claims an eligible, unclaimed card the moment it enters the To Do list.
      </p>

      {saved && (
        <p style={{ color: '#1a7f37', fontSize: 13, margin: '0 0 16px' }}>✓ Daily limit saved.</p>
      )}
      {cleared && (
        <p style={{ color: '#1a7f37', fontSize: 13, margin: '0 0 16px' }}>
          ✓ Today cleared — eligible again for the rest of the day.
        </p>
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
          {(() => {
            const limit = state ? (state.dailyLimit ?? config!.dailyLimit) : config!.dailyLimit;
            const source = state?.dailyLimit != null ? 'custom' : 'env';
            return limit === 0 ? 'Unlimited' : `${limit} per day` +
              (source === 'custom' ? ' (custom)' : source === 'env' ? ' (env default)' : '');
          })()}
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
        <div style={value}>{(() => {
          if (!state) return '—';
          const today = lagosToday();
          const limit = state.dailyLimit ?? config!.dailyLimit;
          const effectiveClaimCount = state.date !== today ? 0 : state.claimCount;
          const effectiveEligible =
            state.date !== today
              ? true
              : limit === 0
                ? true
                : effectiveClaimCount < limit;
          return String(effectiveEligible);
        })()}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Claimed Today</div>
        <div style={value}>{(() => {
          if (!state) return '—';
          const today = lagosToday();
          const effectiveClaimCount = state.date !== today ? 0 : state.claimCount;
          return `${effectiveClaimCount} card(s)`;
        })()}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Claimed Card</div>
        <div style={value}>{state?.cardId ?? '—'}</div>
      </div>
      <div style={row}>
        <div style={label}>How taken today</div>
        <div style={value}>{state ? formatHowAdded(state.howAdded) : '—'}</div>
      </div>
      <div style={row}>
        <div style={label}>Last membership note</div>
        <div style={value}>{state?.lastMembershipNote ?? todayNote ?? '—'}</div>
      </div>          <div style={row}>
            <div style={label}>Why eligible / blocked</div>
            <div style={{ ...value, fontWeight: state ? 500 : 400 }}>
              {state ? (
                todayReason === 'removed_from_claimed_card'
                  ? 'removed from claimed card — eligible again for the rest of the day'
                  : todayReason === 'new_day'
                    ? 'new Lagos day — eligible again'
                    : todayReason === 'unlimited'
                      ? 'unlimited — eligible again'
                      : todayReason === 'under_limit'
                        ? 'under today\'s limit — eligible'
                        : todayReason === 'on_todo_card'
                          ? 'you are already on a To Do card'
                          : todayReason === 'on_doing_card'
                            ? 'you are already on a Doing card'
                            : todayReason === 'already_claimed_today'
                              ? (state.howAdded === 'code_review'
                                ? 'claimed today and card is in Code Review — still taken until midnight'
                                : 'already claimed today — still taken until midnight')
                              : todayReason === 'not_taken'
                                ? 'no project taken today'
                                : 'eligibility unclear — rechecking live membership'
              ) : '—'}
            </div>
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
                  const isMine = c.members.includes(config!.trelloMemberId);
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
                  const isMine = c.members.includes(config!.trelloMemberId);
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
              const myTodo = realTodoCards.filter((c) => c.members.includes(config!.trelloMemberId));
              const myDoing = realDoingCards.filter((c) => c.members.includes(config!.trelloMemberId));
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
          Checked live from Trello on each page load. DB eligible={String(state?.eligible)} claimed={state?.claimCount ?? 0} card={state?.cardId?.slice(0, 8) ?? '—'}
          {(state && lagosToday() !== state.date && state.date) && (
            <> · New day detected — eligibility reset automatically</>
          )}
          {(realMyTodo || realMyDoing) && state?.eligible === false && state?.claimCount === 0 && (
            <> · DB out of sync — you are on a card externally but DB does not know yet</>
          )}
          {!(realMyTodo || realMyDoing) && state?.eligible === false && state?.date === lagosToday() && (
            <> · You are not on any card now (moved to Code Review?). DB state persists until midnight reset.</>
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
        <div style={label}>Card visibility</div>
        <div style={value}>
          {(() => {
            if (!config) return '—';
            const persisted = state?.cardVisibilityState ?? null;
            const visibility = persisted ?? config.cardVisibilityState;
            const text =
              visibility === 'visible_card'
                ? 'visible card'
                : visibility === 'is_a_card'
                  ? 'is a card'
                  : null;
            if (!text) return '—';
            return `${text} (${persisted != null ? 'custom' : 'env default'})`;
          })()}
        </div>
      </div>
      <div style={row}>
        <div style={label}>Time Zone</div>
        <div style={value}>Africa/Lagos (resets at midnight)</div>
      </div>

      {/* Countdown Timer */}
      {state && (
        <CountdownTimer
          hasClaimedToday={(() => {
            const today = lagosToday();
            const effectiveClaimCount = state.date !== today ? 0 : state.claimCount;
            return effectiveClaimCount > 0;
          })()}
          claimedAt={state.updatedAt}
          dailyLimit={(() => {
            const limit = state.dailyLimit ?? config!.dailyLimit;
            return limit;
          })()}
          claimCount={(() => {
            const today = lagosToday();
            const effectiveClaimCount = state.date !== today ? 0 : state.claimCount;
            return effectiveClaimCount;
          })()}
          enabled={state.enabled !== false}
          isEligible={(() => {
            const today = lagosToday();
            const limit = state.dailyLimit ?? config!.dailyLimit;
            const effectiveClaimCount = state.date !== today ? 0 : state.claimCount;
            const effectiveEligible =
              state.date !== today
                ? true
                : limit === 0
                  ? true
                  : effectiveClaimCount < limit;
            return effectiveEligible;
          })()}
        />
      )}

      {/* Blocked Cards */}
      {config && (
        <BlockedCards initialCards={blockedCards} />
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

          {/* Admin token — one field, shared by "Clear my today" and "Save" */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 4, color: '#555', fontSize: 13, fontWeight: 500 }}>
              Admin token
            </div>
            <input type="password" name="token" placeholder="Admin token" required style={input} />
          </div>

          {/* Manual reset */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 4, color: '#555', fontSize: 13, fontWeight: 500 }}>
              Manual reset
            </div>
            <p style={{ margin: '0 0 8px', color: '#777', fontSize: 12 }}>
              Clear today so you can be eligible again for the rest of the Lagos day.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="submit"
                formAction="/api/trello/config/clear-today"
                style={{ ...button, background: '#c62828', color: '#fff' }}
              >
                Clear my today
              </button>
            </div>
          </div>

          {/* Daily limit */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 4, color: '#555', fontSize: 13, fontWeight: 500 }}>
              Daily limit
            </div>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <select name="dailyLimit" defaultValue={(() => {
            const limit = state ? (state.dailyLimit ?? config!.dailyLimit) : config!.dailyLimit;
            return limit ?? '';
          })()} style={select}>
            <option value="1">1 per day</option>
            <option value="2">2 per day</option>
            <option value="0">Unlimited</option>
            {config && (
              <option value="">Default (env: {config.dailyLimit})</option>
            )}
          </select>
            </div>
          </div>

          {/* Card visibility display hint */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 4, color: '#555', fontSize: 13, fontWeight: 500 }}>
              Card visibility
            </div>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <select name="cardVisibilityState" defaultValue={state?.cardVisibilityState ?? ''} style={select}>
            <option value="">Not set (env default)</option>
            <option value="visible_card">visible card</option>
            <option value="is_a_card">is a card</option>
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

          {/* Save */}
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <button type="submit" style={button}>
              Save
            </button>
          </div>
        </form>
      )}
    </main>
  );
}

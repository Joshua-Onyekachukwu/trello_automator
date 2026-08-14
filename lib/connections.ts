/**
 * Connection warming for the claim hot path.
 *
 * Node's built-in fetch (undici) defaults keepAliveTimeout to 4 seconds — idle
 * connections to Trello and Supabase die seconds after the previous webhook,
 * so every claim re-pays TCP connect + TLS on both origins (≈50-150ms each
 * from iad1, which is a big slice of the checks phase). Extending the
 * keep-alive window lets consecutive webhooks (seconds to minutes apart on an
 * active board) reuse live connections.
 *
 * Called once at module load of the webhook route — the only function on the
 * claim path. Failures to tune never break the claim: the try/catch swallows.
 */

import { Agent, setGlobalDispatcher } from 'undici';

let initialized = false;

export function initConnections(): void {
  if (initialized) return;
  initialized = true;
  try {
    setGlobalDispatcher(
      new Agent({
        // Default is 4s; 2 minutes keeps connections alive across the gaps
        // between typical webhook deliveries on an active board.
        keepAliveTimeout: 120_000,
        keepAliveMaxTimeout: 120_000,
        pipelining: 1,
      }),
    );
  } catch (err) {
    // Connection tuning must never take the claim path down.
  }
}

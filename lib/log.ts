/**
 * Lightweight structured logging. Every line is a single JSON object so it is
 * greppable in Vercel logs. Secrets are never logged; sanitizeError() strips
 * anything that looks like a key/token query parameter.
 */

export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

export function logError(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, level: 'error', ...fields }));
}

/** Convert an unknown thrown value to a safe, truncated, redacted message. */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = raw
    .replace(/[?&](key|token|value)=[^&\s"']*/gi, '$1=REDACTED')
    .replace(/https?:\/\/[^\s"']*/gi, '[url-redacted]');
  return redacted.slice(0, 500);
}

/**
 * Timing-safe string comparison. Used for the webhook path secret and the
 * x-admin-token header so responses don't leak timing information.
 *
 * Edge-runtime safe (no node:crypto): both secrets are fixed-length hex
 * strings, so a length check plus a byte-wise XOR scan gives the same
 * no-early-exit property without Node APIs.
 */

export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

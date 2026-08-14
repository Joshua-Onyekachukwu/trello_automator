/**
 * Timing-safe string comparison. Used for the webhook path secret and the
 * x-admin-token header so responses don't leak timing information.
 */

import { timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

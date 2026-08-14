/**
 * Timezone helpers.
 *
 * The daily claim state resets at midnight Africa/Lagos (UTC+1, no DST). The
 * current Lagos date is computed per event — never scheduled, no cron.
 */

/** Current date as YYYY-MM-DD in Africa/Lagos. */
export function lagosToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Admin endpoint to change the daily claim limit.
 *
 *   POST /api/trello/config   header: x-admin-token: <WEBHOOK_SECRET>
 *   body: { "dailyLimit": 1 | 2 | 0 }   (0 = unlimited)
 *
 * Also accepts a plain HTML form (dailyLimit + token fields) so the status
 * page can offer the control without any client JavaScript.
 *
 * The limit is stored per-user in the database (claim_state.daily_limit) and
 * takes effect immediately — no Vercel env change or redeploy needed. NULL
 * restores the DAILY_LIMIT env default.
 */

import { NextRequest } from 'next/server';

import { getConfig } from '@/lib/config';
import { safeEqual } from '@/lib/security';
import { getStore } from '@/lib/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseLimit(raw: unknown): number | null {
  if (raw === '' || raw === null || raw === undefined) return null; // restore env default
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100) return NaN;
  return n;
}

export async function POST(req: NextRequest): Promise<Response> {
  const cfg = getConfig();
  const contentType = req.headers.get('content-type') ?? '';

  let headerToken = req.headers.get('x-admin-token') ?? '';
  let rawLimit: unknown;
  if (contentType.includes('application/json')) {
    try {
      const body = (await req.json()) as { dailyLimit?: unknown };
      rawLimit = body.dailyLimit;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
  } else {
    // Plain HTML form: token field + dailyLimit select.
    const form = await req.formData();
    headerToken = String(form.get('token') ?? '');
    rawLimit = form.get('dailyLimit');
  }

  if (!safeEqual(headerToken, cfg.webhookSecret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const limit = parseLimit(rawLimit);
  if (Number.isNaN(limit)) {
    return new Response('dailyLimit must be an integer 0-100 (0 = unlimited), or empty to use the env default', {
      status: 400,
    });
  }

  try {
    await getStore().setDailyLimit(cfg.trelloMemberId, limit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (contentType.includes('application/json')) {
      return new Response(JSON.stringify({ ok: false, error: message }), { status: 500 });
    }
    return new Response(`Failed to save: ${message}`, { status: 500 });
  }

  if (contentType.includes('application/json')) {
    return new Response(JSON.stringify({ ok: true, dailyLimit: limit }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Form submit: bounce back to the status page so it re-renders with the new limit.
  return new Response(null, { status: 303, headers: { Location: '/?saved=1' } });
}

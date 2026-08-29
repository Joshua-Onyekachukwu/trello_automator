/**
 * Admin endpoint to change the daily claim limit and toggle the kill switch.
 *
 *   POST /api/trello/config   header: x-admin-token: <WEBHOOK_SECRET>
 *   body: { "dailyLimit": 1 | 2 | 0 }   (0 = unlimited)
 *   body: { "enabled": true | false }   (kill switch)
 *
 * Also accepts a plain HTML form (dailyLimit + token + enabled fields) so the
 * status page can offer the control without any client JavaScript.
 *
 * The limit and enabled flag are stored per-user in the database
 * (claim_state) and take effect immediately — no Vercel env change or
 * redeploy needed. NULL restores the DAILY_LIMIT env default.
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

function parseEnabled(raw: unknown): boolean | null {
  if (raw === '' || raw === null || raw === undefined) return null;
  if (raw === 'true' || raw === true || raw === '1' || raw === 1) return true;
  if (raw === 'false' || raw === false || raw === '0' || raw === 0) return false;
  return null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const cfg = getConfig();
  const contentType = req.headers.get('content-type') ?? '';

  let headerToken = req.headers.get('x-admin-token') ?? '';
  let rawLimit: unknown;
  let rawEnabled: unknown;
  if (contentType.includes('application/json')) {
    try {
      const body = (await req.json()) as { dailyLimit?: unknown; enabled?: unknown };
      rawLimit = body.dailyLimit;
      rawEnabled = body.enabled;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
  } else {
    // Plain HTML form: token field + dailyLimit select + enabled toggle.
    const form = await req.formData();
    headerToken = String(form.get('token') ?? '');
    rawLimit = form.get('dailyLimit');
    rawEnabled = form.get('enabled');
  }

  if (!safeEqual(headerToken, cfg.webhookSecret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const store = getStore();
  const errors: string[] = [];

  // Handle daily limit update
  if (rawLimit !== undefined) {
    const limit = parseLimit(rawLimit);
    if (Number.isNaN(limit)) {
      errors.push('dailyLimit must be an integer 0-100 (0 = unlimited), or empty to use the env default');
    } else {
      try {
        await store.setDailyLimit(cfg.trelloMemberId, limit);
      } catch (err) {
        errors.push(`Failed to save daily limit: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Handle kill switch toggle
  if (rawEnabled !== undefined) {
    const enabled = parseEnabled(rawEnabled);
    if (enabled === null) {
      errors.push('enabled must be true or false');
    } else {
      try {
        await store.setEnabled(cfg.trelloMemberId, enabled);
      } catch (err) {
        errors.push(`Failed to save enabled state: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (errors.length > 0) {
    if (contentType.includes('application/json')) {
      return new Response(JSON.stringify({ ok: false, errors }), { status: 400 });
    }
    return new Response(`Failed to save: ${errors.join('; ')}`, { status: 400 });
  }

  if (contentType.includes('application/json')) {
    return new Response(JSON.stringify({ ok: true, dailyLimit: rawLimit, enabled: rawEnabled }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Form submit: bounce back to the status page so it re-renders with the new settings.
  return new Response(null, { status: 303, headers: { Location: '/?saved=1' } });
}

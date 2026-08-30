/**
 * Form-based blocked card removal.
 *
 *   POST /api/trello/blocked/remove   form: cardId
 *
 * Redirects back to the status page after removal.
 */

import { NextRequest } from 'next/server';

import { getStore } from '@/lib/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function checkAuth(req: NextRequest, token?: string): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.WEBHOOK_SECRET ?? '';
  if (secret.length > 0 && auth.includes(secret)) return true;
  if (secret.length > 0 && token === secret) return true;
  return false;
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const formData = await req.formData();
    const cardId = (formData.get('cardId') as string) ?? '';
    const token = (formData.get('token') as string) ?? '';

    if (!checkAuth(req, token)) return new Response('Unauthorized', { status: 401 });

    if (!cardId) {
      return new Response('cardId is required', { status: 400 });
    }

    const store = getStore();
    await store.removeBlockedCard(cardId);

    return new Response(null, {
      status: 303,
      headers: { Location: '/?saved=1' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Error: ${message}`, { status: 500 });
  }
}

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

function checkAuth(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.WEBHOOK_SECRET ?? '';
  return secret.length > 0 && auth.includes(secret);
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!checkAuth(req)) return new Response('Unauthorized', { status: 401 });

  try {
    const formData = await req.formData();
    const cardId = (formData.get('cardId') as string) ?? '';

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

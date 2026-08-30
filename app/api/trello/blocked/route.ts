/**
 * Blocked cards management endpoint.
 *
 *   GET    /api/trello/blocked   — list all blocked cards
 *   POST   /api/trello/blocked   — add a card to the blocklist { cardId, cardName }
 *   DELETE /api/trello/blocked   — remove a card { cardId }
 *
 * All operations require the admin token (WEBHOOK_SECRET).
 */

import { NextRequest } from 'next/server';

import { getStore } from '@/lib/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function checkAuth(req: NextRequest, token?: string): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const secret = process.env.WEBHOOK_SECRET ?? '';
  if (secret.length > 0 && auth.includes(secret)) return true;
  // Also check token from form data or JSON body
  if (secret.length > 0 && token === secret) return true;
  return false;
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!checkAuth(req)) return new Response('Unauthorized', { status: 401 });

  try {
    const store = getStore();
    const cards = await store.getBlockedCards();
    return Response.json({ blocked: cards });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const contentType = req.headers.get('content-type') ?? '';
    let cardId = '';
    let cardName = '';
    let token = '';

    if (contentType.includes('application/json')) {
      const body = await req.json();
      cardId = body.cardId ?? '';
      cardName = body.cardName ?? '';
      token = body.token ?? '';
    } else {
      const formData = await req.formData();
      cardId = (formData.get('cardId') as string) ?? '';
      cardName = (formData.get('cardName') as string) ?? '';
      token = (formData.get('token') as string) ?? '';
    }

    if (!checkAuth(req, token)) return new Response('Unauthorized', { status: 401 });

    if (!cardId) {
      return Response.json({ error: 'cardId is required' }, { status: 400 });
    }

    const store = getStore();
    await store.addBlockedCard(cardId, cardName);

    // If form submission, redirect back; otherwise JSON response
    if (!contentType.includes('application/json')) {
      return new Response(null, {
        status: 303,
        headers: { Location: '/?saved=1' },
      });
    }
    return Response.json({ ok: true, cardId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  if (!checkAuth(req)) return new Response('Unauthorized', { status: 401 });

  try {
    const body = await req.json();
    const { cardId } = body as { cardId?: string };

    if (!cardId || typeof cardId !== 'string') {
      return Response.json({ error: 'cardId is required' }, { status: 400 });
    }

    const store = getStore();
    await store.removeBlockedCard(cardId);
    return Response.json({ ok: true, cardId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  // Handle form-based delete (HTML forms only support GET/POST)
  if (!checkAuth(req)) return new Response('Unauthorized', { status: 401 });

  try {
    const contentType = req.headers.get('content-type') ?? '';
    let cardId = '';

    if (contentType.includes('application/json')) {
      const body = await req.json();
      cardId = body.cardId ?? '';
    } else {
      const formData = await req.formData();
      cardId = (formData.get('cardId') as string) ?? '';
    }

    if (!cardId) {
      return Response.json({ error: 'cardId is required' }, { status: 400 });
    }

    const store = getStore();
    await store.removeBlockedCard(cardId);

    // Redirect back to status page
    return new Response(null, {
      status: 303,
      headers: { Location: '/?saved=1' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

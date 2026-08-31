/**
 * Scan endpoint — DISABLED.
 *
 * The system now uses webhook-only claiming: cards are claimed only when
 * a Trello webhook fires (card moved/created in To Do). The periodic scan
 * that auto-claimed cards sitting in To Do has been removed.
 */

import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest): Promise<Response> {
  return Response.json({
    ok: true,
    disabled: true,
    message: 'Scan is disabled. Cards are claimed via webhook only (when moved to To Do).',
  });
}

export async function POST(_req: NextRequest): Promise<Response> {
  return GET(_req);
}

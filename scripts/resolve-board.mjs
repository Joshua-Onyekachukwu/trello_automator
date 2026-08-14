#!/usr/bin/env node
/**
 * Resolve a Trello board into the env values the service needs.
 *
 *   npm run board -- <board-id-or-short-id>
 *
 * Reads TRELLO_KEY / TRELLO_TOKEN from .env.local and prints ready-to-paste
 * env lines for the board's "To Do", "Doing" and "Code Review" lists (matched
 * by name, case-insensitive). This is how you point the service at a different
 * board — switch these four values, restart, and re-register the webhook
 * (see README → Switching boards).
 */

const boardRef = process.argv[2];
if (!boardRef) {
  console.error('Usage: npm run board -- <board-id-or-short-id>');
  process.exit(1);
}

const { TRELLO_KEY, TRELLO_TOKEN } = process.env;
if (!TRELLO_KEY || !TRELLO_TOKEN) {
  console.error('Missing TRELLO_KEY / TRELLO_TOKEN in .env.local');
  process.exit(1);
}

const API = 'https://api.trello.com/1';
const qs = `key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`;

async function main() {
  const boardRes = await fetch(`${API}/boards/${encodeURIComponent(boardRef)}?fields=name,id&${qs}`);
  if (!boardRes.ok) throw new Error(`board lookup failed: HTTP ${boardRes.status}`);
  const board = await boardRes.json();

  const listsRes = await fetch(`${API}/boards/${board.id}/lists?fields=id,name&${qs}`);
  if (!listsRes.ok) throw new Error(`list lookup failed: HTTP ${listsRes.status}`);
  const lists = await listsRes.json();

  const find = (name) => lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  const todo = find('To Do');
  const doing = find('Doing');
  const cr = find('Code Review');

  if (!todo || !doing || !cr) {
    throw new Error(
      `Board "${board.name}" must have exactly "To Do", "Doing" and "Code Review" lists. ` +
        `Found: ${lists.map((l) => `"${l.name}"`).join(', ') || '(none)'}`,
    );
  }

  console.log(`Board: ${board.name}  (${board.id})`);
  console.log('--- paste into .env.local (or Vercel env vars) ---');
  console.log(`TRELLO_BOARD_ID=${board.id}`);
  console.log(`TODO_LIST_ID=${todo.id}`);
  console.log(`DOING_LIST_ID=${doing.id}`);
  console.log(`CODE_REVIEW_LIST_ID=${cr.id}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

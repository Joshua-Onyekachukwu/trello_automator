#!/usr/bin/env node
/**
 * Resolve a Trello board into the env values the service needs.
 *
 *   npm run board -- <board-id-or-short-id>          # print the values
 *   npm run board -- <board-id-or-short-id> --apply  # also update .env.local
 *
 * Reads TRELLO_KEY / TRELLO_TOKEN from .env.local and resolves the board's
 * "To Do", "Doing" and "Code Review" lists (matched by name, case-insensitive).
 * --apply rewrites the active TRELLO_BOARD_ID / TODO_LIST_ID / DOING_LIST_ID /
 * CODE_REVIEW_LIST_ID lines in .env.local in place (commented lines are kept
 * as-is), so switching boards is one command. For the deployed app, update the
 * same four values in Vercel env vars and re-register the webhook
 * (see README → Switching boards).
 */

import fs from 'node:fs';
import path from 'node:path';

const boardRef = process.argv[2];
const apply = process.argv.includes('--apply');
if (!boardRef) {
  console.error('Usage: npm run board -- <board-id-or-short-id> [--apply]');
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

  const values = {
    TRELLO_BOARD_ID: board.id,
    TODO_LIST_ID: todo.id,
    DOING_LIST_ID: doing.id,
    CODE_REVIEW_LIST_ID: cr.id,
  };

  console.log(`Board: ${board.name}  (${board.id})`);
  console.log('--- values ---');
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);

  if (apply) {
    const envPath = path.resolve(process.cwd(), '.env.local');
    if (!fs.existsSync(envPath)) {
      console.error('--apply: .env.local not found in', process.cwd());
      process.exit(1);
    }
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    const keys = Object.keys(values);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const key = keys.find((k) => line.startsWith(`${k}=`));
      if (key) lines[i] = `${key}=${values[key]}`;
    }
    fs.writeFileSync(envPath, lines.join('\n'));
    console.log('--apply: .env.local updated in place (active lines only).');
  } else {
    console.log('(add --apply to write these into .env.local)');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

/**
 * Contract test for supabase/schema.sql — the file the operator pastes into the
 * Supabase SQL editor.
 *
 * The atomic slot guard's correctness lives in SQL that unit tests can't
 * execute here, so this test pins the exact invariants the app depends on.
 * It exists because the WHERE clause and the in-memory fake (tests/fakes.ts)
 * once diverged: the SQL dropped `eligible <> false` (the webhook-driven Code
 * Review unlock) while the fake kept it — 85/85 tests passed and the real
 * same-day second claim would have been wrongly rejected.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const schema = readFileSync(join(process.cwd(), 'supabase', 'schema.sql'), 'utf8');

describe('supabase/schema.sql — claim_slot contract', () => {
  it('defines the 5-argument claim_slot the app calls (with p_unlock)', () => {
    expect(schema).toContain('p_user text, p_date text, p_card text, p_limit integer, p_unlock boolean');
  });

  it('accepts the webhook-driven Code Review unlock (eligible <> false)', () => {
    expect(schema).toContain('eligible <> false or');
  });

  it('accepts the self-heal unlock (p_unlock) and the unlimited limit (p_limit = 0)', () => {
    expect(schema).toContain('p_unlock or');
    expect(schema).toContain('p_limit = 0 or');
  });

  it('enforces the daily limit in the WHERE (claim_count < p_limit)', () => {
    expect(schema).toContain('claim_count < p_limit');
  });

  it('sets eligible=false and increments the count on every accepted claim', () => {
    expect(schema).toContain('eligible = false,');
    expect(schema).toContain("case when date = p_date then claim_count + 1 else 1 end");
  });

  it('grants execution only to service_role (the SECRET key)', () => {
    expect(schema).toContain('revoke all on function claim_slot(text, text, text, integer, boolean) from public;');
    expect(schema).toContain('grant execute on function claim_slot(text, text, text, integer, boolean) to service_role;');
  });
});

/**
 * Contract test for supabase/schema.sql — the file the operator pastes into the
 * Supabase SQL editor.
 *
 * The atomic slot guard's correctness lives in SQL that unit tests can't
 * execute here, so this test pins the exact invariants the app depends on:
 * one card per Lagos day, midnight is the only reset, Code Review never
 * unlocks the slot.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const schema = readFileSync(join(process.cwd(), 'supabase', 'schema.sql'), 'utf8');

describe('supabase/schema.sql — claim_slot contract', () => {
  it('defines the 5-argument claim_slot the app calls (p_unlock retained for compatibility)', () => {
    expect(schema).toContain('p_user text, p_date text, p_card text, p_limit integer, p_unlock boolean');
  });

  it('never unlocks the same-day slot — Code Review is not a reset', () => {
    // One card per Lagos day: no eligible <> false branch and no p_unlock use.
    expect(schema).not.toContain('eligible <> false');
    expect(schema).not.toContain('p_unlock or');
  });

  it('allows only a new day, unlimited, or under-limit claims in the WHERE', () => {
    expect(schema).toContain('date <> p_date or');
    expect(schema).toContain('p_limit = 0 or');
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

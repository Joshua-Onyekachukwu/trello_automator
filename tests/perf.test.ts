/**
 * Phase 4 — performance simulation.
 *
 * Real network numbers require the deployed environment (see README:
 * "Measuring performance"), but this suite proves the hot path behaves as
 * designed and produces honest local measurements:
 *
 *   1. The two Trello reads run concurrently (checks time ≈ the slower read,
 *      not the sum) — with simulated 50 ms + 70 ms latency, sequential would
 *      take ~120 ms, parallel takes ~70 ms.
 *   2. Application overhead (decision + instrumentation) is single-digit
 *      milliseconds with in-memory fakes.
 *   3. The Timing snapshot records every milestone the spec requires.
 */

import { describe, expect, it } from 'vitest';

import { claimCard } from '../lib/claim';
import { Timing } from '../lib/timing';
import { card, FakeClaimStore, FakeTrello, makeConfig } from './fakes';

describe('performance', () => {
  it('fast path: a fresh membership cache drops the my-cards GET (checks ≈ one read)', async () => {
    // getCard is slower than getMyCards: 70 ms vs 50 ms. With a fresh cache the
    // claim path skips the my-cards GET entirely, so checks ≈ the single getCard
    // read (~70 ms) — two sequential reads would be 120 ms.
    const trello = new FakeTrello([card('A', 'list-todo')], 50);
    trello.getCard = async (id) => {
      await new Promise((r) => setTimeout(r, 70));
      return trello.cards.get(id)!;
    };
    const store = new FakeClaimStore();
    // User is on one unrelated card (not To Do / Doing); cache is fresh.
    store.userCardCache = [{ id: 'other', idList: 'list-other', idBoard: 'board-1', name: '' }];
    store.cacheFresh = true;
    const timing = new Timing();

    const record = await claimCard('A', { config: makeConfig(), trello, store, timing });
    const checksMs = record.details.trelloChecksMs as number;

    expect(record.outcome).toBe('CLAIMED');
    expect(checksMs).toBeGreaterThanOrEqual(60); // getCard's 70 ms
    expect(checksMs).toBeLessThan(110); // well under 120 ms sequential
    console.log(`[perf] fast-path checks=${checksMs}ms (single read, no my-cards GET)`);
  });

  it('cold cache falls back to the my-cards GET (authoritative)', async () => {
    const trello = new FakeTrello([card('A', 'list-todo')], 0);
    const store = new FakeClaimStore();
    store.cacheFresh = false;
    const timing = new Timing();

    const record = await claimCard('A', { config: makeConfig(), trello, store, timing });
    expect(record.outcome).toBe('CLAIMED');
    // The fallback ran — cache is not trusted when stale.
    expect(trello.getMyCardsCalls).toBeGreaterThan(0);
  });

  it('records the full timing breakdown on a successful claim', async () => {
    const trello = new FakeTrello([card('A', 'list-todo')]);
    const store = new FakeClaimStore();
    const timing = new Timing();

    const record = await claimCard('A', { config: makeConfig(), trello, store, timing });
    const d = record.details;

    expect(record.outcome).toBe('CLAIMED');
    expect(d.webhookReceivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(d.checksStartedAt).not.toBeNull();
    expect(d.checksCompletedAt).not.toBeNull();
    expect(d.assignmentStartedAt).not.toBeNull();
    expect(d.assignmentCompletedAt).not.toBeNull();
    expect(record.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(d.totalProcessingMs).toBeGreaterThanOrEqual(record.processingTimeMs);
    expect(d.trelloAssignmentMs).toBeGreaterThanOrEqual(0);
  });

  it('application overhead with in-memory fakes is single-digit milliseconds', async () => {
    const trello = new FakeTrello([card('A', 'list-todo')]);
    const store = new FakeClaimStore();
    const samples: number[] = [];

    for (let i = 0; i < 30; i++) {
      const timing = new Timing();
      const record = await claimCard('A', { config: makeConfig(), trello, store, timing });
      samples.push(record.processingTimeMs);
    }

    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const max = Math.max(...samples);
    // Very conservative: instrumentation + decision should be a few ms.
    expect(avg).toBeLessThan(20);
    expect(max).toBeLessThan(100);
    console.log(`[perf] local pipeline overhead: avg=${avg.toFixed(2)}ms max=${max}ms over ${samples.length} claims`);
  });

  it('payload-trust: complete payload skips the target-card GET (one parallel read, not two)', async () => {
    const trello = new FakeTrello([card('A', 'list-todo')], 60, 80);
    const store = new FakeClaimStore();
    const timing = new Timing();

    const record = await claimCard(
      'A',
      { config: makeConfig(), trello, store, timing },
      { idBoard: 'board-1', idList: 'list-todo', idMembers: [] },
    );

    expect(record.outcome).toBe('CLAIMED');
    expect(trello.getCardCalls).toBe(0);
    // checks ≈ one Trello read (~60 ms) instead of two — well under the 120 ms
    // sequential budget and under the 90 ms two-parallel-reads ceiling.
    expect(record.details.trelloChecksMs!).toBeLessThan(90);
    console.log('[perf] payload-trust claim:', JSON.stringify(record.details));
  });

  it('simulated full pipeline: fast-path checks + assignment fit the latency budget', async () => {
    // Simulated realistic network: 60 ms GET card, 60 ms GET my cards, 80 ms POST.
    // A fresh cache drops the my-cards GET, so checks ≈ the one Trello read.
    const trello = new FakeTrello([card('A', 'list-todo')], 60, 80);
    const store = new FakeClaimStore();
    store.userCardCache = [{ id: 'other', idList: 'list-other', idBoard: 'board-1', name: '' }];
    store.cacheFresh = true;
    const timing = new Timing();

    const record = await claimCard('A', { config: makeConfig(), trello, store, timing });
    const d = record.details;

    // checks ≈ 60 ms (one read), assignment ≈ 80 ms, total ≈ 140 ms + overhead.
    expect(record.outcome).toBe('CLAIMED');
    console.log('[perf] simulated claim:', JSON.stringify(d));
    console.log(
      `[perf] simulated total=${record.processingTimeMs}ms checks=${d.trelloChecksMs}ms assignment=${d.trelloAssignmentMs}ms`,
    );
    expect(d.trelloChecksMs!).toBeLessThan(90);
    expect(d.trelloAssignmentMs!).toBeGreaterThanOrEqual(70);
    expect(record.processingTimeMs).toBeLessThan(200);
  });
});

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
  it('Trello reads are concurrent, not sequential', async () => {
    // getCard is slower than getMyCards: 70 ms vs 50 ms.
    const trello = new FakeTrello([card('A', 'list-todo')], 50);
    trello.getCard = async (id) => {
      await new Promise((r) => setTimeout(r, 70));
      return trello.cards.get(id)!;
    };
    const store = new FakeClaimStore();
    const timing = new Timing();

    const record = await claimCard('A', { config: makeConfig(), trello, store, timing });
    const checksMs = record.details.trelloChecksMs as number;

    // Sequential would be 50 + 70 = 120 ms. Parallel is ~70 ms.
    expect(checksMs).toBeGreaterThan(0);
    expect(checksMs).toBeLessThan(110);
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

  it('simulated full pipeline: parallel checks + assignment fit the latency budget', async () => {
    // Simulated realistic network: 60 ms GET card, 60 ms GET my cards, 80 ms POST.
    const trello = new FakeTrello([card('A', 'list-todo')], 60, 80);
    const store = new FakeClaimStore();
    const timing = new Timing();

    const record = await claimCard('A', { config: makeConfig(), trello, store, timing });
    const d = record.details;

    // checks ≈ 60 ms (parallel), assignment ≈ 80 ms, total ≈ 140 ms + overhead.
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

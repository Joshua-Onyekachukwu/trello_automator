/**
 * Timing instrumentation for the claim pipeline.
 *
 * Records the key milestones as both absolute wall-clock ISO timestamps and
 * durations (via performance.now()), answering "how long from webhook receipt to
 * successful Trello assignment?". Values are real measurements, never estimates.
 */

type MarkName = 'checksStarted' | 'checksCompleted' | 'assignmentStarted' | 'assignmentCompleted';

export interface TimingSnapshot {
  webhookReceivedAt: string;
  checksStartedAt: string | null;
  checksCompletedAt: string | null;
  assignmentStartedAt: string | null;
  assignmentCompletedAt: string | null;
  totalProcessingMs: number;
  trelloChecksMs: number | null;
  trelloAssignmentMs: number | null;
}

export class Timing {
  private readonly t0 = performance.now();
  private readonly wallStart = Date.now();
  readonly webhookReceivedAt = new Date().toISOString();
  private readonly marks = new Map<MarkName, number>();

  markChecksStarted(): void {
    this.mark('checksStarted');
  }

  markChecksCompleted(): void {
    this.mark('checksCompleted');
  }

  markAssignmentStarted(): void {
    this.mark('assignmentStarted');
  }

  markAssignmentCompleted(): void {
    this.mark('assignmentCompleted');
  }

  private mark(name: MarkName): void {
    if (!this.marks.has(name)) this.marks.set(name, performance.now());
  }

  /** Absolute wall-clock ISO time for a mark, anchored to when the request began. */
  private iso(name: MarkName): string | null {
    const at = this.marks.get(name);
    return at === undefined ? null : new Date(this.wallStart + (at - this.t0)).toISOString();
  }

  snapshot(): TimingSnapshot {
    const now = performance.now();
    const checksStarted = this.marks.get('checksStarted');
    const checksCompleted = this.marks.get('checksCompleted');
    const assignmentStarted = this.marks.get('assignmentStarted');
    const assignmentCompleted = this.marks.get('assignmentCompleted');
    return {
      webhookReceivedAt: this.webhookReceivedAt,
      checksStartedAt: this.iso('checksStarted'),
      checksCompletedAt: this.iso('checksCompleted'),
      assignmentStartedAt: this.iso('assignmentStarted'),
      assignmentCompletedAt: this.iso('assignmentCompleted'),
      totalProcessingMs: Math.round(now - this.t0),
      trelloChecksMs:
        checksStarted !== undefined && checksCompleted !== undefined
          ? Math.round(checksCompleted - checksStarted)
          : null,
      trelloAssignmentMs:
        assignmentStarted !== undefined && assignmentCompleted !== undefined
          ? Math.round(assignmentCompleted - assignmentStarted)
          : null,
    };
  }
}

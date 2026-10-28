import { randomUUID } from 'node:crypto';

// DEMO-ONLY (TODO(T-001), TODO(T-003)). Holds tool calls that need a human decision. The request that triggered one
// waits here until somebody approves or denies it, or the timeout passes (which counts as a denial). The approver is
// a free-text label: the demo has no login. In the product this would be an authenticated user (M1).

export type ApprovalOutcome = 'approved' | 'denied' | 'timeout';

export interface PendingApproval {
  id: string;
  request_id: string;
  call_id: string;
  tool: string;
  rule_id: string | null;
  source: string | null;
  /** Arguments after redaction, safe to show. */
  arguments: unknown;
  requested_at: string;
}

interface Waiting {
  info: PendingApproval;
  settle: (outcome: ApprovalOutcome, actor: string) => void;
}

export class ApprovalBroker {
  readonly #waiting = new Map<string, Waiting>();

  /** Registers a pending approval and returns a promise that settles when it is decided or times out. */
  open(
    info: Omit<PendingApproval, 'id'>,
    timeoutMs: number,
  ): { id: string; decision: Promise<{ outcome: ApprovalOutcome; actor: string }> } {
    const id = randomUUID();
    const pending: PendingApproval = { id, ...info };
    const decision = new Promise<{ outcome: ApprovalOutcome; actor: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        resolve({ outcome: 'timeout', actor: 'system (timeout)' });
      }, timeoutMs);
      this.#waiting.set(id, {
        info: pending,
        settle: (outcome, actor) => {
          clearTimeout(timer);
          this.#waiting.delete(id);
          resolve({ outcome, actor });
        },
      });
    });
    return { id, decision };
  }

  list(): PendingApproval[] {
    return [...this.#waiting.values()].map((w) => w.info);
  }

  /** Decides a pending approval. Returns false if it is unknown or already decided. */
  decide(id: string, outcome: 'approved' | 'denied', actor: string): PendingApproval | null {
    const waiting = this.#waiting.get(id);
    if (!waiting) return null;
    waiting.settle(outcome, actor);
    return waiting.info;
  }
}

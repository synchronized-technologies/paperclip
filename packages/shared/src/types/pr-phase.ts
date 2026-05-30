/**
 * PR phase progression model (SYN-30).
 *
 * Tracks an implementation pull request through its post-implementation lifecycle:
 *
 *   implementation -> review -> (cure -> review)* -> qa -> ready_to_merge
 *
 * Optional terminal phases: `merged`, `cancelled`.
 *
 * State lives on the `pull_request` work product's `metadata.prPhase` field so that
 * progression survives restarts and is not dependent on any third-party chat/cron loop.
 *
 * The state machine is intentionally minimal:
 * - it never advances to `ready_to_merge` without recorded review approval, QA approval,
 *   and at least one proof artifact.
 * - it never silently regresses; regressions are explicit ("changes_requested" -> cure).
 * - it does not itself spawn agents; it records desired phase and emits attention signals
 *   that other components (assignment wakeup, board UI) can act on.
 */

export const PR_PHASES = [
  "implementation",
  "review",
  "cure",
  "qa",
  "ready_to_merge",
  "merged",
  "cancelled",
] as const;
export type PrPhase = (typeof PR_PHASES)[number];

export const PR_PHASE_REVIEW_STATES = [
  "pending",
  "in_progress",
  "approved",
  "changes_requested",
] as const;
export type PrPhaseReviewState = (typeof PR_PHASE_REVIEW_STATES)[number];

export const PR_PHASE_QA_STATES = [
  "pending",
  "in_progress",
  "approved",
  "rejected",
] as const;
export type PrPhaseQaState = (typeof PR_PHASE_QA_STATES)[number];

export const PR_PHASE_PROOF_KINDS = [
  "screenshot",
  "log",
  "test_output",
  "preview_url",
  "work_product_link",
  "video",
  "other",
] as const;
export type PrPhaseProofKind = (typeof PR_PHASE_PROOF_KINDS)[number];

export interface PrPhaseProof {
  kind: PrPhaseProofKind;
  url?: string | null;
  summary?: string | null;
  recordedAt: string; // ISO timestamp
  recordedBy?: string | null; // actor identifier (agent id or user id)
}

export interface PrPhaseAttention {
  /** human-actionable reason (permission/blocked/stale/final-ready). */
  reason: "permission_required" | "blocked" | "stale" | "ready_for_human" | "merge_ready";
  message: string;
  raisedAt: string;
  /** Once acknowledged the runner stops re-raising this attention until a new condition arises. */
  acknowledgedAt?: string | null;
}

export interface PrPhaseHistoryEntry {
  from: PrPhase;
  to: PrPhase;
  at: string;
  by?: string | null;
  reason?: string | null;
}

/**
 * Durable per-PR phase state. Stored as `metadata.prPhase` on the
 * `pull_request` work product row, so restarting the server does not lose progress.
 */
export interface PrPhaseState {
  /** Schema version for forward-compatible migrations. */
  version: 1;
  /** Current phase. */
  phase: PrPhase;
  reviewState: PrPhaseReviewState;
  qaState: PrPhaseQaState;
  /** ID of the agent currently expected to act (coder, reviewer, QA). */
  expectedAgentId?: string | null;
  /** ISO timestamp last time something happened (used by stale detector). */
  lastActivityAt: string;
  /** Open cure cycle count — useful for detecting infinite loops. */
  cureCycleCount: number;
  /** Accumulated proof items. */
  proofs: PrPhaseProof[];
  /** Pending review notes (changes_requested feedback). */
  reviewNotes?: string | null;
  /** Pending QA failure notes. */
  qaNotes?: string | null;
  /** Outstanding human attention request, if any. */
  attention?: PrPhaseAttention | null;
  /** Transition history (newest last). */
  history: PrPhaseHistoryEntry[];
}

/** Default state for a newly-created implementation PR. */
export function createInitialPrPhaseState(now: Date = new Date()): PrPhaseState {
  return {
    version: 1,
    phase: "implementation",
    reviewState: "pending",
    qaState: "pending",
    expectedAgentId: null,
    lastActivityAt: now.toISOString(),
    cureCycleCount: 0,
    proofs: [],
    reviewNotes: null,
    qaNotes: null,
    attention: null,
    history: [],
  };
}

/**
 * Stale threshold default. PRs sitting in a non-terminal phase for longer than this
 * raise a `stale` attention so a human knows something is stuck.
 */
export const DEFAULT_PR_PHASE_STALE_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_PR_PHASE_MAX_CURE_CYCLES = 5;

export const PR_PHASE_TERMINAL: ReadonlySet<PrPhase> = new Set(["merged", "cancelled"]);

export function isPrPhaseTerminal(phase: PrPhase): boolean {
  return PR_PHASE_TERMINAL.has(phase);
}

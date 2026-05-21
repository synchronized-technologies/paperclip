/**
 * Pure state-machine logic for PR phase progression (SYN-30).
 *
 * No I/O. Given a current `PrPhaseState` and an event, returns the next state plus
 * any structured `effect` the runner should perform (notify, request agent action,
 * etc.). The server-side runner wraps this with persistence + activity logging.
 */

import {
  DEFAULT_PR_PHASE_MAX_CURE_CYCLES,
  DEFAULT_PR_PHASE_STALE_MS,
  type PrPhase,
  type PrPhaseAttention,
  type PrPhaseProof,
  type PrPhaseState,
  isPrPhaseTerminal,
} from "./types/pr-phase.js";

export type PrPhaseEvent =
  | { kind: "implementation_completed"; at?: Date; by?: string | null }
  | { kind: "review_started"; at?: Date; by?: string | null }
  | { kind: "review_approved"; at?: Date; by?: string | null; note?: string | null }
  | { kind: "review_changes_requested"; at?: Date; by?: string | null; note: string }
  | { kind: "cure_completed"; at?: Date; by?: string | null }
  | { kind: "qa_started"; at?: Date; by?: string | null }
  | { kind: "qa_proof_added"; at?: Date; by?: string | null; proof: PrPhaseProof }
  | { kind: "qa_approved"; at?: Date; by?: string | null }
  | { kind: "qa_rejected"; at?: Date; by?: string | null; note: string }
  | { kind: "marked_merged"; at?: Date; by?: string | null }
  | { kind: "cancelled"; at?: Date; by?: string | null; reason?: string | null }
  | { kind: "attention_acknowledged"; at?: Date; by?: string | null }
  | { kind: "tick"; at?: Date; staleMs?: number; maxCureCycles?: number };

export type PrPhaseEffect =
  | { kind: "none" }
  | { kind: "request_agent_action"; phase: PrPhase; note?: string | null }
  | { kind: "notify_human"; attention: PrPhaseAttention }
  | { kind: "ready_to_merge"; proofCount: number };

export interface PrPhaseTransitionResult {
  state: PrPhaseState;
  effects: PrPhaseEffect[];
  changed: boolean;
  error?: string;
}

function clone(state: PrPhaseState): PrPhaseState {
  return {
    ...state,
    proofs: state.proofs.map((p) => ({ ...p })),
    history: state.history.map((h) => ({ ...h })),
    attention: state.attention ? { ...state.attention } : null,
  };
}

function ts(at: Date | undefined): string {
  return (at ?? new Date()).toISOString();
}

function pushHistory(
  state: PrPhaseState,
  from: PrPhase,
  to: PrPhase,
  at: string,
  by?: string | null,
  reason?: string | null,
) {
  if (from === to) return;
  state.history.push({ from, to, at, by: by ?? null, reason: reason ?? null });
}

function setAttention(state: PrPhaseState, attention: PrPhaseAttention | null) {
  state.attention = attention;
}

function noChange(state: PrPhaseState, error?: string): PrPhaseTransitionResult {
  return { state, effects: [{ kind: "none" }], changed: false, error };
}

/**
 * Apply an event to the current PR phase state.
 *
 * Hard invariants enforced here:
 *   - cannot reach `ready_to_merge` without `reviewState === "approved"`,
 *     `qaState === "approved"`, and at least one proof.
 *   - cannot move to `qa` without `reviewState === "approved"`.
 *   - terminal phases are sticky.
 */
export function applyPrPhaseEvent(
  current: PrPhaseState,
  event: PrPhaseEvent,
): PrPhaseTransitionResult {
  if (isPrPhaseTerminal(current.phase) && event.kind !== "attention_acknowledged") {
    return noChange(current, `Phase ${current.phase} is terminal; ignoring ${event.kind}`);
  }

  const next = clone(current);
  const at = ts(event.at);
  next.lastActivityAt = at;
  const effects: PrPhaseEffect[] = [];

  switch (event.kind) {
    case "implementation_completed": {
      if (next.phase !== "implementation") return noChange(current, "implementation_completed only valid in implementation phase");
      pushHistory(next, next.phase, "review", at, event.by, "implementation completed");
      next.phase = "review";
      next.reviewState = "pending";
      setAttention(next, null);
      effects.push({ kind: "request_agent_action", phase: "review", note: "Implementation complete; review please." });
      break;
    }
    case "review_started": {
      if (next.phase !== "review") return noChange(current, "review_started requires review phase");
      next.reviewState = "in_progress";
      break;
    }
    case "review_approved": {
      if (next.phase !== "review") return noChange(current, "review_approved requires review phase");
      next.reviewState = "approved";
      next.reviewNotes = null;
      pushHistory(next, next.phase, "qa", at, event.by, "review approved");
      next.phase = "qa";
      next.qaState = "pending";
      setAttention(next, null);
      effects.push({ kind: "request_agent_action", phase: "qa", note: "Review approved; QA + proof required." });
      break;
    }
    case "review_changes_requested": {
      if (next.phase !== "review") return noChange(current, "review_changes_requested requires review phase");
      next.reviewState = "changes_requested";
      next.reviewNotes = event.note;
      pushHistory(next, next.phase, "cure", at, event.by, "review requested changes");
      next.phase = "cure";
      next.cureCycleCount += 1;
      setAttention(next, null);
      effects.push({ kind: "request_agent_action", phase: "cure", note: event.note });
      break;
    }
    case "cure_completed": {
      if (next.phase !== "cure") return noChange(current, "cure_completed requires cure phase");
      pushHistory(next, next.phase, "review", at, event.by, "cure completed; re-review");
      next.phase = "review";
      next.reviewState = "pending";
      next.reviewNotes = null;
      setAttention(next, null);
      effects.push({ kind: "request_agent_action", phase: "review", note: "Cure complete; re-review please." });
      break;
    }
    case "qa_started": {
      if (next.phase !== "qa") return noChange(current, "qa_started requires qa phase");
      next.qaState = "in_progress";
      break;
    }
    case "qa_proof_added": {
      if (next.phase !== "qa" && next.phase !== "review") {
        return noChange(current, "qa_proof_added only accepted in review or qa phase");
      }
      next.proofs.push(event.proof);
      break;
    }
    case "qa_approved": {
      if (next.phase !== "qa") return noChange(current, "qa_approved requires qa phase");
      if (next.reviewState !== "approved") {
        return noChange(current, "cannot approve QA without prior review approval");
      }
      if (next.proofs.length === 0) {
        return noChange(current, "cannot approve QA without at least one proof artifact");
      }
      next.qaState = "approved";
      next.qaNotes = null;
      pushHistory(next, next.phase, "ready_to_merge", at, event.by, "qa approved");
      next.phase = "ready_to_merge";
      const attention: PrPhaseAttention = {
        reason: "merge_ready",
        message: `PR ready to merge — review + QA passed (${next.proofs.length} proof item(s)).`,
        raisedAt: at,
        acknowledgedAt: null,
      };
      setAttention(next, attention);
      effects.push({ kind: "ready_to_merge", proofCount: next.proofs.length });
      effects.push({ kind: "notify_human", attention });
      break;
    }
    case "qa_rejected": {
      if (next.phase !== "qa") return noChange(current, "qa_rejected requires qa phase");
      next.qaState = "rejected";
      next.qaNotes = event.note;
      pushHistory(next, next.phase, "cure", at, event.by, "qa rejected");
      next.phase = "cure";
      next.cureCycleCount += 1;
      setAttention(next, null);
      effects.push({ kind: "request_agent_action", phase: "cure", note: event.note });
      break;
    }
    case "marked_merged": {
      if (next.phase !== "ready_to_merge") return noChange(current, "marked_merged requires ready_to_merge phase");
      pushHistory(next, next.phase, "merged", at, event.by, "PR merged");
      next.phase = "merged";
      setAttention(next, null);
      break;
    }
    case "cancelled": {
      pushHistory(next, next.phase, "cancelled", at, event.by, event.reason ?? "cancelled");
      next.phase = "cancelled";
      setAttention(next, null);
      break;
    }
    case "attention_acknowledged": {
      if (next.attention) {
        next.attention = { ...next.attention, acknowledgedAt: at };
      } else {
        return noChange(current, "no attention to acknowledge");
      }
      break;
    }
    case "tick": {
      const staleMs = event.staleMs ?? DEFAULT_PR_PHASE_STALE_MS;
      const maxCure = event.maxCureCycles ?? DEFAULT_PR_PHASE_MAX_CURE_CYCLES;
      const lastAt = Date.parse(current.lastActivityAt);
      const now = (event.at ?? new Date()).getTime();
      // restore lastActivityAt — tick must not bump it
      next.lastActivityAt = current.lastActivityAt;
      if (isPrPhaseTerminal(next.phase)) return noChange(current);

      // Already attention-raised and not acknowledged: idempotent, no new effects.
      const hasOpenAttention = next.attention && !next.attention.acknowledgedAt;

      if (next.cureCycleCount > maxCure) {
        if (!hasOpenAttention || next.attention?.reason !== "blocked") {
          const attention: PrPhaseAttention = {
            reason: "blocked",
            message: `PR exceeded ${maxCure} cure cycles; human review needed.`,
            raisedAt: ts(event.at),
            acknowledgedAt: null,
          };
          setAttention(next, attention);
          effects.push({ kind: "notify_human", attention });
          return { state: next, effects, changed: true };
        }
        return noChange(current);
      }

      if (Number.isFinite(lastAt) && now - lastAt > staleMs) {
        if (!hasOpenAttention || next.attention?.reason !== "stale") {
          const attention: PrPhaseAttention = {
            reason: "stale",
            message: `PR has been in '${next.phase}' phase for over ${Math.round(staleMs / 3_600_000)}h.`,
            raisedAt: ts(event.at),
            acknowledgedAt: null,
          };
          setAttention(next, attention);
          effects.push({ kind: "notify_human", attention });
          return { state: next, effects, changed: true };
        }
      }
      return noChange(current);
    }
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return noChange(current);
    }
  }

  return { state: next, effects, changed: true };
}

/**
 * Strong guard a route/runner can use before flipping the work product's status to
 * `approved`/ready-to-merge. Returns `null` if it is safe, otherwise a human-readable reason.
 */
export function whyNotReadyToMerge(state: PrPhaseState): string | null {
  if (state.reviewState !== "approved") return "review has not been approved";
  if (state.qaState !== "approved") return "QA has not been approved";
  if (state.proofs.length === 0) return "no proof artifacts recorded";
  if (state.phase !== "ready_to_merge" && state.phase !== "merged") {
    return `phase is ${state.phase}, not ready_to_merge`;
  }
  return null;
}

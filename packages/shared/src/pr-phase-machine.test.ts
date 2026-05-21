import { describe, expect, it } from "vitest";
import { applyPrPhaseEvent, whyNotReadyToMerge } from "./pr-phase-machine.js";
import { createInitialPrPhaseState, type PrPhaseProof, type PrPhaseState } from "./types/pr-phase.js";

function freshState(overrides: Partial<PrPhaseState> = {}): PrPhaseState {
  return { ...createInitialPrPhaseState(new Date("2026-05-20T12:00:00Z")), ...overrides };
}

const proof: PrPhaseProof = {
  kind: "screenshot",
  url: "https://example.com/shot.png",
  summary: "homepage renders",
  recordedAt: "2026-05-20T12:34:56Z",
  recordedBy: "agent:qa-1",
};

describe("PR phase machine — happy path", () => {
  it("walks implementation -> review -> qa -> ready_to_merge with proof", () => {
    let state = freshState();
    state = applyPrPhaseEvent(state, { kind: "implementation_completed", by: "agent:coder" }).state;
    expect(state.phase).toBe("review");

    state = applyPrPhaseEvent(state, { kind: "review_started", by: "agent:reviewer" }).state;
    expect(state.reviewState).toBe("in_progress");

    state = applyPrPhaseEvent(state, { kind: "review_approved", by: "agent:reviewer" }).state;
    expect(state.phase).toBe("qa");
    expect(state.reviewState).toBe("approved");

    // QA cannot approve without proof
    const noProof = applyPrPhaseEvent(state, { kind: "qa_approved", by: "agent:qa" });
    expect(noProof.changed).toBe(false);
    expect(noProof.error).toMatch(/proof/);

    state = applyPrPhaseEvent(state, { kind: "qa_proof_added", proof }).state;
    expect(state.proofs).toHaveLength(1);

    const approved = applyPrPhaseEvent(state, { kind: "qa_approved", by: "agent:qa" });
    state = approved.state;
    expect(state.phase).toBe("ready_to_merge");
    expect(state.attention?.reason).toBe("merge_ready");
    expect(approved.effects.some((e) => e.kind === "ready_to_merge")).toBe(true);
    expect(whyNotReadyToMerge(state)).toBeNull();
  });
});

describe("PR phase machine — cure cycle", () => {
  it("routes review_changes_requested -> cure -> review and increments cure counter", () => {
    let state = freshState({ phase: "review", reviewState: "in_progress" });
    state = applyPrPhaseEvent(state, {
      kind: "review_changes_requested",
      note: "tests missing",
      by: "agent:reviewer",
    }).state;
    expect(state.phase).toBe("cure");
    expect(state.cureCycleCount).toBe(1);
    expect(state.reviewNotes).toBe("tests missing");

    state = applyPrPhaseEvent(state, { kind: "cure_completed", by: "agent:coder" }).state;
    expect(state.phase).toBe("review");
    expect(state.reviewState).toBe("pending");
  });

  it("raises 'blocked' attention when cure cycles exceed max", () => {
    let state = freshState({ phase: "cure", cureCycleCount: 6, lastActivityAt: new Date().toISOString() });
    const result = applyPrPhaseEvent(state, { kind: "tick", maxCureCycles: 5 });
    expect(result.changed).toBe(true);
    expect(result.state.attention?.reason).toBe("blocked");
    expect(result.effects.some((e) => e.kind === "notify_human")).toBe(true);
  });

  it("does not raise blocked when cure cycles merely reach max", () => {
    const state = freshState({ phase: "cure", cureCycleCount: 5, lastActivityAt: new Date().toISOString() });
    const result = applyPrPhaseEvent(state, { kind: "tick", maxCureCycles: 5 });
    expect(result.changed).toBe(false);
  });
});

describe("PR phase machine — hard guards", () => {
  it("refuses to advance to ready_to_merge without review approval", () => {
    const state = freshState({ phase: "qa", reviewState: "pending", qaState: "in_progress", proofs: [proof] });
    const result = applyPrPhaseEvent(state, { kind: "qa_approved" });
    expect(result.changed).toBe(false);
    expect(whyNotReadyToMerge(state)).not.toBeNull();
  });

  it("whyNotReadyToMerge reports each missing piece", () => {
    expect(whyNotReadyToMerge(freshState())).toMatch(/review/);
    expect(whyNotReadyToMerge(freshState({ reviewState: "approved" }))).toMatch(/QA/);
    expect(
      whyNotReadyToMerge(freshState({ reviewState: "approved", qaState: "approved", proofs: [] })),
    ).toMatch(/proof/);
    expect(
      whyNotReadyToMerge(freshState({ reviewState: "approved", qaState: "approved", proofs: [proof] })),
    ).toMatch(/phase is/);
  });

  it("treats terminal phases as sticky", () => {
    const state = freshState({ phase: "merged" });
    const result = applyPrPhaseEvent(state, { kind: "review_approved" });
    expect(result.changed).toBe(false);
  });
});

describe("PR phase machine — staleness tick", () => {
  it("raises stale attention after inactivity threshold", () => {
    const state = freshState({ phase: "review", lastActivityAt: "2026-05-19T12:00:00Z" });
    const result = applyPrPhaseEvent(state, {
      kind: "tick",
      at: new Date("2026-05-21T12:00:01Z"),
      staleMs: 24 * 60 * 60 * 1000,
    });
    expect(result.changed).toBe(true);
    expect(result.state.attention?.reason).toBe("stale");
    expect(result.state.lastActivityAt).toBe(state.lastActivityAt); // tick must not bump activity
  });

  it("is idempotent: a second tick does not re-raise stale attention", () => {
    let state = freshState({ phase: "review", lastActivityAt: "2026-05-19T12:00:00Z" });
    state = applyPrPhaseEvent(state, {
      kind: "tick",
      at: new Date("2026-05-21T12:00:01Z"),
      staleMs: 24 * 60 * 60 * 1000,
    }).state;
    const second = applyPrPhaseEvent(state, {
      kind: "tick",
      at: new Date("2026-05-21T13:00:00Z"),
      staleMs: 24 * 60 * 60 * 1000,
    });
    expect(second.changed).toBe(false);
  });
});

describe("PR phase machine — qa_proof_added phase gating", () => {
  it("accepts proof in qa phase", () => {
    const state = freshState({ phase: "qa", reviewState: "approved" });
    const result = applyPrPhaseEvent(state, { kind: "qa_proof_added", proof });
    expect(result.changed).toBe(true);
    expect(result.state.proofs).toHaveLength(1);
  });

  it("accepts proof in review phase", () => {
    const state = freshState({ phase: "review", reviewState: "in_progress" });
    const result = applyPrPhaseEvent(state, { kind: "qa_proof_added", proof });
    expect(result.changed).toBe(true);
    expect(result.state.proofs).toHaveLength(1);
  });

  it("rejects proof in implementation phase", () => {
    const state = freshState({ phase: "implementation" });
    const result = applyPrPhaseEvent(state, { kind: "qa_proof_added", proof });
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/review or qa/);
  });

  it("rejects proof in cure phase", () => {
    const state = freshState({ phase: "cure" });
    const result = applyPrPhaseEvent(state, { kind: "qa_proof_added", proof });
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/review or qa/);
  });

  it("rejects proof in ready_to_merge phase", () => {
    const state = freshState({ phase: "ready_to_merge", reviewState: "approved", qaState: "approved", proofs: [proof] });
    const result = applyPrPhaseEvent(state, { kind: "qa_proof_added", proof });
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/review or qa/);
  });
});

describe("PR phase machine — whyNotReadyToMerge invariant validation", () => {
  it("catches corrupted ready_to_merge state missing review approval", () => {
    const state = freshState({
      phase: "ready_to_merge",
      reviewState: "pending",
      qaState: "approved",
      proofs: [proof],
    });
    expect(whyNotReadyToMerge(state)).toMatch(/review/);
  });

  it("catches corrupted merged state missing QA approval", () => {
    const state = freshState({
      phase: "merged",
      reviewState: "approved",
      qaState: "pending",
      proofs: [proof],
    });
    expect(whyNotReadyToMerge(state)).toMatch(/QA/);
  });

  it("catches corrupted ready_to_merge state missing proofs", () => {
    const state = freshState({
      phase: "ready_to_merge",
      reviewState: "approved",
      qaState: "approved",
      proofs: [],
    });
    expect(whyNotReadyToMerge(state)).toMatch(/proof/);
  });

  it("returns null for valid ready_to_merge state", () => {
    const state = freshState({
      phase: "ready_to_merge",
      reviewState: "approved",
      qaState: "approved",
      proofs: [proof],
    });
    expect(whyNotReadyToMerge(state)).toBeNull();
  });
});

describe("PR phase machine — qa rejection", () => {
  it("falls back to cure on qa_rejected", () => {
    const state = freshState({ phase: "qa", reviewState: "approved", proofs: [proof] });
    const result = applyPrPhaseEvent(state, { kind: "qa_rejected", note: "broken on mobile" });
    expect(result.changed).toBe(true);
    expect(result.state.phase).toBe("cure");
    expect(result.state.qaState).toBe("rejected");
    expect(result.state.cureCycleCount).toBe(1);
  });
});

describe("PR phase machine — cancel + merged", () => {
  it("marks merged only from ready_to_merge", () => {
    const ready = freshState({
      phase: "ready_to_merge",
      reviewState: "approved",
      qaState: "approved",
      proofs: [proof],
    });
    const merged = applyPrPhaseEvent(ready, { kind: "marked_merged" });
    expect(merged.state.phase).toBe("merged");

    const earlier = freshState({ phase: "review" });
    const bad = applyPrPhaseEvent(earlier, { kind: "marked_merged" });
    expect(bad.changed).toBe(false);
  });

  it("cancellation is always allowed and sticky", () => {
    let state = freshState({ phase: "qa", reviewState: "approved", proofs: [proof] });
    state = applyPrPhaseEvent(state, { kind: "cancelled", reason: "obsolete" }).state;
    expect(state.phase).toBe("cancelled");
    const after = applyPrPhaseEvent(state, { kind: "qa_approved" });
    expect(after.changed).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

// Mock the underlying services that the runner depends on so we can exercise
// transitions without spinning up Postgres. The runner is pure orchestration
// over `workProductService` + `issueService.addComment` + activity logging.

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    addComment: vi.fn(async () => undefined),
    getById: vi.fn(async () => null),
  }),
}));

let storedWp: any = {
  id: "wp-1",
  companyId: "company-1",
  issueId: "issue-1",
  type: "pull_request",
  provider: "github",
  status: "draft",
  reviewState: "none",
  isPrimary: true,
  healthStatus: "unknown",
  metadata: null,
  projectId: null,
  executionWorkspaceId: null,
  runtimeServiceId: null,
  externalId: null,
  title: "PR",
  url: "https://example.com/pr/1",
  summary: null,
  createdByRunId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

vi.mock("../services/work-products.js", async () => {
  return {
    workProductService: () => ({
      getById: vi.fn(async (id: string) => (id === storedWp.id ? storedWp : null)),
      update: vi.fn(async (id: string, patch: any) => {
        if (id !== storedWp.id) return null;
        storedWp = { ...storedWp, ...patch };
        return storedWp;
      }),
    }),
    toIssueWorkProduct: (row: any) => row,
  };
});

import { prPhaseRunner } from "../services/pr-phase-runner.js";

describe("prPhaseRunner", () => {
  it("initializes phase metadata and walks to ready_to_merge with proof", async () => {
    storedWp.metadata = null;
    const fakeDb = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as any;
    const runner = prPhaseRunner(fakeDb);
    const init = await runner.ensureInitialized("wp-1", { actorType: "system" });
    expect(init.changed).toBe(true);
    expect(storedWp.metadata?.prPhase?.phase).toBe("implementation");

    let result = await runner.apply("wp-1", { kind: "implementation_completed" });
    expect(result.state.phase).toBe("review");
    expect(storedWp.status).toBe("ready_for_review");

    result = await runner.apply("wp-1", { kind: "review_approved" });
    expect(result.state.phase).toBe("qa");

    // proof is required
    const noProof = await runner.apply("wp-1", { kind: "qa_approved" });
    expect(noProof.changed).toBe(false);

    await runner.apply("wp-1", {
      kind: "qa_proof_added",
      proof: {
        kind: "screenshot",
        url: "https://example.com/x.png",
        recordedAt: new Date().toISOString(),
        summary: "ok",
      },
    });
    const approved = await runner.apply("wp-1", { kind: "qa_approved" });
    expect(approved.changed).toBe(true);
    expect(approved.state.phase).toBe("ready_to_merge");
    expect(storedWp.status).toBe("approved");
    expect(storedWp.reviewState).toBe("approved");
  });

  it("falls back to initial state when persisted metadata has invalid enum values", async () => {
    storedWp.metadata = {
      prPhase: {
        version: 1,
        phase: "bogus_phase",
        reviewState: "approved",
        qaState: "approved",
        expectedAgentId: null,
        lastActivityAt: new Date().toISOString(),
        cureCycleCount: 0,
        proofs: [],
        reviewNotes: null,
        qaNotes: null,
        attention: null,
        history: [],
      },
    };
    const fakeDb = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as any;
    const runner = prPhaseRunner(fakeDb);
    const loaded = await runner.getState("wp-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.state.phase).toBe("implementation");
  });

  it("falls back to initial state when persisted reviewState is invalid", async () => {
    storedWp.metadata = {
      prPhase: {
        version: 1,
        phase: "review",
        reviewState: "invalid_review_state",
        qaState: "pending",
        expectedAgentId: null,
        lastActivityAt: new Date().toISOString(),
        cureCycleCount: 0,
        proofs: [],
        reviewNotes: null,
        qaNotes: null,
        attention: null,
        history: [],
      },
    };
    const fakeDb = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as any;
    const runner = prPhaseRunner(fakeDb);
    const loaded = await runner.getState("wp-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.state.phase).toBe("implementation");
  });

  it("rejects unknown PR ids", async () => {
    const fakeDb = { select: () => ({ from: () => ({ where: async () => [] }) }) } as any;
    const runner = prPhaseRunner(fakeDb);
    const result = await runner.apply("not-real", { kind: "implementation_completed" });
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

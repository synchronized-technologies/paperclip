import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const companyId = "22222222-2222-4222-8222-222222222222";
const wpId = "wp-pr-1";

const storedWp = {
  id: wpId,
  companyId,
  issueId: "issue-1",
  type: "pull_request" as const,
  provider: "github",
  status: "draft",
  reviewState: "none",
  isPrimary: true,
  healthStatus: "unknown",
  metadata: {
    prPhase: {
      version: 1,
      phase: "review",
      reviewState: "in_progress",
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
  },
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

const mockApply = vi.fn(async (_wpId: string, event: { kind: string }) => ({
  workProductId: wpId,
  state: (storedWp.metadata as any).prPhase,
  effects: [{ kind: "none" as const }],
  changed: event.kind !== "marked_merged",
}));

const mockGetState = vi.fn(async (id: string) =>
  id === wpId ? { wp: storedWp, state: (storedWp.metadata as any).prPhase } : null,
);

const mockWhyNotReady = vi.fn(() => null);

vi.mock("../services/index.js", () => ({
  prPhaseRunner: () => ({
    apply: mockApply,
    ensureInitialized: vi.fn(),
    getState: mockGetState,
    tickStalePrPhases: vi.fn(),
    whyNotReadyToMerge: mockWhyNotReady,
  }),
  workProductService: () => ({
    getById: vi.fn(async (id: string) => (id === wpId ? { ...storedWp } : null)),
    update: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
      ...storedWp,
      ...patch,
    })),
  }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    addComment: vi.fn(async () => undefined),
    getById: vi.fn(async () => ({ id: "issue-1", companyId })),
  }),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(),
}));

vi.mock("../routes/authz.js", async () => {
  const { forbidden, unauthorized } =
    await vi.importActual<typeof import("../errors.js")>("../errors.js");

  function assertAuthenticated(req: Express.Request) {
    if (req.actor.type === "none") throw unauthorized();
  }

  function assertBoard(req: Express.Request) {
    if (req.actor.type !== "board") throw forbidden("Board access required");
  }

  function assertCompanyAccess(req: Express.Request, expectedCompanyId: string) {
    assertAuthenticated(req);
    if (req.actor.type === "agent" && req.actor.companyId !== expectedCompanyId) {
      throw forbidden("Agent key cannot access another company");
    }
  }

  function getActorInfo(req: Express.Request) {
    assertAuthenticated(req);
    if (req.actor.type === "agent") {
      return {
        actorType: "agent" as const,
        actorId: req.actor.agentId ?? "unknown-agent",
        agentId: req.actor.agentId ?? null,
        runId: req.actor.runId ?? null,
      };
    }
    return {
      actorType: "user" as const,
      actorId: req.actor.userId ?? "board",
      agentId: null,
      runId: req.actor.runId ?? null,
    };
  }

  return { assertAuthenticated, assertBoard, assertCompanyAccess, getActorInfo };
});

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ errorHandler }, { prPhaseRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/pr-phases.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", prPhaseRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function createAgentApp() {
  const [{ errorHandler }, { prPhaseRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/pr-phases.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-coder-1",
      companyId,
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", prPhaseRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const PRIVILEGED_EVENTS = [
  { kind: "review_approved" },
  { kind: "review_changes_requested", note: "needs work" },
  { kind: "qa_approved" },
  { kind: "qa_rejected", note: "broken" },
  { kind: "marked_merged" },
];

const AGENT_ALLOWED_EVENTS = [
  { kind: "implementation_completed" },
  {
    kind: "qa_proof_added",
    proof: {
      kind: "screenshot",
      url: "https://example.com/x.png",
      summary: "ok",
      recordedAt: new Date().toISOString(),
    },
  },
  { kind: "cancelled", reason: "obsolete" },
];

describe("PR phase routes — actor/role gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const event of PRIVILEGED_EVENTS) {
    it(`rejects agent submitting privileged event: ${event.kind}`, async () => {
      const app = await createAgentApp();
      const res = await request(app)
        .post(`/api/work-products/${wpId}/pr-phase/events`)
        .send(event);
      expect(res.status).toBe(403);
    });

    it(`allows board user to submit privileged event: ${event.kind}`, async () => {
      const app = await createApp();
      const res = await request(app)
        .post(`/api/work-products/${wpId}/pr-phase/events`)
        .send(event);
      expect([200, 409]).toContain(res.status);
    });
  }

  for (const event of AGENT_ALLOWED_EVENTS) {
    it(`allows agent to submit non-privileged event: ${event.kind}`, async () => {
      const app = await createAgentApp();
      const res = await request(app)
        .post(`/api/work-products/${wpId}/pr-phase/events`)
        .send(event);
      expect([200, 409]).toContain(res.status);
    });
  }
});

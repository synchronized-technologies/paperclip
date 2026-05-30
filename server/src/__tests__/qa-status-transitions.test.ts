import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { isActiveTimerFollowupIssueStatus } from "../services/issue-timer-followups.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping QA status transition tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/* ── Unit tests (no DB required) ── */

describe("isActiveTimerFollowupIssueStatus – QA statuses", () => {
  it("treats qa_pending as timer-eligible", () => {
    expect(isActiveTimerFollowupIssueStatus("qa_pending")).toBe(true);
  });

  it("treats qa_in_progress as timer-eligible", () => {
    expect(isActiveTimerFollowupIssueStatus("qa_in_progress")).toBe(true);
  });

  it("treats qa_failed as timer-eligible", () => {
    expect(isActiveTimerFollowupIssueStatus("qa_failed")).toBe(true);
  });

  it("does not treat qa_passed as timer-eligible", () => {
    expect(isActiveTimerFollowupIssueStatus("qa_passed")).toBe(false);
  });

  it("preserves existing active statuses", () => {
    expect(isActiveTimerFollowupIssueStatus("todo")).toBe(true);
    expect(isActiveTimerFollowupIssueStatus("in_progress")).toBe(true);
    expect(isActiveTimerFollowupIssueStatus("in_review")).toBe(true);
    expect(isActiveTimerFollowupIssueStatus("blocked")).toBe(true);
  });

  it("preserves existing inactive statuses", () => {
    expect(isActiveTimerFollowupIssueStatus("backlog")).toBe(false);
    expect(isActiveTimerFollowupIssueStatus("done")).toBe(false);
    expect(isActiveTimerFollowupIssueStatus("cancelled")).toBe(false);
  });
});

/* ── Integration tests (embedded Postgres) ── */

describeEmbeddedPostgres("QA status transitions", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-qa-transitions-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(status: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const userId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "QA transition test",
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function transitionTo(issueId: string, status: string) {
    const result = await svc.update(issueId, { status } as any);
    if (!result) throw new Error("Issue not found");
    return result;
  }

  it("allows in_review → qa_pending", async () => {
    const { issueId } = await seedIssue("in_review");
    const updated = await transitionTo(issueId,"qa_pending");
    expect(updated.status).toBe("qa_pending");
  });

  it("allows qa_pending → qa_in_progress", async () => {
    const { issueId } = await seedIssue("qa_pending");
    const updated = await transitionTo(issueId,"qa_in_progress");
    expect(updated.status).toBe("qa_in_progress");
  });

  it("allows qa_in_progress → qa_passed", async () => {
    const { issueId } = await seedIssue("qa_in_progress");
    const updated = await transitionTo(issueId,"qa_passed");
    expect(updated.status).toBe("qa_passed");
  });

  it("allows qa_in_progress → qa_failed", async () => {
    const { issueId } = await seedIssue("qa_in_progress");
    const updated = await transitionTo(issueId,"qa_failed");
    expect(updated.status).toBe("qa_failed");
  });

  it("allows qa_failed → qa_in_progress (re-test)", async () => {
    const { issueId } = await seedIssue("qa_failed");
    const updated = await transitionTo(issueId,"qa_in_progress");
    expect(updated.status).toBe("qa_in_progress");
  });

  it("allows qa_failed → in_progress (send back to dev)", async () => {
    const { issueId } = await seedIssue("qa_failed");
    const updated = await transitionTo(issueId,"in_progress");
    expect(updated.status).toBe("in_progress");
  });

  it("allows qa_passed → done", async () => {
    const { issueId } = await seedIssue("qa_passed");
    const updated = await transitionTo(issueId,"done");
    expect(updated.status).toBe("done");
  });

  it("rejects todo → qa_pending (must go through in_review)", async () => {
    const { issueId } = await seedIssue("todo");
    await expect(
      transitionTo(issueId, "qa_pending"),
    ).rejects.toThrow(/Cannot transition/);
  });

  it("rejects in_progress → qa_in_progress (must go through in_review → qa_pending first)", async () => {
    const { issueId } = await seedIssue("in_progress");
    await expect(
      transitionTo(issueId, "qa_in_progress"),
    ).rejects.toThrow(/Cannot transition/);
  });

  it("rejects qa_pending → qa_passed (must go through qa_in_progress)", async () => {
    const { issueId } = await seedIssue("qa_pending");
    await expect(
      transitionTo(issueId, "qa_passed"),
    ).rejects.toThrow(/Cannot transition/);
  });

  it("allows cancellation from any QA status", async () => {
    for (const qaStatus of ["qa_pending", "qa_in_progress", "qa_failed", "qa_passed"]) {
      const { issueId } = await seedIssue(qaStatus);
      const updated = await transitionTo(issueId,"cancelled");
      expect(updated.status).toBe("cancelled");
    }
  });

  it("preserves existing non-QA transitions (in_progress → done)", async () => {
    const { issueId } = await seedIssue("in_progress");
    const updated = await transitionTo(issueId,"done");
    expect(updated.status).toBe("done");
  });

  it("preserves existing non-QA transitions (todo → in_progress)", async () => {
    const { issueId } = await seedIssue("todo");
    const updated = await transitionTo(issueId,"in_progress");
    expect(updated.status).toBe("in_progress");
  });
});

describeEmbeddedPostgres("QA statuses – timer followup eligibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-qa-timer-followup-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithIssue(issueStatus: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-04-01T12:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } },
      permissions: {},
      lastHeartbeatAt: new Date("2026-04-01T11:00:00.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "QA timer test",
      status: issueStatus,
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      updatedAt: new Date("2026-04-01T11:00:00.000Z"),
    });

    return { now, companyId, agentId, issueId };
  }

  it("queues timer wakeup for qa_pending issue", async () => {
    const { now, agentId } = await seedAgentWithIssue("qa_pending");
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(now, { startQueuedRuns: false });
    expect(result.enqueued).toBe(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("queues timer wakeup for qa_in_progress issue", async () => {
    const { now, agentId } = await seedAgentWithIssue("qa_in_progress");
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(now, { startQueuedRuns: false });
    expect(result.enqueued).toBe(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("queues timer wakeup for qa_failed issue", async () => {
    const { now, agentId } = await seedAgentWithIssue("qa_failed");
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(now, { startQueuedRuns: false });
    expect(result.enqueued).toBe(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("does not queue timer wakeup for qa_passed issue", async () => {
    const { now, agentId } = await seedAgentWithIssue("qa_passed");
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(now, { startQueuedRuns: false });
    expect(result.enqueued).toBe(0);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });
});

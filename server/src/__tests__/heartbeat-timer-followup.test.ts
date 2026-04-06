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
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type SeedIssueInput = {
  issueStatus?: string;
  assigneeAgentId?: string | null;
  timerFollowupState?: Record<string, unknown> | null;
  updatedAt?: Date;
};

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat timer follow-up tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat timer follow-up guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-followup-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithIssue(input?: {
    agentLastHeartbeatAt?: Date;
    issue?: SeedIssueInput;
  }) {
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
      lastHeartbeatAt: input?.agentLastHeartbeatAt ?? new Date("2026-04-01T11:00:00.000Z"),
    });

    if (input?.issue !== null) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Active follow-up target",
        status: input?.issue?.issueStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: input?.issue?.assigneeAgentId ?? agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        timerFollowupState: input?.issue?.timerFollowupState ?? null,
        updatedAt: input?.issue?.updatedAt ?? new Date("2026-04-01T11:00:00.000Z"),
      });
    }

    return { now, companyId, agentId, issueId };
  }

  it("does not queue timer wakeups when the assignee has no active assigned work", async () => {
    const { now, agentId } = await seedAgentWithIssue({
      issue: {
        issueStatus: "backlog",
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(now, { startQueuedRuns: false });
    expect(result.enqueued).toBe(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("queues timer wakeups for active assigned work", async () => {
    const { now, issueId, agentId } = await seedAgentWithIssue();
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(now, { startQueuedRuns: false });
    expect(result.enqueued).toBe(1);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(run?.invocationSource).toBe("timer");
    expect((run?.contextSnapshot as Record<string, unknown> | null)?.issueId).toBe(issueId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.timerFollowupState).toMatchObject({
      idleFollowupCount: 1,
      lifetimeFollowupCount: 1,
    });
  });

  it("pauses further timer checks when the idle follow-up cap is reached", async () => {
    const { now, agentId } = await seedAgentWithIssue({
      issue: {
        timerFollowupState: {
          idleFollowupCount: 5,
          lifetimeFollowupCount: 5,
          lastTimerFollowupAt: "2026-04-01T09:00:00.000Z",
        },
        updatedAt: new Date("2026-04-01T08:00:00.000Z"),
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(now, { startQueuedRuns: false });
    expect(result.enqueued).toBe(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("resets the idle counter after progress without resetting the lifetime counter", async () => {
    const { now, issueId, agentId } = await seedAgentWithIssue({
      issue: {
        timerFollowupState: {
          idleFollowupCount: 5,
          lifetimeFollowupCount: 7,
          lastTimerFollowupAt: "2026-04-01T09:00:00.000Z",
        },
        updatedAt: new Date("2026-04-01T10:30:00.000Z"),
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(now, { startQueuedRuns: false });
    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.timerFollowupState).toMatchObject({
      idleFollowupCount: 1,
      lifetimeFollowupCount: 8,
    });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("stops further timer checks when the lifetime follow-up cap is reached", async () => {
    const { now, agentId } = await seedAgentWithIssue({
      issue: {
        timerFollowupState: {
          idleFollowupCount: 0,
          lifetimeFollowupCount: 15,
          lastTimerFollowupAt: "2026-04-01T09:00:00.000Z",
        },
        updatedAt: new Date("2026-04-01T10:30:00.000Z"),
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.tickTimers(now, { startQueuedRuns: false });
    expect(result.enqueued).toBe(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });
});

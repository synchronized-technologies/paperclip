import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres origin roundtrip tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue origin roundtrip", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-origin-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "OriginTest",
      issuePrefix: "OT",
      requireBoardApprovalForNewAgents: false,
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("create persists originKind and originId", async () => {
    const originId = "ck_task_abc123";
    const issue = await svc.create(companyId, {
      title: "Linked from ClickUp",
      originKind: "clickup",
      originId,
    });

    expect(issue.originKind).toBe("clickup");
    expect(issue.originId).toBe(originId);
  });

  it("create defaults originKind to manual when omitted", async () => {
    const issue = await svc.create(companyId, {
      title: "Plain issue",
    });

    expect(issue.originKind).toBe("manual");
    expect(issue.originId).toBeNull();
  });

  it("update can set originKind and originId", async () => {
    const issue = await svc.create(companyId, {
      title: "Will be linked later",
    });
    expect(issue.originKind).toBe("manual");

    const updated = await svc.update(issue.id, {
      originKind: "clickup",
      originId: "ck_task_xyz789",
    });

    expect(updated!.originKind).toBe("clickup");
    expect(updated!.originId).toBe("ck_task_xyz789");
  });

  it("update can change originId without touching originKind", async () => {
    const issue = await svc.create(companyId, {
      title: "Already linked",
      originKind: "clickup",
      originId: "ck_old",
    });

    const updated = await svc.update(issue.id, {
      originId: "ck_new",
    });

    expect(updated!.originKind).toBe("clickup");
    expect(updated!.originId).toBe("ck_new");
  });

  it("validator schema accepts originKind and originId on create payload", async () => {
    const { createIssueSchema } = await import("@paperclipai/shared");
    const result = createIssueSchema.safeParse({
      title: "Schema test",
      originKind: "clickup",
      originId: "ck_123",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.originKind).toBe("clickup");
      expect(result.data.originId).toBe("ck_123");
    }
  });

  it("validator schema accepts originKind and originId on update payload", async () => {
    const { updateIssueSchema } = await import("@paperclipai/shared");
    const result = updateIssueSchema.safeParse({
      originKind: "clickup",
      originId: "ck_456",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.originKind).toBe("clickup");
      expect(result.data.originId).toBe("ck_456");
    }
  });

  it("validator rejects unknown originKind", async () => {
    const { createIssueSchema } = await import("@paperclipai/shared");
    const result = createIssueSchema.safeParse({
      title: "Bad origin",
      originKind: "jira",
    });
    expect(result.success).toBe(false);
  });
});

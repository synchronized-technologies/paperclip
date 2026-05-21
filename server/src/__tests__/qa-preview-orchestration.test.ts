import { describe, expect, it, vi } from "vitest";
import { triggerQaForPreviewUrl, type QaPreviewOrchestrationDeps, type PreviewUrlContext } from "../services/qa-preview-orchestration.ts";

function makeDeps(overrides?: Partial<QaPreviewOrchestrationDeps>): QaPreviewOrchestrationDeps {
  return {
    listAgents: vi.fn(async () => []),
    wakeup: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<PreviewUrlContext>): PreviewUrlContext {
  return {
    companyId: "company-1",
    issueId: "issue-1",
    previewUrl: "https://preview.example.com/pr-42",
    ...overrides,
  };
}

describe("triggerQaForPreviewUrl", () => {
  it("wakes a QA agent when one exists", async () => {
    const wakeup = vi.fn(async () => undefined);
    const deps = makeDeps({
      listAgents: vi.fn(async () => [
        { id: "eng-1", role: "engineer", status: "idle" },
        { id: "qa-1", role: "qa", status: "idle" },
      ]),
      wakeup,
    });
    const ctx = makeCtx({ workProductId: "wp-1" });

    const result = await triggerQaForPreviewUrl(deps, ctx);

    expect(result).toEqual(["qa-1"]);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith("qa-1", expect.objectContaining({
      source: "automation",
      triggerDetail: "system",
      reason: "preview_url_ready",
      payload: expect.objectContaining({
        issueId: "issue-1",
        previewUrl: "https://preview.example.com/pr-42",
        workProductId: "wp-1",
      }),
    }));
  });

  it("wakes multiple QA agents", async () => {
    const wakeup = vi.fn(async () => undefined);
    const deps = makeDeps({
      listAgents: vi.fn(async () => [
        { id: "qa-1", role: "qa", status: "idle" },
        { id: "qa-2", role: "quality", status: "idle" },
      ]),
      wakeup,
    });

    const result = await triggerQaForPreviewUrl(deps, makeCtx());

    expect(result).toEqual(["qa-1", "qa-2"]);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when no QA agents exist", async () => {
    const wakeup = vi.fn(async () => undefined);
    const deps = makeDeps({
      listAgents: vi.fn(async () => [
        { id: "eng-1", role: "engineer", status: "idle" },
        { id: "pm-1", role: "product_manager", status: "idle" },
      ]),
      wakeup,
    });

    const result = await triggerQaForPreviewUrl(deps, makeCtx());

    expect(result).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("skips QA agents that are paused", async () => {
    const wakeup = vi.fn(async () => undefined);
    const deps = makeDeps({
      listAgents: vi.fn(async () => [
        { id: "qa-1", role: "qa", status: "paused" },
        { id: "qa-2", role: "qa", status: "idle" },
      ]),
      wakeup,
    });

    const result = await triggerQaForPreviewUrl(deps, makeCtx());

    expect(result).toEqual(["qa-2"]);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("does not wake the producer agent even if it has a QA role", async () => {
    const wakeup = vi.fn(async () => undefined);
    const deps = makeDeps({
      listAgents: vi.fn(async () => [
        { id: "qa-1", role: "qa", status: "idle" },
      ]),
      wakeup,
    });

    const result = await triggerQaForPreviewUrl(deps, makeCtx({ producerAgentId: "qa-1" }));

    expect(result).toEqual([]);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("matches role case-insensitively", async () => {
    const wakeup = vi.fn(async () => undefined);
    const deps = makeDeps({
      listAgents: vi.fn(async () => [
        { id: "qa-1", role: "QA Lead", status: "idle" },
        { id: "qa-2", role: "Quality Assurance", status: "idle" },
      ]),
      wakeup,
    });

    const result = await triggerQaForPreviewUrl(deps, makeCtx());

    expect(result).toEqual(["qa-1", "qa-2"]);
  });

  it("handles listAgents failure gracefully", async () => {
    const deps = makeDeps({
      listAgents: vi.fn(async () => { throw new Error("db error"); }),
    });

    const result = await triggerQaForPreviewUrl(deps, makeCtx());

    expect(result).toEqual([]);
  });

  it("continues waking remaining agents if one wakeup fails", async () => {
    const wakeup = vi.fn()
      .mockRejectedValueOnce(new Error("wakeup failed"))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({
      listAgents: vi.fn(async () => [
        { id: "qa-1", role: "qa", status: "idle" },
        { id: "qa-2", role: "qa", status: "idle" },
      ]),
      wakeup,
    });

    const result = await triggerQaForPreviewUrl(deps, makeCtx());

    expect(result).toEqual(["qa-2"]);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("includes runtimeServiceName in payload when provided", async () => {
    const wakeup = vi.fn(async () => undefined);
    const deps = makeDeps({
      listAgents: vi.fn(async () => [
        { id: "qa-1", role: "qa", status: "idle" },
      ]),
      wakeup,
    });

    await triggerQaForPreviewUrl(deps, makeCtx({ runtimeServiceName: "preview" }));

    expect(wakeup).toHaveBeenCalledWith("qa-1", expect.objectContaining({
      payload: expect.objectContaining({
        runtimeServiceName: "preview",
      }),
    }));
  });
});

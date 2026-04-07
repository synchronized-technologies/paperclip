import { logger } from "../middleware/logger.js";

/**
 * After a preview URL is produced (via work-product creation or adapter runtime
 * services), find the company's QA agent(s) and wake them so they can run
 * automated checks against the preview environment.
 *
 * This closes the orchestration gap where preview URLs were tracked but never
 * automatically handed off to QA.
 */

const QA_ROLES = ["qa", "quality"];

export interface QaPreviewOrchestrationDeps {
  /** List agents for a company (non-terminated). */
  listAgents: (companyId: string) => Promise<Array<{ id: string; role: string; status: string }>>;
  /** Queue a wakeup for an agent. */
  wakeup: (
    agentId: string,
    opts: {
      source?: string;
      triggerDetail?: string;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export interface PreviewUrlContext {
  companyId: string;
  issueId: string;
  previewUrl: string;
  /** The work product ID, if created via the work-product endpoint. */
  workProductId?: string;
  /** The runtime service name, if created via adapter runtime services. */
  runtimeServiceName?: string;
  /** Actor that produced the preview. */
  producerAgentId?: string | null;
}

function isQaAgent(agent: { role: string; status: string }): boolean {
  const role = agent.role.toLowerCase();
  return QA_ROLES.some((qr) => role.includes(qr)) && agent.status !== "paused";
}

/**
 * Find QA agents in the company and wake them with the preview URL payload.
 * Returns the IDs of agents that were woken.
 */
export async function triggerQaForPreviewUrl(
  deps: QaPreviewOrchestrationDeps,
  ctx: PreviewUrlContext,
): Promise<string[]> {
  let agents: Array<{ id: string; role: string; status: string }>;
  try {
    agents = await deps.listAgents(ctx.companyId);
  } catch (err) {
    logger.warn({ err, companyId: ctx.companyId }, "qa-preview: failed to list agents");
    return [];
  }

  const qaAgents = agents.filter(
    (agent) => isQaAgent(agent) && agent.id !== ctx.producerAgentId,
  );

  if (qaAgents.length === 0) {
    logger.debug({ companyId: ctx.companyId, issueId: ctx.issueId }, "qa-preview: no QA agents found");
    return [];
  }

  const wokenIds: string[] = [];

  for (const qa of qaAgents) {
    try {
      await deps.wakeup(qa.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "preview_url_ready",
        payload: {
          issueId: ctx.issueId,
          previewUrl: ctx.previewUrl,
          workProductId: ctx.workProductId ?? null,
          runtimeServiceName: ctx.runtimeServiceName ?? null,
        },
        requestedByActorType: "system",
        requestedByActorId: ctx.producerAgentId ?? null,
        contextSnapshot: {
          issueId: ctx.issueId,
          previewUrl: ctx.previewUrl,
          source: "qa_preview_orchestration",
        },
      });
      wokenIds.push(qa.id);
      logger.info(
        { agentId: qa.id, issueId: ctx.issueId, previewUrl: ctx.previewUrl },
        "qa-preview: woke QA agent for preview URL",
      );
    } catch (err) {
      logger.warn(
        { err, agentId: qa.id, issueId: ctx.issueId },
        "qa-preview: failed to wake QA agent",
      );
    }
  }

  return wokenIds;
}

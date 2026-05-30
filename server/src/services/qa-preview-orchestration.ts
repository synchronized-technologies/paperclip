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
const OPENCLAW_GENERIC_QA_AGENT_ID = "generic-qa";

export type QaCandidateAgent = {
  id: string;
  role: string;
  status: string;
  name?: string | null;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
};

export interface QaPreviewOrchestrationDeps {
  /** List agents for a company (non-terminated). */
  listAgents: (companyId: string) => Promise<QaCandidateAgent[]>;
  /** Queue a wakeup for an agent. */
  wakeup: (
    agentId: string,
    opts: {
      source?: "on_demand" | "timer" | "assignment" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
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
  /** Pull-request work product/URL that caused QA, when this was triggered by PR phase progression. */
  prWorkProductId?: string;
  pullRequestUrl?: string | null;
  /** Optional live-preview auth handoff instructions for QA agents. */
  qaAuthHandoff?: Record<string, unknown> | null;
  /** Actor that produced the preview. */
  producerAgentId?: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isOpenClawGenericQaAgent(agent: QaCandidateAgent): boolean {
  if (agent.adapterType !== "openclaw_gateway") return false;
  const configuredAgentId = readString(agent.adapterConfig?.agentId);
  return configuredAgentId === OPENCLAW_GENERIC_QA_AGENT_ID;
}

function isQaRoleAgent(agent: QaCandidateAgent): boolean {
  const role = agent.role.toLowerCase();
  return QA_ROLES.some((qr) => role.includes(qr));
}

function selectQaAgents(agents: QaCandidateAgent[], producerAgentId?: string | null): QaCandidateAgent[] {
  const eligible = agents.filter((agent) => agent.status !== "paused" && agent.id !== producerAgentId);
  const genericOpenClawQaAgents = eligible.filter(isOpenClawGenericQaAgent);
  if (genericOpenClawQaAgents.length > 0) return genericOpenClawQaAgents;
  return eligible.filter(isQaRoleAgent);
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

  const qaAgents = selectQaAgents(agents, ctx.producerAgentId);

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
          prWorkProductId: ctx.prWorkProductId ?? null,
          pullRequestUrl: ctx.pullRequestUrl ?? null,
          qaAuthHandoff: ctx.qaAuthHandoff ?? null,
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

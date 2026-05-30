/**
 * Durable PR phase progression runner (SYN-30).
 *
 * Glue between the pure `applyPrPhaseEvent` state machine and persistence on
 * `issueWorkProducts.metadata.prPhase`. Every transition is durable: a process
 * restart picks up exactly where the previous one left off.
 *
 * This module deliberately does NOT spawn agent runs itself — the existing
 * assignment / wakeup machinery is the right place for that. Instead it:
 *   - records the phase transition,
 *   - updates the work product's high-level `status` / `reviewState` fields,
 *   - writes a system comment on the issue describing the transition,
 *   - logs an activity entry,
 *   - never marks a PR ready-to-merge without review approval + QA approval + proof.
 *
 * A periodic `tickStalePrPhases` sweep raises `stale` / `blocked` attention so a
 * human is notified only when something is actually stuck.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts } from "@paperclipai/db";
import {
  applyPrPhaseEvent,
  createInitialPrPhaseState,
  isPrPhaseTerminal,
  whyNotReadyToMerge,
  PR_PHASES,
  PR_PHASE_REVIEW_STATES,
  PR_PHASE_QA_STATES,
  type PrPhaseEvent,
  type PrPhaseEffect,
  type PrPhaseState,
  type IssueWorkProduct,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { workProductService, toIssueWorkProduct } from "./work-products.js";
import { issueService } from "./issues.js";

export interface PrPhaseActor {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
  actorType?: "agent" | "user" | "system" | "board" | null;
  actorId?: string | null;
}

export interface PrPhaseRunnerOptions {
  /** Comment writer (defaults to the issueService.addComment). Pluggable for tests. */
  postComment?: (input: {
    issueId: string;
    body: string;
    actor: PrPhaseActor;
  }) => Promise<void>;
}

export interface PrPhaseRunResult {
  workProductId: string;
  state: PrPhaseState;
  effects: PrPhaseEffect[];
  changed: boolean;
  error?: string;
}

const PR_PHASE_METADATA_KEY = "prPhase";

function readPrPhaseFromMetadata(metadata: Record<string, unknown> | null | undefined): PrPhaseState | null {
  const raw = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)[PR_PHASE_METADATA_KEY] : null;
  if (!raw || typeof raw !== "object") return null;
  // Trust shape — produced only by this module. Defensive narrowing kept light.
  const candidate = raw as Partial<PrPhaseState>;
  if (!candidate.phase || !candidate.reviewState || !candidate.qaState || !Array.isArray(candidate.history)) {
    return null;
  }
  if (!(PR_PHASES as readonly string[]).includes(candidate.phase)) return null;
  if (!(PR_PHASE_REVIEW_STATES as readonly string[]).includes(candidate.reviewState)) return null;
  if (!(PR_PHASE_QA_STATES as readonly string[]).includes(candidate.qaState)) return null;
  return {
    version: 1,
    phase: candidate.phase,
    reviewState: candidate.reviewState,
    qaState: candidate.qaState,
    expectedAgentId: candidate.expectedAgentId ?? null,
    lastActivityAt: candidate.lastActivityAt ?? new Date().toISOString(),
    cureCycleCount: candidate.cureCycleCount ?? 0,
    proofs: Array.isArray(candidate.proofs) ? candidate.proofs : [],
    reviewNotes: candidate.reviewNotes ?? null,
    qaNotes: candidate.qaNotes ?? null,
    attention: candidate.attention ?? null,
    history: candidate.history,
  };
}

function buildMetadataPatch(
  existing: Record<string, unknown> | null | undefined,
  next: PrPhaseState,
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    [PR_PHASE_METADATA_KEY]: next,
  };
}

function deriveWorkProductStatus(state: PrPhaseState): {
  status: string;
  reviewState: "none" | "needs_board_review" | "approved" | "changes_requested";
} {
  switch (state.phase) {
    case "implementation":
      return { status: "draft", reviewState: "none" };
    case "review":
      return { status: "ready_for_review", reviewState: "needs_board_review" };
    case "cure":
      return { status: "changes_requested", reviewState: "changes_requested" };
    case "qa":
      return { status: "ready_for_review", reviewState: "needs_board_review" };
    case "ready_to_merge":
      return { status: "approved", reviewState: "approved" };
    case "merged":
      return { status: "merged", reviewState: "approved" };
    case "cancelled":
      return { status: "closed", reviewState: "none" };
  }
}

function effectsHumanSummary(effects: PrPhaseEffect[]): string {
  const parts: string[] = [];
  for (const eff of effects) {
    if (eff.kind === "request_agent_action") {
      parts.push(`requested agent action: **${eff.phase}**${eff.note ? ` — ${eff.note}` : ""}`);
    } else if (eff.kind === "notify_human") {
      parts.push(`attention raised: **${eff.attention.reason}** — ${eff.attention.message}`);
    } else if (eff.kind === "ready_to_merge") {
      parts.push(`ready to merge (proofs: ${eff.proofCount})`);
    }
  }
  return parts.join("; ");
}

export function prPhaseRunner(db: Db, options: PrPhaseRunnerOptions = {}) {
  const workProducts = workProductService(db);
  const issues = issueService(db);

  const defaultPostComment = async (input: { issueId: string; body: string; actor: PrPhaseActor }) => {
    await issues.addComment(
      input.issueId,
      input.body,
      {
        agentId: input.actor.agentId ?? undefined,
        userId: input.actor.userId ?? undefined,
        runId: input.actor.runId ?? null,
      },
      { authorType: "system" },
    );
  };
  const postComment = options.postComment ?? defaultPostComment;

  /**
   * Read the durable state for a PR work product, initializing it lazily if absent.
   */
  async function getState(workProductId: string): Promise<{ wp: IssueWorkProduct; state: PrPhaseState } | null> {
    const wp = await workProducts.getById(workProductId);
    if (!wp || wp.type !== "pull_request") return null;
    const state = readPrPhaseFromMetadata(wp.metadata) ?? createInitialPrPhaseState();
    return { wp, state };
  }

  async function persist(
    wp: IssueWorkProduct,
    next: PrPhaseState,
    effects: PrPhaseEffect[],
    actor: PrPhaseActor,
    eventKind: string,
  ): Promise<IssueWorkProduct> {
    const derived = deriveWorkProductStatus(next);
    // Hard guard: never let derived status outrun the proof rule.
    if (derived.reviewState === "approved" && whyNotReadyToMerge(next) !== null) {
      throw new Error(`pr-phase-runner refusing to persist approved review state: ${whyNotReadyToMerge(next)}`);
    }
    const metadata = buildMetadataPatch(wp.metadata ?? null, next);
    const updated = await workProducts.update(wp.id, {
      status: derived.status,
      reviewState: derived.reviewState,
      metadata,
    });
    if (!updated) throw new Error("failed to update PR work product");

    const resolvedActorType: "agent" | "user" | "system" | "plugin" =
      actor.actorType === "agent" ? "agent" : actor.actorType === "user" ? "user" : "system";
    await logActivity(db, {
      companyId: wp.companyId,
      actorType: resolvedActorType,
      actorId: actor.actorId ?? "system",
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "issue.pr_phase_transitioned",
      entityType: "issue",
      entityId: wp.issueId,
      details: {
        workProductId: wp.id,
        event: eventKind,
        phase: next.phase,
        reviewState: next.reviewState,
        qaState: next.qaState,
        proofCount: next.proofs.length,
        cureCycleCount: next.cureCycleCount,
        attention: next.attention ?? null,
        effects: effects.map((e) => e.kind),
      },
    });

    const humanSummary = effectsHumanSummary(effects);
    const body = [
      `**PR phase →** \`${next.phase}\``,
      `- review: \`${next.reviewState}\``,
      `- QA: \`${next.qaState}\``,
      `- proofs: ${next.proofs.length}`,
      humanSummary ? `- ${humanSummary}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await postComment({ issueId: wp.issueId, body, actor });
    } catch (err) {
      logger.warn({ err, workProductId: wp.id }, "pr-phase-runner: failed to post system comment");
    }
    return updated;
  }

  /**
   * Apply an event to the PR phase, persisting any state change.
   */
  async function apply(
    workProductId: string,
    event: PrPhaseEvent,
    actor: PrPhaseActor = {},
  ): Promise<PrPhaseRunResult> {
    const loaded = await getState(workProductId);
    if (!loaded) {
      return {
        workProductId,
        state: createInitialPrPhaseState(),
        effects: [],
        changed: false,
        error: "work product not found or not a pull_request",
      };
    }
    const { wp, state } = loaded;
    const result = applyPrPhaseEvent(state, event);
    if (!result.changed) {
      return {
        workProductId,
        state: result.state,
        effects: result.effects,
        changed: false,
        error: result.error,
      };
    }
    await persist(wp, result.state, result.effects, actor, event.kind);
    return {
      workProductId,
      state: result.state,
      effects: result.effects,
      changed: true,
    };
  }

  /**
   * Initialize phase state on a PR work product if absent. Idempotent.
   */
  async function ensureInitialized(workProductId: string, actor: PrPhaseActor = {}): Promise<PrPhaseRunResult> {
    const loaded = await getState(workProductId);
    if (!loaded) {
      return {
        workProductId,
        state: createInitialPrPhaseState(),
        effects: [],
        changed: false,
        error: "work product not found or not a pull_request",
      };
    }
    const { wp, state } = loaded;
    if (readPrPhaseFromMetadata(wp.metadata)) {
      return { workProductId, state, effects: [{ kind: "none" }], changed: false };
    }
    const fresh = createInitialPrPhaseState();
    await persist(wp, fresh, [{ kind: "none" }], actor, "initialized");
    return { workProductId, state: fresh, effects: [], changed: true };
  }

  /**
   * Periodic stale/blocked sweep across all PR work products with phase state.
   * Returns the list of work products that received fresh attention.
   */
  async function tickStalePrPhases(opts: { now?: Date; staleMs?: number; maxCureCycles?: number } = {}): Promise<{
    scanned: number;
    notified: string[];
  }> {
    const now = opts.now ?? new Date();
    const rows = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.type, "pull_request"));
    const notified: string[] = [];
    let scanned = 0;
    for (const row of rows) {
      const wp = toIssueWorkProduct(row);
      const state = readPrPhaseFromMetadata(wp.metadata);
      if (!state) continue;
      if (isPrPhaseTerminal(state.phase)) continue;
      scanned += 1;
      const result = applyPrPhaseEvent(state, {
        kind: "tick",
        at: now,
        staleMs: opts.staleMs,
        maxCureCycles: opts.maxCureCycles,
      });
      if (result.changed) {
        try {
          await persist(wp, result.state, result.effects, { actorType: "system" }, "tick");
          if (result.effects.some((e) => e.kind === "notify_human")) {
            notified.push(wp.id);
          }
        } catch (err) {
          logger.error({ err, workProductId: wp.id }, "pr-phase-runner: tick persist failed");
        }
      }
    }
    return { scanned, notified };
  }

  return {
    apply,
    ensureInitialized,
    getState,
    tickStalePrPhases,
    /** Pure guard re-exported for routes/tests. */
    whyNotReadyToMerge,
  };
}

export type PrPhaseRunner = ReturnType<typeof prPhaseRunner>;

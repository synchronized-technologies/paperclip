/**
 * REST routes for the SYN-30 PR phase progression runner.
 *
 * Endpoints (all under `/api`):
 *
 *   GET    /work-products/:id/pr-phase
 *   POST   /work-products/:id/pr-phase/initialize
 *   POST   /work-products/:id/pr-phase/events           body: PrPhaseEventInput
 *   GET    /work-products/:id/pr-phase/ready-to-merge   query: ?
 *   POST   /pr-phase/tick                               board-only sweep trigger
 *
 * The state machine itself enforces invariants (no ready-to-merge without proof,
 * etc.); these routes are thin and reuse standard authz + activity logging.
 */

import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { prPhaseEventSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  heartbeatService,
  prPhaseRunner,
  workProductService,
} from "../services/index.js";
import { triggerQaForPreviewUrl } from "../services/qa-preview-orchestration.js";
import type { PrPhaseActor } from "../services/pr-phase-runner.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden } from "../errors.js";
import { issueService } from "../services/issues.js";

const PRIVILEGED_PR_PHASE_EVENTS: ReadonlySet<string> = new Set([
  "review_approved",
  "review_changes_requested",
  "qa_approved",
  "qa_rejected",
  "marked_merged",
]);

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function actorFromReq(req: Request): PrPhaseActor {
  const info = getActorInfo(req);
  return {
    actorType: info.actorType,
    actorId: info.actorId,
    agentId: info.agentId,
    runId: info.runId,
    userId: info.actorType === "user" ? info.actorId : null,
  };
}

export function prPhaseRoutes(db: Db) {
  const router = Router();
  const wpSvc = workProductService(db);
  const runner = prPhaseRunner(db);
  const issues = issueService(db);
  const agentsSvc = agentService(db);
  const heartbeat = heartbeatService(db);

  async function loadWp(id: string) {
    const wp = await wpSvc.getById(id);
    if (!wp) return { error: { status: 404, body: { error: "Work product not found" } } as const };
    if (wp.type !== "pull_request") {
      return { error: { status: 422, body: { error: "Work product is not a pull_request" } } as const };
    }
    return { wp };
  }

  router.get("/work-products/:id/pr-phase", async (req, res) => {
    const { wp, error } = await loadWp(req.params.id as string);
    if (error) {
      res.status(error.status).json(error.body);
      return;
    }
    assertCompanyAccess(req, wp.companyId);
    const loaded = await runner.getState(wp.id);
    if (!loaded) {
      res.status(404).json({ error: "PR phase state not available" });
      return;
    }
    res.json({ workProductId: wp.id, state: loaded.state });
  });

  router.post("/work-products/:id/pr-phase/initialize", async (req, res) => {
    const { wp, error } = await loadWp(req.params.id as string);
    if (error) {
      res.status(error.status).json(error.body);
      return;
    }
    assertCompanyAccess(req, wp.companyId);
    const issue = await issues.getById(wp.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const result = await runner.ensureInitialized(wp.id, actorFromReq(req));
    res.status(result.changed ? 201 : 200).json(result);
  });

  router.post(
    "/work-products/:id/pr-phase/events",
    validate(prPhaseEventSchema),
    async (req, res) => {
      const { wp, error } = await loadWp(req.params.id as string);
      if (error) {
        res.status(error.status).json(error.body);
        return;
      }
      assertCompanyAccess(req, wp.companyId);
      if (PRIVILEGED_PR_PHASE_EVENTS.has(req.body.kind)) {
        if (req.actor.type !== "board") {
          throw forbidden("Only board users may submit privileged PR phase events");
        }
      }
      const result = await runner.apply(wp.id, req.body, actorFromReq(req));
      if (!result.changed && result.error) {
        res.status(409).json(result);
        return;
      }
      if (result.changed && result.effects.some((effect) => effect.kind === "request_agent_action" && effect.phase === "qa")) {
        const products = await wpSvc.listForIssue(wp.issueId);
        const preview = products.find((product) => product.type === "preview_url" && product.url);
        if (preview?.url) {
          const previewMetadata = readRecord(preview.metadata);
          void triggerQaForPreviewUrl(
            { listAgents: (cid) => agentsSvc.list(cid), wakeup: (aid, opts) => heartbeat.wakeup(aid, opts) },
            {
              companyId: wp.companyId,
              issueId: wp.issueId,
              previewUrl: preview.url,
              workProductId: preview.id,
              prWorkProductId: wp.id,
              pullRequestUrl: wp.url,
              qaAuthHandoff: readRecord(previewMetadata?.qaAuthHandoff),
              producerAgentId: actorFromReq(req).agentId ?? null,
            },
          );
        }
      }
      res.json(result);
    },
  );

  router.get("/work-products/:id/pr-phase/ready-to-merge", async (req, res) => {
    const { wp, error } = await loadWp(req.params.id as string);
    if (error) {
      res.status(error.status).json(error.body);
      return;
    }
    assertCompanyAccess(req, wp.companyId);
    const loaded = await runner.getState(wp.id);
    if (!loaded) {
      res.status(404).json({ error: "PR phase state not available" });
      return;
    }
    const blocker = runner.whyNotReadyToMerge(loaded.state);
    res.json({
      workProductId: wp.id,
      readyToMerge: blocker === null,
      blocker,
      state: loaded.state,
    });
  });

  router.post("/pr-phase/tick", async (req, res) => {
    assertBoard(req);
    const result = await runner.tickStalePrPhases({
      staleMs: typeof req.body?.staleMs === "number" ? req.body.staleMs : undefined,
      maxCureCycles: typeof req.body?.maxCureCycles === "number" ? req.body.maxCureCycles : undefined,
    });
    res.json(result);
  });

  return router;
}

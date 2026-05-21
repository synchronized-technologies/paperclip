import { z } from "zod";
import { PR_PHASE_PROOF_KINDS } from "../types/pr-phase.js";

export const prPhaseProofSchema = z.object({
  kind: z.enum(PR_PHASE_PROOF_KINDS),
  url: z.string().url().optional().nullable(),
  summary: z.string().max(2000).optional().nullable(),
  recordedAt: z.string().datetime().optional(),
  recordedBy: z.string().optional().nullable(),
});

export const prPhaseEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("implementation_completed") }),
  z.object({ kind: z.literal("review_started") }),
  z.object({ kind: z.literal("review_approved"), note: z.string().max(2000).optional().nullable() }),
  z.object({ kind: z.literal("review_changes_requested"), note: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("cure_completed") }),
  z.object({ kind: z.literal("qa_started") }),
  z.object({ kind: z.literal("qa_proof_added"), proof: prPhaseProofSchema }),
  z.object({ kind: z.literal("qa_approved") }),
  z.object({ kind: z.literal("qa_rejected"), note: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("marked_merged") }),
  z.object({ kind: z.literal("cancelled"), reason: z.string().max(2000).optional().nullable() }),
  z.object({ kind: z.literal("attention_acknowledged") }),
]);

export type PrPhaseEventInput = z.infer<typeof prPhaseEventSchema>;

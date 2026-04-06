export const ACTIVE_TIMER_FOLLOWUP_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
export const IDLE_TIMER_FOLLOWUP_CAP = 5;
export const LIFETIME_TIMER_FOLLOWUP_CAP = 15;

export type IssueTimerFollowupState = {
  idleFollowupCount: number;
  lifetimeFollowupCount: number;
  lastTimerFollowupAt: string | null;
};

function normalizeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function parseIssueTimerFollowupState(raw: unknown): IssueTimerFollowupState {
  const state = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    idleFollowupCount: normalizeCount(state.idleFollowupCount),
    lifetimeFollowupCount: normalizeCount(state.lifetimeFollowupCount),
    lastTimerFollowupAt:
      typeof state.lastTimerFollowupAt === "string" && state.lastTimerFollowupAt.trim().length > 0
        ? state.lastTimerFollowupAt
        : null,
  };
}

export function deriveEffectiveIssueTimerFollowupState(input: {
  timerFollowupState: unknown;
  updatedAt: Date | string | null | undefined;
}): IssueTimerFollowupState {
  const parsed = parseIssueTimerFollowupState(input.timerFollowupState);
  if (!parsed.lastTimerFollowupAt || !input.updatedAt) return parsed;

  const lastTimerFollowupAt = new Date(parsed.lastTimerFollowupAt);
  const updatedAt = input.updatedAt instanceof Date ? input.updatedAt : new Date(input.updatedAt);
  if (Number.isNaN(lastTimerFollowupAt.getTime()) || Number.isNaN(updatedAt.getTime())) return parsed;
  if (updatedAt.getTime() <= lastTimerFollowupAt.getTime()) return parsed;

  return {
    ...parsed,
    idleFollowupCount: 0,
  };
}

export function isActiveTimerFollowupIssueStatus(status: string): boolean {
  return ACTIVE_TIMER_FOLLOWUP_ISSUE_STATUSES.includes(status as (typeof ACTIVE_TIMER_FOLLOWUP_ISSUE_STATUSES)[number]);
}

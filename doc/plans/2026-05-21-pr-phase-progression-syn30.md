# SYN-30 — Durable PR Phase Progression

Date: 2026-05-21
Owner: SyOps (Paperclip)
Related issue: `SYN-30 Automate Paperclip PR phase progression to ready-to-merge`
Code: `packages/shared/src/pr-phase-machine.ts`, `server/src/services/pr-phase-runner.ts`,
`server/src/routes/pr-phases.ts`.

## Goal

Move an implementation pull request through its lifecycle automatically and durably:

```
implementation -> review -> (cure -> review)* -> qa -> ready_to_merge -> merged
```

— without requiring a human to babysit each step, and without depending on an
external chat cron. State must survive Paperclip restarts.

## Where the state lives

State for a PR is stored on the `pull_request` work product row, in
`issue_work_products.metadata.prPhase` (JSONB). Schema shape:

```ts
interface PrPhaseState {
  version: 1;
  phase: "implementation" | "review" | "cure" | "qa" | "ready_to_merge" | "merged" | "cancelled";
  reviewState: "pending" | "in_progress" | "approved" | "changes_requested";
  qaState: "pending" | "in_progress" | "approved" | "rejected";
  expectedAgentId: string | null;
  lastActivityAt: string;       // ISO timestamp
  cureCycleCount: number;
  proofs: PrPhaseProof[];        // screenshots / logs / preview URLs / etc.
  reviewNotes: string | null;
  qaNotes: string | null;
  attention: PrPhaseAttention | null;  // raised when human input is needed
  history: PrPhaseHistoryEntry[];
}
```

Because the state lives in the existing `metadata` column, no migration was
required. A boot of the server simply reads it back; no in-memory dependency.

The runner also reflects high-level state onto the work product's
top-level columns:

| phase            | `status`               | `reviewState`         |
|------------------|------------------------|-----------------------|
| implementation   | `draft`                | `none`                |
| review           | `ready_for_review`     | `needs_board_review`  |
| cure             | `changes_requested`    | `changes_requested`   |
| qa               | `ready_for_review`     | `needs_board_review`  |
| ready_to_merge   | `approved`             | `approved`            |
| merged           | `merged`               | `approved`            |
| cancelled        | `closed`               | `none`                |

## State machine

The pure state machine is in `packages/shared/src/pr-phase-machine.ts` and is
exported from `@paperclipai/shared`. It is fully unit-tested
(`packages/shared/src/pr-phase-machine.test.ts`).

Hard invariants enforced by `applyPrPhaseEvent`:

- Cannot transition to `qa` without `reviewState === "approved"`.
- Cannot transition to `ready_to_merge` without
  `reviewState === "approved"` **AND** `qaState === "approved"` **AND**
  at least one `PrPhaseProof` recorded.
- Terminal phases (`merged`, `cancelled`) are sticky.
- `tick` events never bump `lastActivityAt`; they only raise attention.

`whyNotReadyToMerge(state)` is the public guard the route layer (and any
external caller, e.g. UI "Mark merged" button) should consult before flipping
status.

## REST API

Mounted in `server/src/routes/pr-phases.ts`, base prefix `/api`:

| Method | Path                                              | Notes |
|--------|---------------------------------------------------|-------|
| GET    | `/work-products/:id/pr-phase`                     | Read state |
| POST   | `/work-products/:id/pr-phase/initialize`          | Idempotent init |
| POST   | `/work-products/:id/pr-phase/events`              | Body: `PrPhaseEventInput` |
| GET    | `/work-products/:id/pr-phase/ready-to-merge`      | Returns `{ readyToMerge, blocker, state }` |
| POST   | `/pr-phase/tick`                                  | Board-only sweep trigger |

Authorization reuses the existing `assertCompanyAccess` + `getActorInfo`
plumbing. Agents acting on their own company's issues can fire transition
events using their agent API key.

## Periodic sweep

`server/src/index.ts` adds a `prPhaseRunner.tickStalePrPhases()` call to the
existing `heartbeatSchedulerIntervalMs` interval. The tick:

- Skips terminal phases.
- Raises a `blocked` attention when `cureCycleCount` exceeds the configured
  max (default 5 — protects against infinite cure loops).
- Raises a `stale` attention when nothing has happened for >24h.
- Is idempotent: a phase with an unacknowledged attention will not get the same
  attention re-raised on the next tick.

Attention items are persisted on the state object so:

- The UI (or T-da) can list outstanding human-required actions in one query.
- Acknowledgement (`attention_acknowledged` event) is durable too.

## Notification policy

By design the runner only writes:

- A system comment on the related issue describing each phase transition,
- An `issue.pr_phase_transitioned` activity log entry,
- A `PrPhaseAttention` row inside the state when human input is required.

The runner does not spam external channels. Other components (sidebar badges,
inbox aggregator, board notifications) consume `attention` and activity log
rows. This matches the SYN-30 requirement: **only notify T-da on permission,
blocked/stale, or merge_ready**.

## What the runner intentionally does NOT do (v1)

- It does not spawn agent runs. The existing assignment / wakeup machinery
  remains the right surface for that; the runner publishes
  `request_agent_action` effects that callers (or future hooks) can pick up.
- It does not pull PR status from GitHub. The PR work product is updated by
  the coding agent / CI hook as today.
- It does not screenshot or test the deployed preview itself; QA proof must
  be recorded explicitly via `qa_proof_added`. This is the guard that prevents
  premature ready-to-merge.

## Tests

- `packages/shared/src/pr-phase-machine.test.ts` — 11 cases covering the happy
  path, cure cycles, hard guards, staleness, qa rejection, merge / cancel.
- `server/src/__tests__/pr-phase-runner.test.ts` — end-to-end exercise of the
  runner via mocked work-product service: walks implementation through to
  ready_to_merge, confirms the proof guard fires.

## Operational notes

- Backfilling existing PRs: call `POST /work-products/:id/pr-phase/initialize`
  per work product (or run a one-off script that lists `type=pull_request`
  rows and POSTs). Initialization is idempotent.
- Tuning staleness / cure budget: pass `staleMs` / `maxCureCycles` to
  `POST /pr-phase/tick` (board-only). Defaults live in
  `@paperclipai/shared/types/pr-phase` (`DEFAULT_PR_PHASE_STALE_MS`,
  `DEFAULT_PR_PHASE_MAX_CURE_CYCLES`).

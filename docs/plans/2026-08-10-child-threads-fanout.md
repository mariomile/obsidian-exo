# Child threads — supervisable fan-out (design)

**Date:** 2026-08-10 · **Status:** approved design, pre-plan
**Origin:** bb (get-bb/bb) thread-hierarchy audit vs Exo's existing orchestration surfaces.

## Problem

Exo's subagents are ephemeral: an SDK `Agent` call or Workflow agent is projected
as a live-task card inside the parent turn (`core/live-tasks.ts`) — no own
transcript, no lane, no steering. bb models children as *real threads*
(`parentThreadId`, spawn via the same surface a human uses, mid-turn steering,
automatic parent notifications on completion). The SDK's in-process subagents
cannot be made addressable, so first-class children in Exo must be **real
Convos**, spawned deliberately.

Exo already owns the hard half: the Orchestration Board is a complete pipeline —
`tasks.md` ledger (`core/tasks.ts`) → pure reducer with `maxConcurrent` cap and
`spawn-chat` effects (`core/orchestrator.ts`) → impure driver executing spawns
via `startTaskConversation` and feeding convo-state events back
(`obsidian/orchestrator-driver.ts`). What is missing is the agent↔board link and
parentage.

## Decisions (Mario, 2026-08-10)

1. **Job:** supervisable fan-out — the agent delegates work to real parallel
   child chats; in-turn SDK subagents stay as they are.
2. **Child permissions:** normal sessions inheriting the parent's allow-set;
   a blocked child surfaces in the cockpit's auto-derived needs-input lane and
   reports to the parent. No headless profile.
3. **UI placement:** children stay **out of the tab strip** (working-set cap 6);
   they live in the chats sidebar (indented under the parent) and on the board.
   Opening one brings it into the strip on demand.
4. **Approach:** board-first — fan-out rides the existing ledger/reducer/driver;
   no direct-spawn path, no second orchestration surface.

## Data model

- **Ledger** (`core/tasks.ts`): new optional block line `- parent: <convo-id>`
  on `TaskEntry`. Tolerant parsing keeps old files valid; `formatTask ∘
  parseTasksFile` round-trips it. The ledger is the **source of truth** for
  parentage.
- **Convo** (`ui/convo-types.ts`): new persisted `parentConvoId?: string` on
  `ConvoData`/`Convo` — a denormalized copy for UI grouping, stamped by the
  driver when executing a `spawn-chat` effect for a task that has `parent`.
- **Caps:**
  - Concurrency: unchanged — the reducer's `maxConcurrent` governs running.
  - Fan-out: max **5 open children** (not done/archived) per parent convo,
    enforced by the spawn tool with an explanatory error.
  - Depth: max **2** (parent → child → grandchild, stop), checked by walking
    the `parent` chain in the ledger. Cycles impossible by construction (a
    child is always a fresh Convo).

## Tool surface (v1, deliberately minimal)

Two new tools in `obsidian/tools.ts`:

- `spawn_task({title, prompt, model?})` — creates a `queued` `TaskEntry` with
  `parent` = current convo id, through the task-store (shared `WriteQueue`, so
  board-driven and chat-driven creation never interleave). Returns the task id
  and an honest note that it starts when a slot frees. Promotion to `running`
  stays entirely the reducer's job.
- `list_tasks()` — defaults to own children (id, title, status, `inputReason`,
  convo id); flag for the whole board.

Out of scope in v1: agent-side steer/cancel of a child (user keeps control via
board move/archive); any change to `invoke_agent` (stays the unattended
channel).

## Child reports (the bb piece)

New pure module `core/child-reports.ts`, fed by the convo-state emitter (B4)
the driver already subscribes to (`turn-end` / `needs-input` / `stopped` /
`error` per convo):

- Batches with a 2s debounce; each report carries the child's outcome and an
  excerpt of its last assistant message capped at ~2000 chars, plus
  anti-hallucination guidance ("if the user stopped the child, do not resume
  its work unasked").
- **Two delivery rails, two purposes:**
  - *UI:* a notification card in the parent transcript ("child X done/blocked —
    open") + unread badge; click brings the child into the strip and focuses it.
  - *Model:* report text queues onto the parent's pending child reports and is
    delivered on the parent's **next turn** via the existing `pendingSendPrefix`
    mechanism — the parent agent genuinely receives the child's output in
    context. No auto-steer mid-turn in v1.

## UI

All view changes are wiring over pure functions (view.ts is 7100 lines with no
tests — no new logic lands there):

- **Chats sidebar:** children indent under their parent with a status dot, via
  a pure grouping function (convos + `parentConvoId` → ordered tree). Orphans
  (parent archived/deleted) fall back to top level.
- **Tab strip:** child convos do **not** enter the working set at creation —
  `startTaskConversation` gains a `background` flag (verify current board-spawn
  behavior at plan time; the flag serves both paths if needed). Opening a child
  uses the existing `openConversation` path; from then on it is a normal tab.
- **Board:** existing task-cards gain a clickable "child of «parent title»"
  chip. No new lanes — running/needs-input auto-derivation *is* the requested
  supervision.

## Error handling

- *Spawn failure:* already handled by the driver (needs-input + error badge +
  Notice + slot refill); add the parent report on that path.
- *Parent gone before child completes:* report is dropped silently; the child
  remains a normal task convo (orphans allowed; `parent` stays in the ledger as
  history).
- *Reload with pending reports:* pending child reports persist in `ConvoData`
  (small capped array), so an unread report survives restart; task state is in
  the ledger regardless.
- *Caps exceeded:* explanatory tool error, never silent truncation.

## Testing

New logic is born in pure modules with unit tests (same discipline as
`orchestrator.ts`): `parent` round-trip in `tasks.ts`; `child-reports.ts`
reducer (debounce, batch, excerpt, orphan drop); sidebar grouping; strip
exclusion predicate; tool caps (children count, depth). Final gate: full test
suite + suite-smoke harness on the test vault; build deploys to the live vault
per house rule (no forced reload while turns are in flight).

## Scope

Medium: ~2 new core modules, 2 tools, 1 ledger field + 1 ConvoData field,
touches to driver/sidebar/board; main risk concentrated in view.ts wiring.

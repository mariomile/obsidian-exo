# Final fix wave — whole-branch review findings

Branch: `child-threads` (worktree `.worktrees/child-threads`)
Baseline at start: 135 files / 2096 tests green, `src/view.ts` at 6570 lines.

## Result

| | |
|---|---|
| `pnpm test` | **136 files / 2146 tests, 0 failures** |
| `pnpm typecheck` | clean |
| `pnpm lint` | **0 errors**, 8 warnings (all pre-existing, untouched) |
| `pnpm build` | succeeds (tsc + esbuild production) |
| `wc -l src/view.ts` | **6576** / ceiling 6600 — ceiling NOT raised |

Commits, oldest first:

| SHA | Finding |
|---|---|
| `4883396` | 2 — child report re-queued on every later turn |
| `b62d73a` | 3 — child reports have no durability |
| `37f143e` | 4 + 5 + the `MAX_OPEN_CHILDREN` wording |
| `283466a` | 1 — the driver never re-reads the ledger the tool writes |

Commit order deviates from the finding order on purpose: 2, 3 and 4/5 are small
and self-contained, so landing them first kept finding 1's diff (the only one
that adds a module and touches the untested view) readable on its own.

---

## Finding 1 — CRITICAL: the running driver never re-reads the ledger

### What changed

New pure module **`src/core/ledger-watch.ts`** (131 lines) owning the whole
policy, plus thin wiring in `src/ui/board-view.ts`:

- `BoardView.onOpen` builds a `LedgerWatch` **before** the driver and registers
  `this.app.vault.on("modify", …)` through `this.registerEvent(…)`, scoped to
  `this.plugin.paths.tasks`. `registerEvent` (not a bare `vault.on`) matches how
  `main.ts` registers its agent-trigger / agent-contract / automation watchers,
  and means the listener dies with the view rather than calling into a disposed
  driver. `onClose` also disposes the watch.
- **Debounce** (`LEDGER_RELOAD_DEBOUNCE_MS = 400`): a fan-out writing several
  children reloads once, not once per write.
- **Self-write suppression.** `buildDeps()` now passes `this.guardedStore()`
  instead of `plugin.taskStore` — a `DriverStore` whose `update`/`move`/`archive`
  route through `LedgerWatch.guard()` (reads pass straight through). The watch
  keeps an in-flight **counter** (not a flag — overlapping writes must not be
  un-suppressed by whichever finishes first) plus a grace window
  (`LEDGER_SELF_WRITE_GRACE_MS = 1000`), because Obsidian emits `modify` after
  `vault.modify` resolves, so the counter alone misses the echo by milliseconds.
- Events landing inside the suppression window are **deferred, never dropped**.
  Dropping them would lose exactly the case the watcher exists for: a real
  external write can land inside the window. It re-arms instead, and converges
  because the grace window expires on a fixed deadline.
- **`ledgerChangedExternally(inMemory, onDisk)`** — a second, independent guard.
  `reloadIfLedgerChanged()` loads the ledger and reloads only if what is on disk
  differs from what the driver believes, so even a deferred false alarm costs one
  read and stops there. `updated` and `created` are **excluded** from the
  signature: the store stamps `updated` on every write while the driver's
  in-memory copy keeps the old value, so including it would make every write the
  board makes itself look external — an endless reload loop restarting the driver
  mid-spawn. The signature is `JSON.stringify` per row rather than a joined
  string, because `title` and `prompt` are stored verbatim and fully
  user-controlled: any separator character could be typed into one and made to
  spell out another task's fields.

**On the mechanism choice.** I looked at `src/core/write-sentinel.ts` first, as
instructed. It is not the right tool: it is a machine-local *cross-process
registry* (Exo vs Claude Code vs Codex), deliberately "never a lock", and it has
no read side at all — it cannot answer "was this write mine". The
agent-triggers/agent-contracts watchers in `main.ts` have no self-write problem
to solve (Exo does not write the contract files it watches), so there was no
existing in-repo mechanism to reuse. Hence the counter + grace + signature
combination, which is the "write-generation counter / ignore-until timestamp"
the brief named, with the signature comparison added as the proof behind the
heuristic.

**One extra change, same finding.** `OrchestratorDriver.stop()` now **delivers**
queued child reports instead of clearing them. `stop()` used to mean "the board
was closed"; with a watcher it also happens on every external ledger change (the
board rebuilds the driver in `reloadTasks`). Either can land inside the 2s report
debounce, and a dropped report is the child's output gone for good — the parent's
queue is its only route back. `flushReports()` was extracted from the debounce
timer so both paths share one implementation.

**Secondary (board CLOSED).** Not re-architected, as instructed. `spawn_task`'s
description now leads with `IMPORTANT: the Orchestration Board owns the
scheduler, so it must be OPEN for a delegated task to run at all …`, and the
tool's *result* string says the same — the description is read once at session
start, the result is what the model actually acts on in the turn.

### Covering tests

- **`tests/ledger-watch.test.ts`** (new, 24 tests) — the policy, driven by a
  hand-rolled clock + timer queue so it steps one millisecond at a time instead
  of depending on scheduling luck. Covers: `updated`/`created`/ordering ignored;
  a new task seen (the `spawn_task` case); a task removed; hand edits to each of
  status/order/convo/parent/title/prompt/model; separator-collision resistance;
  debounce not firing early, collapsing a burst, re-firing for a later change;
  no fire while a write is in flight; quiet through the grace window; **re-arms
  rather than drops** an event inside the window; converges after a run of
  writes; result and rejection pass-through; a rejected write still releases
  suppression; overlapping writes counted; dispose leaves no timer and ignores
  later events.
- **`tests/fanout-wiring.test.ts`** — 6 new assertions pinning the seam in
  `board-view.ts` (which has no unit tests): `registerEvent` + `vault.on("modify")`,
  scoped to `plugin.paths.tasks`, routed through `ledgerWatch.notify()`,
  `reloadIfLedgerChanged` reaching `reloadTasks()`, all three store writes
  guarded, and the watch disposed on close.
- **`tests/orchestrator-driver.test.ts`** — the rewritten `stop()` test asserts
  the report is handed over on the way out and not delivered twice.
- **`tests/tools-spawn-task.test.ts`** — 2 tests that the open-board caveat is in
  both the description and the result.

### Pre-fix failure output

```
× fan-out wiring — the board sees tasks the tool writes > registers a vault modify listener, so it is torn down with the view
  → expected '/**\n * Orchestration Board view (wor…' to match /registerEvent\(\s*this\.app\.vault\.o…/
× … > scopes the listener to the ledger path, not to every note in the vault
  → anchor moved or was renamed: this.app.vault.on("modify": expected -1 to be greater than -1
× … > routes the event through the debounced watch, never straight to a reload
  → anchor moved or was renamed: this.app.vault.on("modify": expected -1 to be greater than -1
× … > reloads the driver's task list when the ledger really changed
  → expected '/**\n * Orchestration Board view (wor…' to contain 'ledgerChangedExternally'
× … > wraps the driver's OWN store writes, so they don't bounce back as reloads
  → expected 'private buildDeps(): DriverDeps {\n  …' to contain 'guardedStore'
× … > disposes the watch when the board closes
  → expected 'async onClose(): Promise<void> {\n   …' to contain 'ledgerWatch'
Error: Cannot find module '../src/core/ledger-watch' imported from tests/ledger-watch.test.ts
```

---

## Finding 2 — IMPORTANT: a child report re-queued on every later turn

### What changed

`applyEvent` now returns whether the event took the convo's task **out of
`running`**, via a new pure helper `settledRunningTask(before, after, event)`;
`dispatch` propagates it; `onConvoEvent` calls `maybeQueueChildReport` only when
it is true. The three public wrappers (`enqueue`, `markDone`, `move`) became
`async` so their `Promise<void>` signature is unchanged for callers.

Two deliberate choices:

- The rule is **read off the transition**, not restated. The reducer already
  refuses to settle anything that is not `running`; comparing `prev.status ===
  "running" && next.status !== "running"` asks the same question of the same
  data, so the two cannot drift. Re-listing "review, needs-input, …" in the
  driver would be a second copy of the reducer's guard.
- It is computed **inside `applyEvent`**, on the serialized chain, against the
  same pre-reduce list the reducer judged. Capturing `owner.status` in
  `onConvoEvent` before the dispatch (the brief's suggestion) would have been
  wrong in this codebase: the existing comment at that call site records a real
  race where the task's `convo` is not yet recorded when the event arrives, so a
  pre-dispatch lookup finds nothing and would silently drop the *first*, genuine
  report. Reading it in the `.then` is equally unsafe — another chained dispatch
  can run between `applyEvent` resolving and the callback.

### Covering tests

`tests/orchestrator-driver.test.ts`, three new:

- *reports a settled child ONCE, however many later turns that chat runs* — the
  exact scenario from the review: settle, then two more `turn-end`s well past the
  debounce, with the child's last assistant text changing each time. Asserts one
  report and that its excerpt is still the original one.
- *reports a child parked in needs-input ONCE* — same guard on the
  needs-input/stopped/error branch.
- *re-running a settled child reports again* — the negative control, so the fix
  cannot be "never report twice": `turn-start` → `running` → `turn-end` is a real
  second settling transition and must produce a second report.

One **pre-existing test had to be rewritten**: *"collapses several rapid events
for the same child into a single, restarted-debounce report"* encoded the bug's
premise — it emitted three `turn-end`s at one child and expected all three to
restart the debounce. With the fix only the first settles, so it failed. It is
now built on three **different** children, which is what batching is actually
for (a fan-out landing together), and asserts one report each in one flush.
Re-using a single child would only have re-tested the reducer's no-op.

### Pre-fix failure output

```
× OrchestratorDriver — child reports > reports a settled child ONCE, however many later turns that chat runs
  → expected [ { taskId: 'task-6', …(6) }, …(2) ] to have a length of 1 but got 3
× OrchestratorDriver — child reports > reports a child parked in needs-input ONCE, not on every later event
  → expected [ { taskId: 'task-7', …(6) }, …(2) ] to have a length of 1 but got 3
```

---

## Finding 3 — IMPORTANT: child reports had no durability

### What changed

- `src/core/child-reports.ts`: `MAX_PENDING_CHILD_REPORTS = 10`;
  `queueReportForParent` caps at push time (dropping the **oldest**);
  new `reviveChildReports(raw)` validates and caps what comes off disk.
- `src/ui/convo-types.ts`: `pendingChildReports?: ChildReport[]` added to
  `ConvoData`; the `Convo` doc comment corrected from "Runtime-only".
- `src/view.ts`: **+6 lines**, thin wiring only —
  `pendingChildReports: reviveChildReports(d.pendingChildReports)` in `restore()`
  and `...(c.pendingChildReports?.length ? { pendingChildReports: … } : {})` in
  `toConvoData()`, matching the conditional-spread idiom of the neighbouring
  optional fields exactly, so an absent value stays absent on disk.

Two design points worth recording:

- The cap is enforced **where the queue is filled**, not only where it is saved,
  so runtime and disk can never disagree about what a parent is holding. Saving
  therefore writes the array as-is.
- `reviveChildReports` **validates rather than trusts**: `conversations.json` is
  a plain file, and its contents are spliced verbatim into the parent's next
  outbound message. `parentConvoId` (the only routing key) and a *known*
  `outcome` (`formatReportsForParent` indexes a table with it) are mandatory;
  everything else is coerced to a safe default. `childConvoId` is deliberately
  **not** required — it is empty for the spawn-failure report, which is the one a
  parent most needs.

### Covering tests

- `tests/persistence.test.ts`: `pendingChildReports` added to `ROUND_TRIP_FIELDS`
  (so it is checked in both directions by the rule already enforced for every
  other persisted field), plus a conditional-write test, a test that the revive
  goes through the validating reader rather than raw `d.pendingChildReports`, and
  a prose block recording *why* it must be durable.
- `tests/child-reports.test.ts`: a cap test on `queueReportForParent`, and a new
  `reviveChildReports` suite — unchanged round-trip (including that the revived
  queue *formats* identically to the live one), `undefined` for
  absent/empty/null/non-array, malformed entries dropped, hand-grown files
  capped keeping the newest, and no aliasing of the caller's array.

### Pre-fix failure output

11 failures (`× queueReportForParent — routing > caps the queue …` +
`reviveChildReports … is not a function` ×5 + 5 in `persistence.test.ts`), the
persistence ones being:

```
× Convo persistence round-trip > pendingChildReports is read back on restore
  → pendingChildReports is written to disk but never read back: it silently disappears on reload.
× Convo persistence round-trip > pendingChildReports is written on save
  → pendingChildReports is restored from disk but never written: it survives exactly one session.
× Convo persistence round-trip > pendingChildReports is written conditionally, so a normal chat stays clean on disk
  → expected 'private toConvoData(c: Convo): ConvoD…' to match /c\.pendingChildReports\?\.length \?/
× Convo persistence round-trip > pendingChildReports is revived through the validating reader, not trusted raw
  → expected 'const c: Convo = {\n        id,\n    …' to contain 'reviveChildReports(d.pendingChildRepo…'
× child reports survive a reload > the queue is capped where it is filled, so it cannot grow without bound on disk
  → expected '/**\n * Child reports — the pure half…' to contain 'MAX_PENDING_CHILD_REPORTS'
```

The pre-existing test *"pendingChildReports is runtime-only and never
persisted"* was **deleted**: it asserted the defect. It is replaced by the
round-trip pair above.

---

## Finding 4 — MUST FIX: anti-hallucination wording wrong at both batch edges

`"One of these was stopped by hand: …"` →
`"Any task above shown as stopped was stopped by hand: do not resume its work
unless Mario asks."` Same place in `formatReportsForParent`, same trigger
condition.

Tests in `tests/child-reports.test.ts`: the two existing assertions still hold
(the phrase "do not resume" is preserved deliberately, so the guardrail's key
words did not move); three added — a batch of exactly one carries no "one of
these", a batch of two stopped children gets **one** guidance line covering both
and singling out neither, and a mixed batch still carries it.

## Finding 5 — MUST FIX: a read-only tool raising a write permission card

`"mcp__obsidian__list_tasks"` added to `OBSIDIAN_READ_TOOLS`.

**`OBSIDIAN_ORCHESTRATION_TOOLS` deleted, not extended.** Reason: it had zero
production consumers and could never have one — the `orchestrationEnabled` gate
is applied at *registration* (`createObsidianToolServer`), so a disabled
orchestration tool is not on the server at all and there is nothing left to
classify at permission time. Keeping it would have meant maintaining a Set that
nobody reads, which is precisely how the `list_tasks` omission survived: a Set
with no consumer cannot go red when it drifts. Per the repo's own coding
principle (remove obsolete paths rather than carry them), it is gone; a comment
at the deletion site records why, so nobody re-adds it.

The omission is now detectable by a test that checks the direction
`tool-registries.test.ts` never could: **every `list_*`/`get_*` tool registered
on the server must be classified read-only**. A full inverse is not the rule
(most tools are writes and belong to no Set), so the rule is stated where it is
knowable — a tool whose own name says it only reads must be classified as one.
The test carries a guard that the name heuristic still matches something, so it
cannot decay into a no-op.

**Verified by mutation** — removing `list_tasks` from the Set again:

```
× obsidian tool classifier registries stay in sync with registered tools > every list_*/get_* tool on the server is classified read-only
  → these read-shaped tools raise a write permission card: list_tasks.
    Add them to OBSIDIAN_READ_TOOLS, or rename them if they are not actually read-only.:
    expected [ 'list_tasks' ] to deeply equal []
```

## Also — `MAX_OPEN_CHILDREN` refusal wording

`"Wait for one to finish, or mark one done on the board."` →
`"Ask Mario to mark one done or archive it on the board to free a slot — a
finished child parks in Review and keeps its slot until he does."`

The `CLOSED` set in `src/core/child-tasks.ts` also gained a comment recording
*why* `review` is excluded, so the next reader does not "fix" the set instead of
the message.

New test in `tests/child-tasks.test.ts`: five children **all in `review`** (every
one finished working) still hit the cap, and the refusal must not say "wait for
one to finish" while it must name marking done or archiving. That construction
makes the test fail for the right reason — it is the state in which the old
advice was actively false.

---

## Not done, and why

- **Board-closed orchestration (finding 1, secondary).** Explicitly out of scope
  per the brief. The tool now tells the truth instead; making the driver
  headless (plugin-owned rather than view-owned) is a real change to where the
  scheduler lives and should be its own plan.
- **`reloadTasks()` restarting the whole driver.** It stops and rebuilds rather
  than merging the new tasks in. I kept the existing gesture (the brief asked for
  `reloadTasks()`) and made it *rare* — the signature comparison means it only
  runs on a genuine external change — and closed the one hole the higher
  frequency opened, by making `stop()` deliver pending reports rather than drop
  them. A merge-in-place path would be the right long-term shape but is a driver
  redesign, not a fix.
- **The 8 lint warnings.** Pre-existing, outside this feature, left untouched as
  instructed.
- **Live-vault manual verification (plan Task 9).** Still open. No
  `.obsidian-plugin-dir` is configured in this worktree, so `pnpm build` did not
  deploy anywhere; nothing in the live vault was touched by this wave.

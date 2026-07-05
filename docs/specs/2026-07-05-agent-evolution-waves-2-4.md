# Agent Evolution — Executable Briefs for Waves 2-4

Canonical execution spec for the remaining waves of the Agent Evolution plan (vault doc: `Active/Projects/Exo/Exo — Agent Evolution.md`, ideation run `e7a2c4f1`, decision `2026-07-05-exo-agent-evolution-wave-1`). Wave 1 (git auto-commit, @user/@generated sentinels + write queue, open-loops ledger, self-writing observer) and #7 (time-travel recall) are LANDED as of v0.23.0.

Each brief below is written to be executed directly (by an orchy run or a single builder agent) without further design decisions. Where a brief says "verify against source", the intent is fixed but exact symbol names must be confirmed on read — the codebase moves fast.

## Global rules (every brief inherits these)

1. **Start from fresh origin/main** (`git pull`) — parallel sessions exist.
2. **TDD**: new logic lives in `src/core/` as pure modules (no `obsidian` imports), tested with vitest. LLM calls always mocked in tests. `npm run typecheck`, `npm run lint`, `npm test` must pass.
3. **Land = commit + IMMEDIATE push.** Unpushed commits get wiped by parallel sessions (happened 2026-07-05). If push rejected: `pull --rebase`, re-run tests, push.
4. **Commit only your own files.** If unrelated modified files appear mid-task (version bumps, other features), leave them.
5. **Do NOT bump the plugin version** unless the brief is a release brief.
6. **Every new feature ships OFF by default** behind a setting, following the `MVASettings`/`DEFAULT_SETTINGS`/`MVASettingTab` pattern in `src/settings.ts`.
7. **All autonomous writes** carry `@generated` provenance and go through the shared `WriteQueue` (`plugin.memoryWriteQueue`); `@generated` may never supersede `@user` (guard exists in memory-store).
8. Autonomous writes are confined to `_system/` (+ `_system/playbooks/drafts/`). Human notes (Atlas/Active/Journal/Resources) only via the normal permission-gated tools.
9. Commit messages end with `Co-Authored-By:` line per repo convention.

## Gates (when each wave may start)

| Wave | Gate |
|---|---|
| W0 (cost governance) | none — do together with or before Wave 2 |
| Wave 2 | store has real content (weeks of observer with dozens of veto-surviving entries) AND decision record superseding "no-LLM dream pass" is written and approved by Mario |
| Wave 3 | Wave 2 live and stable; first heartbeat briefing must have something useful to say |
| Wave 4 | Waves 2+3 stable; blocks/loops/skills actually exist to unify |

---

## W0 — Background AI cost governance

**Goal**: one shared budget + kill-switch for every background LLM pass (observer, dream-LLM, heartbeat, skill foundry), before more than one of them can be ON.

**Design**:
- New settings section "Background AI" in the Exo settings tab: master toggle `backgroundPassesEnabled` (default ON — individual features still have their own toggles), `backgroundDailyTokenBudget` (number, default 200000), per-feature model select `backgroundModel` (default a Sonnet-class id; floor Sonnet, never Haiku — Mario's directive).
- New pure module `src/core/background-budget.ts`: a daily ledger `{ dateUTC: string, tokensUsed: number }` persisted in plugin data (settings object is fine); `canSpend(estimate)`, `recordSpend(tokens)`, `resetIfNewDay(now)`. Token counts come from the SDK usage events already surfaced (see quota badge / usage handling in providers).
- Every background pass (existing `runObserver` in `main.ts`, all passes added by W2/W3) MUST check `canSpend` before running and `recordSpend` after; on budget exhausted, skip silently with one console line (no Notice spam).

**Files**: `src/core/background-budget.ts` (new), `tests/background-budget.test.ts` (new), `src/settings.ts`, `src/main.ts` (wire observer through the budget).

**Acceptance**: budget module pure + unit-tested (day rollover, exhaustion, disabled master toggle = canSpend false for background passes); observer respects it; settings render; all suites green.

---

## Wave 2 — memory becomes intelligent

### W2-0 — Decision record (vault-side, HUMAN GATE — not a code brief)

Before W2-2 ships, write `_system/memory/decisions/2026-07-XX-dream-pass-llm-stage.md` in the vault with `supersedes: [[2026-05-XX deterministic dream pass decision]]` (locate the actual record; the choice dates to 2026-07-02, "Memory depth — slice 1"). It must state: LLM stage only PROPOSES, deterministic pipeline disposes; negative-selection gate; Mario approved on [date]. **Mario's explicit OK required. No silent commit.**

### W2-1 — claude-mem reader (read-only adapter)

**Goal**: read Mario's claude-mem observations so the dream LLM stage can propose importing durable ones into the Union Store. This drains the multi-thousand-observation backlog (the "3-way memory split").

**Verified storage format (inspected 2026-07-05)**: SQLite at `~/.claude-mem/claude-mem.db`, table `observations` with columns: `id INTEGER PK`, `memory_session_id TEXT`, `project TEXT`, `text TEXT`, `type TEXT` (values seen: change, bugfix, discovery, …), `title TEXT`, `subtitle TEXT`, `facts TEXT`, `narrative TEXT`, `concepts TEXT`, `files_read TEXT`, `files_modified TEXT`, `prompt_number INTEGER`, `discovery_tokens INTEGER`, `created_at TEXT`, `created_at_epoch INTEGER`. ~15.7k rows total across projects. FTS mirror tables exist (`observations_fts`) — do not touch them.

**Design**:
- No native SQLite dependency (Electron ABI pain). Shell out via `execFile` to the system `sqlite3` binary with `-json` output, read-only: `sqlite3 -json ~/.claude-mem/claude-mem.db "SELECT id, project, type, title, subtitle, facts, narrative, created_at_epoch FROM observations WHERE created_at_epoch > ? AND project IN (?) ORDER BY id LIMIT 500"`. Same execFile-with-explicit-args discipline as `git-autocommit.ts` (never shell-interpolate).
- New pure module `src/core/claudemem-reader.ts`: `parseObservations(json: string): ClaudeMemObservation[]` (tolerant: missing fields, bad JSON → empty + warning), plus a thin caller in an Obsidian-side module that runs the execFile. Watermark (last imported `id`) persisted at `_system/memory/claudemem-sync-state.json` (`{ lastImportedId: number, lastRunISO: string }`), written via the WriteQueue.
- Project filter: setting `claudememProjects` (string list, default `["-Users-mariomiletta-Vaults-marioverse-ai"]` — verify the actual project naming in the DB on read; it may be the path-slug format).
- Graceful no-ops: db file missing, sqlite3 binary missing, query error → return `[]`, log once.

**Files**: `src/core/claudemem-reader.ts` (new), `tests/claudemem-reader.test.ts` (new, fixtures with real-shaped JSON), `src/obsidian/` caller (new or folded into W2-2's dream-llm), `src/settings.ts`.

**Acceptance**: parser round-trips fixture rows; watermark logic unit-tested; all failure modes no-op silently; nothing writes to the claude-mem DB (read-only — no INSERT/UPDATE/DELETE/PRAGMA-write anywhere).

### W2-2 — Dream Pass v2: LLM proposal stage ("LLM proposes, kernel disposes")

**Goal**: an idle/scheduled LLM pass that reasons over the Union Store + learnings + claude-mem candidates and produces ONLY typed proposals, applied through the existing deterministic preview→apply→undo pipeline.

**Design**:
- **Requires W2-0 approved + W0 landed.** Setting `dreamLlmEnabled` (default OFF), runs as an extra stage when the dream pass runs (manual command or existing schedule).
- New `src/obsidian/dream-llm.ts`: assembles input (all store entries via memory-store, learnings dir listing, up to N=100 unimported claude-mem observations from W2-1), runs a transient tool-less session (generalize the observer chassis: extract `runObserver` in `main.ts` into a reusable `runUtilityPass(prompt, opts)` — same cheap-model, JSON-extraction, AbortSignal pattern), and parses a strict JSON output.
- **Proposal schema** (validate hard; reject the whole batch on schema mismatch, log raw):
  ```json
  { "proposals": [
    { "kind": "merge", "keepId": "…", "dropIds": ["…"], "reason": "…" },
    { "kind": "supersede", "newText": "…", "supersedesId": "…", "reason": "…" },
    { "kind": "rule_draft", "slug": "…", "text": "…", "evidenceIds": ["…"], "reason": "…" },
    { "kind": "import", "claudememId": 123, "text": "…", "reason": "…" }
  ] }
  ```
- **Negative-selection gate** (pure, deterministic, runs BEFORE anything is shown): drop any proposal that (a) supersedes/merges away an entry with `source: user`, (b) whose text matches a pattern in the vault's `_system/memory/known-false.md` (truth firewall patterns — parse the regex list tolerantly), (c) duplicates an already-applied proposal. Dropped proposals are listed in the preview as "culled (reason)" for transparency, never applied.
- **Apply semantics** (extend `src/obsidian/dream.ts` plan/apply/undo types): `merge` → new consolidated entry superseding the drops (append-only — nothing deleted); `supersede` → new entry with supersedes link; `rule_draft` → file in `_system/memory/learnings/` flagged as candidate (NOT directly into rules/ — the existing evidence≥3 promotion still owns that); `import` → store entry `@generated` with provenance line `origin: claude-mem:<id>`, watermark advanced only on apply. Everything through the WriteQueue; the existing DreamSnapshot/undo must cover all files touched.
- **Descriptive memory commits** (Letta Context Repositories): when the dream pass applies, trigger one auto-commit with a descriptive message, e.g. `exo: dream — merged 3, superseded 1, imported 12 from claude-mem` (extend `formatCommitMessage` in `git-autocommit.ts` to accept an optional summary).
- **Defrag objective** (Letta): deterministic pre-check — if `_system/memory/store/` or `learnings/` exceeds `memoryFileBudget` (setting, default 25 files), the LLM prompt includes a defrag instruction ("propose merges to reduce file/entry sprawl") and the preview shows a "defrag" section header.

**Files**: `src/obsidian/dream-llm.ts` (new), `src/core/` proposal-validation + gate module (new, pure, heavily tested), `src/obsidian/dream.ts` (extend plan types), `src/core/git-autocommit.ts` (message summary param), `src/main.ts` (runUtilityPass extraction + wiring), `src/settings.ts`, tests for validation/gate/apply-plan-mapping (LLM mocked).

**Acceptance**: with `dreamLlmEnabled` OFF nothing changes; ON → proposals appear in the existing preview modal in a distinct section with per-proposal reasons; gate provably culls @user-touching and known-false-matching proposals (unit tests with fixtures); apply is undoable via existing snapshot; batch with invalid JSON = zero writes; budget (W0) checked before the LLM call; watermark only advances on apply.

### W2-3 — Observer cadence option (small)

**Goal**: capture memory while context is hot in long sessions (Letta sleep-time cadence = every N steps).

**Design**: setting `observerCadence: "session-end" | "every-n-steps"` (default session-end, current behavior) + `observerStepInterval` (default 25). Count tool-calls per conversation in the turn loop (view.ts already sees tool events); at each N, schedule the same observer pass over the delta transcript since last run (track a per-convo high-water mark). Budget-checked (W0). No double-capture: session-end pass skips content already covered by step passes (pass the watermark into the prompt).

**Files**: `src/settings.ts`, `src/view.ts` or `src/main.ts` wiring, small pure counter module + tests.

**Acceptance**: default behavior unchanged; N-step mode fires at the right counts (unit-test the counter/watermark logic); no observer runs when `selfWritingMemory` OFF.

---

## Wave 3 — the agent takes initiative

### W3-1 — Perception buffer + signal gathering (pure core)

**Goal**: the heartbeat's senses — cheap, deterministic signals, no LLM.

**Design**:
- `src/core/perception.ts` (pure): ring buffer of `{ path, kind: "modify"|"create"|"delete", atEpoch }`, cap 200, coalesced per path (latest wins), glob include/exclude filters. Fed in `main.ts` from `this.registerEvent(app.vault.on(...))` — registration is thin, logic is pure.
- `src/core/heartbeat-signals.ts` (pure): `gatherSignals(inputs) → Signals` where `Signals = { dueLoops: LoopSummary[], dreamBacklog: number, claudememPending: number, recentFiles: {path, kind}[], staleContexts: {path, ageDays}[] }`. Inputs are provided by thin Obsidian-side callers: due loops from `open-loops.ts` (`dueLoops(now)` exists), dream backlog from learnings dir count, claudemem pending from W2-1 watermark vs max id, stale contexts from file mtimes of `**/context.md` older than 7 days.
- `worthWaking(signals, thresholds): boolean` — pure decision: false when everything is empty/below thresholds. Thresholds in settings with sane defaults (any due loop → true; backlog ≥ 10 → true; etc.).

**Files**: both new core modules + tests (this brief is ~80% tests), `src/main.ts` event registration, `src/settings.ts` (globs, thresholds).

**Acceptance**: pure modules fully unit-tested (coalescing, caps, globs, thresholds, empty→false); zero LLM calls; zero writes.

### W3-2 — Heartbeat run: decide → one briefing → review.md + badge

**Goal**: the scheduled wakeup. Exo acts unprompted for the first time — output confined to ONE reviewable surface.

**Design**:
- Scheduler: reuse the existing `scheduledRuns` pattern (headless playbooks) with a reserved name `heartbeat`, cadence setting `heartbeatCadence: "off" | "daily" | "twice-daily"` (default OFF).
- Run: gather Signals (W3-1) → if `!worthWaking` → append one line to a rolling log in `_system/reports/heartbeat-log.md` ("slept, nothing due") and stop — NO LLM call, NO review entry. If worth → budget check (W0) → transient utility pass (chassis from W2-2) with: the Signals JSON, the beats list, and a hard instruction to return `{ "worth_surfacing": bool, "briefing_md": "…" }` (≤ 40 lines briefing). If `worth_surfacing` false → sleep log only.
- **Beats** (structure for proactivity): setting `beats: { name: string, scope: string }[]` (scope = folder path or glob, e.g. `Active/Projects/Exo/`). The briefing is organized per beat + a "fuori beat" section. Settings UI: simple add/remove list.
- Output: append to `_system/review.md` a section `## [YYYY-MM-DD HH:MM] Heartbeat` with the briefing (serialized through a write queue). Ribbon badge: reuse/extend the Exo ribbon icon with a count of review sections newer than `lastReviewSeenISO` (persisted); clicking opens `review.md` and marks seen.
- Hard caps: max 1 briefing per cadence slot; max briefing length; if review.md exceeds 500 lines, heartbeat proposes (in the briefing itself) archiving old sections — never auto-archives.

**Files**: `src/core/heartbeat.ts` (new, orchestration logic pure where possible), `src/main.ts` (schedule + ribbon badge), `src/settings.ts` (+ beats UI), prompt template, tests for decide/skip logic and review-section formatting (LLM mocked).

**Acceptance**: OFF by default, nothing runs; ON with empty vault signals → sleep log only, zero LLM cost; with due tickler → briefing lands in review.md, badge increments, click clears; all writes @generated-marked in the section header (`by: exo-heartbeat`); budget respected.

### W3-3 — Task signals + skill drafts (foundry, capture side)

**Goal**: the Do→Learn→Improve input — detect "this session solved something reusable / hit the same friction again".

**Design**:
- `src/core/task-signals.ts` (pure): per-conversation outcome record computed from events Exo already tracks: `{ toolCalls, editedFiles, watchdogFires, recoveries, permissionDenials, durationMs, userCorrections }` (userCorrections = heuristic: user message starting with "no"/"non"/"sbagliato" following an assistant action — keep the heuristic simple and documented). Friction signatures: `denial:<toolName>`, `watchdog:<phase>`, `recovery:<stage>` with persisted counters (settings/data.json).
- Trigger rules (pure, tested): success trigger = `toolCalls ≥ 8 && recoveries == 0 && userCorrections == 0`; friction trigger = any signature counter reaching 3 (then reset that counter). Cap: `maxSkillDraftsPerWeek` default 3.
- On trigger: utility pass (budget-checked) drafts a skill document from the transcript → `_system/playbooks/drafts/<slug>.md` with frontmatter `{ type: skill-draft, trigger: success|friction:<sig>, evidence: N, created_by: exo, created: date }` + sections When to use / Steps / Pitfalls. Draft NEVER auto-promotes.

**Files**: `src/core/task-signals.ts` + tests (the trigger rules are the heart — test exhaustively), draft-generation wiring in `main.ts`/`view.ts` session-close path, `src/settings.ts` (`skillFoundryEnabled` default OFF, weekly cap), prompt template.

**Acceptance**: OFF = zero behavior change; triggers unit-proven on synthetic outcome records; weekly cap enforced across restarts; drafts land only in `drafts/`, well-formed frontmatter.

### W3-4 — Skill promotion + capability panel surfacing

**Goal**: close the foundry loop — drafts become runnable playbooks only with evidence + human bless.

**Design**: capability discovery panel gains a "Skill drafts" card listing `_system/playbooks/drafts/` (name, trigger, evidence, age) with two actions per draft: **Promote** (moves file to `_system/playbooks/`, making it available to the existing playbook runner/command) and **Dismiss** (moves to `_system/playbooks/.archive/` — never deletes). The deterministic dream pass counts reuse: when a promoted playbook runs successfully via the headless runner, increment `evidence` in its frontmatter. v1 promotion is ALWAYS manual (bless); auto-promotion at evidence≥3 is a later toggle, not in this brief.

**Files**: capability panel module (locate in `src/` — verify on read), `src/main.ts` command wiring, small core module for draft listing/moves + tests.

**Acceptance**: drafts render; Promote makes the playbook runnable via existing "Run playbook now"; Dismiss archives; no delete path exists; panel handles empty/malformed drafts gracefully.

---

## Wave 4 — the identity unifies

### W4-1 — Agent folder layout + core + seeder

**Goal**: `_system/exo/` as the agent's serialized self (Letta .af, but human-legible Markdown).

**Design**:
- Layout: `_system/exo/manifest.md` (frontmatter: `boot_blocks` ordered list, `loops_ledger` path, `version`; body: one-paragraph identity statement) + `_system/exo/blocks/human.md`, `persona.md`, `now.md` — each with frontmatter `{ owner: "interactive" | "dream", limit_chars: 1500 }` and plain-markdown body. Limits are ADVISORY: exceeding emits a defrag suggestion (surfaced in review.md), never truncation.
- `src/core/agent-self.ts` (pure): parse/serialize manifest + blocks, `compileBootPreamble(folder, loops, opts) → string` with a total char budget (mirror current ~9k cap), validation (missing files tolerated with warnings).
- Command "Exo: Initialize agent folder": seeds the folder FROM current sources (`_system/vault-context.md` §Stato attuale → `now.md`; preferences → `human.md`; identity paragraph from vault CLAUDE.md → `persona.md`), marked `@generated`, only if folder absent (never overwrites an existing folder).

**Files**: `src/core/agent-self.ts` + tests (parse/serialize/compile/budget), seeder command in `main.ts`.

**Acceptance**: pure core fully tested; seeder idempotent (second run = no-op with Notice); nothing reads the folder yet (that's W4-3) — this brief is substrate only.

### W4-2 — `rethink_memory` tool + owner policy

**Goal**: the agent edits its own core blocks — with the concurrency rule Letta learned the hard way (rewrites = last-writer-wins → ONE owner per block, everyone else append-only).

**Design**: new MCP tool `rethink_memory(block: "human"|"persona"|"now", new_content, reason)` registered under OBSIDIAN_MEMORY_TOOLS (gated by `memoryWriteEnabled` AND a new `agentSelfEditEnabled`, default OFF). Enforcement: tool callable ONLY from interactive sessions (observer/dream/headless pass a flag that suppresses registration — verify how tool servers are constructed per session and use the cleanest existing mechanism); per-block `owner` frontmatter must be `interactive`; one rethink per block per turn (in-memory latch). Every accepted edit: diff rendered in the activity feed ("Exo rethought persona: …" with old→new), written atomically via WriteQueue, and the block file's git history is the undo (auto-commit is ON). Reject with clear tool-error when: content exceeds 2× limit, block unknown, owner mismatch, second rethink same turn.

**Files**: `src/obsidian/tools.ts`, `src/core/agent-self.ts` (edit + validation helpers, pure, tested), activity feed event, `src/settings.ts`.

**Acceptance**: tool invisible when toggles OFF; rejects tested (pure validation unit tests); accepted edit produces feed diff + file change + (within cadence) an auto-commit containing it; observer/dream/headless sessions cannot call it.

### W4-3 — Boot compiler + legacy fallback (the actual cutover)

**Goal**: replace the static ~9k `readBootContext()` preamble with compilation from the agent folder — reversibly.

**Design**: setting `bootMode: "legacy" | "agent-folder"` (default **legacy**). In agent-folder mode, `readBootContext()` (in `src/obsidian/memory.ts`) delegates to `compileBootPreamble`: manifest identity + blocks (in manifest order) + due/active loops (existing injection) + rule-index filenames + last session-log entries — same total char budget as today. Headless runner uses the same compiler automatically (it shares readBootContext — verify). Log the compiled preamble size in console for comparison. Keep BOTH paths until Mario validates quality over a comparison period, then a later cleanup brief may remove legacy. Cross-surface note: CLI/Cowork adoption is a vault-side documentation change (CLAUDE.md points at the folder) — out of scope here.

**Files**: `src/obsidian/memory.ts`, `src/core/agent-self.ts` (already has compile), `src/settings.ts`, tests comparing legacy vs compiled budgets on fixtures.

**Acceptance**: default = byte-identical legacy behavior; switch flips cleanly at next session spawn (no reload needed if settings are read per-spawn — verify); compiled preamble respects budget; missing folder in agent-folder mode → graceful fallback to legacy with one Notice; Codex adapter parity explicitly decided and documented in the PR/commit body (allowed: Claude-only v1 with Codex staying legacy).

---

## Execution protocol

1. **Order**: W0 → (gate) → W2-1 → W2-2 (+W2-3 anytime after W0) → (gate) → W3-1 → W3-2, W3-3 → W3-4 → (gate) → W4-1 → W4-2 → W4-3. W2-0 (decision record) is Mario's, before W2-2 ships.
2. **Launch**: each wave = one `/orchy` run with these briefs as the task input (point orchy at this file + the brief IDs). Builders: prefer worktree isolation on this repo (it is light — the 2026-07-03 "never worktree the vault" lesson does not apply here); if sharing the working tree, rule 4 above is load-bearing.
3. **After each wave lands**: build+deploy (`npm run build` deploys to the vault via `.obsidian-plugin-dir`), reload plugin (disable→enable), verify settings keys live, update the vault doc (`Exo — Agent Evolution` §0 snapshot + §10 dev log) and `Active/Projects/Exo/context.md`, cut a release when Mario validates live.
4. **Activation discipline**: every toggle starts OFF; Mario activates one feature at a time and watches the activity feed / review.md before the next.

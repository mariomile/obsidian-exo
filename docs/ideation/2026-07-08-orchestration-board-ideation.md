---
date: 2026-07-08
topic: orchestration-board-true-orchestrator
focus: what to add to the just-shipped Orchestration Board to make it a true AI orchestrator (chat stays primary, everything flag-gated and isolated)
mode: repo-grounded
---

# Ideation: Orchestration Board → True AI Orchestrator

## Grounding Context

**Codebase:** Board shipped 2026-07-08: 6 columns (backlog→queued→running⇄needs-input→review→done, archived hidden), pure reducer `core/orchestrator.ts`, config `{maxConcurrent}` only, single effect type `spawn-chat`, review→done human-only, markdown ledger `_system/orchestration/tasks.md`, hard one-way dependency board→chat. Mature-but-unwired modules: `recap.ts`, `open-loops.ts`, `dream-proposals.ts`/`observer.ts`, `background-budget.ts`, `turn-watchdog.ts`, `git-autocommit.ts`, `permissions.ts`, `model-tuning.ts`, prompt-vars, 9 vault subagents. Gaps: no priority/deps/retry/scheduling; needs-input sits unnoticed; cards don't summarize outcomes; no task auto-generation.

**External:** Hermes Kanban (7-state, DAG auto-promote, circuit breaker, run audit trail); Operator (ticket type → auto vs paired); Agent Fleet = direct Obsidian competitor (cron+catch-up, Approvals tab, per-task permission modes); GitHub Mission Control + Devin converge on one view (logs+diff+steering); Devin Playbooks; LangGraph (guarded edges, retry-as-config); ChatGPT Tasks (hard caps); SRE DENY/ALLOW/HUMAN tiering vs approval fatigue; runaway-cost postmortems ($47k/$1.3M): stop conditions outside the agent loop. Market: 4 adjacent Obsidian plugins; kanban wrapper alone ≠ moat; differentiation = chat-first + vault-native.

**Central insight:** the bottleneck is human supervision attention, not agent slots. Most survivors attack that constraint.

## Ranked Ideas

### 1. Review Cockpit with bookends (readback + recap on card)
**Description:** At spawn, the agent writes a 2-line "readback" (its interpretation of the task) into the ledger block, surfaced on the card; at turn-end, a `recap.ts` outcome digest (files touched, notes read, web sources, skills) + diff chip. Review happens from the board; opening the chat becomes the exception. Optional "dailies" digest batches the day's review-column entries into one note.
**Warrant:** `direct:` `recap.ts` exports per-convo synthesis, unwired; "cards don't summarize outcomes" is a named gap. `external:` GitHub Mission Control + Devin converged on one merged view; FAA readback-hearback.
**Rationale:** Review→done is human-only by design, so per-card review cost is the throughput ceiling of the whole board. Readback moves wrong-task detection from minute 20 to second zero.
**Downsides:** how much recap to persist in the ledger (bloat vs evidence completeness).
**Confidence:** 90% **Complexity:** Medium **Status:** Unexplored

### 2. Kernel Safety Rail (safe re-run substrate)
**Description:** Bundle, all kernel-side: budget gate (`background-budget.ts` consulted before `spawn-chat`; exhausted → tasks pool queued with badge), retry-as-config + circuit breaker (N consecutive errors → blocked flag, stops consuming slots), stall watchdog (`turn-watchdog.ts` → no activity for N min → needs-input "stalled", slot freed), task = append-only lineage of runs (`- run:` lines replacing single `convo:` pointer), per-task git-autocommit checkpoints (diff-per-card, rollback, retry-from-checkpoint).
**Warrant:** `direct:` budget/watchdog/git modules shipped and unwired; `orchestrator.ts` overwrites convo history on re-run. `external:` runaway postmortems; Hermes circuit breaker + audit trail; LangGraph retry-as-config.
**Rationale:** Stop conditions must live outside the agent's reasoning loop. This is the enabling floor for every autonomy feature — sequence it before #4/#6.
**Downsides:** retry semantics interact with the known CLI-interrupt-masquerades-as-crash bug; must define "dead" first.
**Confidence:** 85% **Complexity:** Medium-High **Status:** Unexplored

### 3. Attention Economics (andon + review WIP limit + concierge)
**Description:** The reducer models human attention as the scarce resource: needs-input triage strip batched by reason; "concierge" attaches an LLM-drafted answer to the agent's question (send stays human); andon line-stop (blocked tasks over threshold → freeze new spawns, visible banner); WIP limit on the review column (spawn metered by landing capacity, not takeoff slots).
**Warrant:** `external:` TPS jidoka/andon; FAA Ground Delay Programs; SRE tiering vs approval fatigue. `reasoned:` work finished beyond review capacity decays (diffs rot against a moving vault) — metering upstream converts decay into cheap waiting.
**Rationale:** `maxConcurrent` limits the wrong resource; this reframes the board around the human-in-the-loop constraint the non-negotiables already encode.
**Downsides:** a philosophy decision, not just a feature — needs deliberate adoption.
**Confidence:** 75% **Complexity:** Medium **Status:** Unexplored

### 4. Task Inbox / Proposal Kernel (single gated producer channel)
**Description:** Generalize `dream-proposals.ts` into one "LLM proposes, kernel disposes" channel for task creation: producers (open-loops due dates first; observer, recap follow-ups, cron later) emit typed proposals; kernel validates/dedupes; proposals render as a ghost lane; one click accepts into backlog (inert by design). Producers never write the ledger directly.
**Warrant:** `direct:` `dream-proposals.ts` hard-validates typed proposals ("the model can never directly mutate memory"); `tasks.md` deliberately mirrors the open-loops block format. `external:` Agent Fleet's Approvals tab (bolted-on version); Devin coordinator pattern.
**Rationale:** Converts autonomy from per-feature risk into per-producer registration; closes "no auto-generation" with zero new execution risk.
**Downsides:** proposal vocabulary is a one-way door.
**Confidence:** 85% **Complexity:** Medium **Status:** Unexplored

### 5. `after:` dependencies with recap piping
**Description:** DAG-lite: optional `after: task-id` field; unmet deps → ineligible for promotion; parent Done (human) auto-promotes children — and the parent's recap is injected into the child's spawn prompt via prompt-vars. Cycle detection pure-core at parse/edit time.
**Warrant:** `external:` Hermes DAG auto-promote. `reasoned:` ordering is commodity; the differentiated half is that Exo owns both run A's recap and run B's prompt construction — a capability composition no adjacent plugin has the parts for.
**Rationale:** Pipelines (research→synthesize→draft) are the actual shape of the primary workflows; human Done at every joint = supervised pipelines for free.
**Downsides:** first relational structure in a deliberately flat ledger; minimal shape (single vs list) is a schema decision.
**Confidence:** 80% **Complexity:** Medium **Status:** Unexplored

### 6. Playbooks + recurring tasks
**Description:** "Save as playbook" on a done task distills prompt + shape into a parameterized template (`{{var}}` slots, markdown under `_system/orchestration/`); "Run playbook" instantiates; `recur:`/`schedule:` field with Agent-Fleet-style catch-up (missed while Obsidian closed → run once, never storm). Each run still passes review individually.
**Warrant:** `external:` Devin Playbooks; Agent Fleet cron+catch-up (direct competitor headline). `direct:` prompt-vars + verbatim-prompt ledger already persisted.
**Rationale:** Every successful run permanently cheapens its task class; vault-markdown playbooks are editable/linkable/git-versioned — a moat vs opaque template stores.
**Downsides:** template-vs-instance data-model fork; interacts with budget breaker.
**Confidence:** 80% **Complexity:** Medium **Status:** Unexplored

### 7. Typed cards / tier routing (CCIR)
**Description:** Optional `kind:` (research/triage/draft/code) maps to a spawn profile: vault subagent persona, model tier, permission posture `auto|review|paired` (auto = zero prompts, read-only; paired = chat panel forced open). Plus a CCIR-style interruption contract: enumerate what may interrupt the human, not what the agent may do.
**Warrant:** `external:` Operator ticket-type routing; US Army CCIR doctrine (FM 6-0); SRE tiering. `direct:` `permissions.ts`, `model-tuning.ts`, 9 vault subagents exist, invisible to the board.
**Rationale:** One classification at creation replaces N runtime trust decisions; `kind` is the keystone attribute future per-type budgets/playbooks/review-strictness hang off. Vault-native blast-radius profiles (folders a task may touch) are inexpressible for generic CLI wrappers.
**Downsides:** keystone field — expensive to get wrong.
**Confidence:** 70% **Complexity:** Medium **Status:** Unexplored

## Recommended sequence

1 (immediate value, no new autonomy) → 2 (the floor) → 4/5/6 in any order → 3 and 7 when real concurrency rises.

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Speculative fan-out (`fanout: N` racing workers) | Premature: quality instrument before the reliability floor (#2) exists; multiplies cost without a breaker |
| 2 | Early Warning Score (composite hospital-style vitals) | Duplicates simpler watchdog + budget thresholds; tuning burden for marginal gain |
| 3 | Expo table-grouping (hold related tasks for joint review) | Covered by dependencies (#5) + dailies batching (#1) |
| 4 | Budget-line (periodic LLM rewrite of card status lines) | Recurring LLM cost for cosmetic benefit; recap-at-boundaries covers it |
| 5 | Zero-UI ledger-as-public-API | Premature versioning commitment; its proposal-lane half folded into #4 |
| 6 | Away Mode (week-long unattended operation) | Emergent composition of #2 + #3, not a primitive |
| 7 | `spiked` terminal state (editorial kill-with-reason) | Folded into #2's run-lineage semantics |

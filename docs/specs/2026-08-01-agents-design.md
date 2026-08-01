# Named agents — design

**Status:** shipped behind `agentsEnabled` (default OFF) · **Date:** 2026-08-01

## Why

Exo could already spawn the CLI, run scheduled headless playbooks, orchestrate a
task board and propose changes — but it had no first-class notion of a *named
agent*. Typing `@ghostwriter` in the composer inserted text and hoped the model
would notice.

Meanwhile the reference products shipped: **Notion Custom Agents** (3.3, Feb
2026 — instructions + triggers + sources + scoped permissions + model) and
**Buzz** (Block, Jul 2026 — agents as workspace members with their own
cryptographic identity and attributed work).

Goal: parity on invocation and autonomy, and past both on the two axes neither
covers — **agent↔agent collaboration** and **per-agent compounding memory** —
while keeping agent definitions portable outside Obsidian.

## The constraint that shapes everything

`docs/architecture.md`: *"The engine is the product. Exo adds surface, never a
second brain."*

So the agent **brain** stays a CLI-native agent file, and Exo contributes only
binding, triggers, attribution, memory and UI. Three things the original plan
called for dissolved once that was taken seriously:

| Planned | Why it went away |
|---|---|
| `SessionOpts` override for `/as` | The binding is a payload-only rider, so there is no new session field — and therefore no `sessionSigOf()` entry to keep in sync. The bug class is removed by construction, not by discipline. |
| `LiveTaskKind: "named-agent"` | Delegating makes the engine call `Agent`, which already registers a `subagent` live task. A second kind would double-count one thing. |
| `AutomationConfig.agent?` | An agent's schedule belongs in its own contract, not in a parallel list. |

## Data model — two files, two owners

```
.claude/agents/<slug>.md            <memoryRoot>/agents/<slug>.md
┌──────────────────────────┐        ┌──────────────────────────────┐
│ THE BRAIN (CLI-native)   │◄───────┤ THE CONTRACT (Exo-owned)     │
│ name, description,       │ slug   │ enabled, icon, autonomy,     │
│ model, tools + prompt    │        │ cooldown, read/write globs,  │
│                          │        │ can_call, triggers           │
│ Runs in Claude Code CLI, │        │                              │
│ Cowork, Codex, Exo       │        │ Vault content → syncs to     │
│ Exo never writes it      │        │ mobile, versioned in git     │
└──────────────────────────┘        └──────────────────────────────┘
                                    <memoryRoot>/memory/agents/<slug>.md
                                    └─ compounding memory
```

**Why two files.** Three warrants, each sufficient on its own:

1. `.claude/` is gitignored and does not sync to mobile — triggers kept there
   would be neither versioned nor visible on a phone.
2. The vault's Sacred Rules make `.claude/agents/` CLI-managed.
3. The brain has a different audience (every harness) and lifecycle than the
   trigger config (this plugin's runtime).

The sidecar is scaffolded automatically, so the two-file cost is paid by the
machine.

### Sidecar shape

```yaml
---
type: agent            # the guard: a file here without this is NOT a contract
agent: ghostwriter
enabled: false
icon: pen-line         # lucide id, never an emoji
autonomy: propose      # notify | propose | act
cooldown: 30m
read:  ["Active/Projects/Content/**"]
write: []              # empty = no autonomous writes, ever
can_call: [research-analyst]
triggers:
  - schedule weekly mon 08
  - vault-event create _inbox/**
  - note-mention
  - tag #needs/post
---
```

Triggers are a one-line DSL so the file stays plain YAML — hand-editable on a
phone, diffable, and parseable without a YAML dependency (`core/` must stay
dependency-free and Obsidian-free).

## Invocation

- **`@agent`** in the composer binds **the turn**.
- **`/as <agent>`** binds **the conversation**; `/as off` clears it.
- Both emit a provider-only `<agent-binding>` rider naming an explicit
  `Agent({ subagent_type })` delegation — never touching the visible or
  persisted message, exactly like Research Mode.

**The invocable id is not the filename.** Verified against a live `system/init`
capability snapshot: `.claude/agents/career-coach.md` with `name: Career Coach`
is invoked as `"Career Coach"`, and a plugin's `foo.agent.md` as
`"plugin:foo"`. So the id is scope prefix + frontmatter name.
`reconcileInvocable()` snaps ids to the engine's own roster when the match is
unambiguous, and refuses to guess when it is not.

## Autonomy

```
 schedule      vault-event      tag        note-mention      manual
 (isDue)       (debounced)   (transition)   (human typed)   (palette)
     └──────────────┴─────────────┴──────────────┴──────────────┘
                                 ▼
                      gates (core/agent-runs.ts)
        disabled → duplicate → concurrency → budget → cooldown
                                 ▼
                     runHeadlessPlaybook()
          read-only auto-allow · snapshot-before-write · watchdog
                                 ▼
        notify → report only   propose → read-only, describes changes
                          act  → writes, checkpointed and restorable
                                 ▼
              <memoryRoot>/agents/runs/YYYY-MM.md   (ledger)
```

Gates live **outside** the agent's reasoning loop: an agent cannot argue past a
cooldown the way it could past an instruction in a prompt.

### Event triggers — the guards are the feature

These are the plugin's first filesystem listeners; everything autonomous before
was a poll or a post-turn hook.

- **Disarmed at load.** Obsidian replays `create` for every file while indexing.
  An armed-at-load driver would fire once per existing note. The driver arms
  only after `onLayoutReady`.
- **Tool-owned trees never trigger** (`.obsidian/`, `.claude/`, `.trash/`, the
  memory root). This is also what stops an agent re-triggering itself on its own
  report.
- **5s debounce, coalesced per path**, with `create` surviving Obsidian's
  create→modify pair for one new file.
- **Tags fire on the transition**, not the state — otherwise every later edit of
  a tagged note re-fires.

## Agent↔agent

`invoke_agent(agent, task)` — gated by a deny-by-default `can_call` allowlist, a
depth cap of 2, and the budget. Depth is checked **before** the allowlist, so a
runaway chain stops by arithmetic rather than by correct configuration. A human
(`exo`) may invoke anyone; the allowlist binds only agent-to-agent calls.

Nested runs are exempt from the concurrency cap: the caller is blocked awaiting
the tool result, so a nested run adds depth, not parallelism.

Caller identity comes from a plugin-level context, because the MCP tool surface
carries none. Safe as a single value because runs are sequential.

## Attribution and memory

- **Ledger** — append-only markdown, one file per month, same shape as the
  Orchestration ledger. Every run is recorded, successful or not: a failed run
  that leaves no trace is how a quietly broken agent stays invisible.
- **Memory** — `<memoryRoot>/memory/agents/<slug>.md`, read into the next run's
  prompt. This is what makes runs compound instead of repeat.

Exo writes the facts; the agent writes judgment into its own memory. Neither
writes the other's half.

**Not done deliberately:** stamping `last_edited_by: agent/<slug>` on touched
notes. The vault's own convention limits that property to AI-managed files and
forbids it on human notes. The ledger gives attribution without writing into
the user's notes.

## Seeds

Recognised agent slugs scaffold with a plausible contract instead of a blank
one. Seeds **never** enable an agent, never grant a write scope, and never use
the `act` tier — enforced in `seededContract` and tested, because the difference
between a helpful default and a plugin that starts editing your notes is exactly
this invariant.

## Where this beats the references

| Axis | Notion | Buzz | Exo |
|---|---|---|---|
| Agent↔agent | ✗ (DB triggers only) | partial | ✅ allowlist + depth cap + ledger |
| Per-agent compounding memory | ✗ | ✗ | ✅ |
| Definitions portable outside the app | ✗ | platform-bound | ✅ same file runs in CLI / Cowork / Codex |
| Definitions greppable, linkable, versioned | ✗ | ✗ | ✅ they are vault notes |
| Per-run snapshot + restore | "reversible" | — | ✅ real checkpoints |
| Propose-tier autonomy | binary permissions | permissions | ✅ read-only tier that describes its intent |

## Files

`core/agents.ts` (registry, binding, `/as`) · `core/agent-runs.ts` (gates, run
prompt, invoke gate) · `core/agent-triggers.ts` (event matching) ·
`core/agent-ledger.ts` (ledger + memory) · `core/agent-seeds.ts` (seeds) ·
`obsidian/agent-store.ts` (join, scaffold, ledger IO) ·
`obsidian/agent-triggers.ts` (debounce, arming) · `ui/agents-view.ts` (pane) ·
plus wiring in `main.ts`, `view.ts`, `ui/composer.ts`, `obsidian/tools.ts`.

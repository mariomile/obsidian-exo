# Exo — Architecture

Exo is not a chatbot with an API key. It is a **frontend for the Claude Code CLI** (or Codex CLI) embedded in Obsidian: the plugin spawns the agent you already have installed, with **your vault as the working directory**, and renders its stream as a chat. Same brain, same native tools, same billing, same on-disk transcripts as the terminal — different surface.

That one decision drives everything below. Whenever Exo behaves worse than Claude Code in a terminal, the bug is almost always in our layer, not the engine — and the fix is to get out of the engine's way.

## The three layers

```
┌────────────────────────────────────────────────────┐
│ main.ts — plugin lifecycle                         │
│   settings (data.json) · history (conversations.   │
│   json) · commands · view registration             │
├────────────────────────────────────────────────────┤
│ view.ts — ChatView (the core)                      │
│   UI: composer, tabs, transcript, context ring,    │
│       outline rail, gallery                        │
│   Turn orchestration: runTurn() consumes the       │
│       event stream, renders tool cards & text      │
│   Per-conversation state: each tab is a Convo      │
│       with its own live session, messages, perms   │
├────────────────────────────────────────────────────┤
│ providers/ — the adapter layer                     │
│   claude.ts (Agent SDK → Claude Code CLI)          │
│   codex.ts  (Codex CLI)                            │
│   One AgentSession interface; the view never       │
│   knows which engine is running.                   │
└────────────────────────────────────────────────────┘
```

The adapter translates each engine's native stream into neutral events (`text-delta`, `thinking-delta`, `tool-call-start`, `permission-request`, `usage`, `turn-end`, `error`). Adding a provider means one new file and zero UI changes.

## Session model

- One conversation tab = one long-lived `query()` session (Agent SDK, streaming input). Parallel tabs are genuinely parallel CLI processes.
- Sessions resume by id: the CLI writes its transcript to `~/.claude/projects/*.jsonl`; a fresh process with `resume: sessionId` reattaches to the full context. Exo persists the session id per conversation, so closing a tab (or Obsidian) never loses the model's memory.
- Sessions are prewarmed opportunistically so the first message of a turn doesn't pay spawn latency.

## Becoming Claude Code inside Obsidian

Three SDK mechanisms carry the identity — each with a lesson learned in production:

1. **System prompt preset.** `systemPrompt: { type: "preset", preset: "claude_code", append: "…" }` keeps Claude Code's own prompt (tool discipline, conciseness, token economy) and appends the Exo/vault identity. Passing a plain string here *replaces* CC's brain instead of extending it — a mistake we made once and won't repeat.
2. **In-process MCP server.** `createSdkMcpServer` exposes Obsidian-native tools (`ask_user` for interactive questions, memory tools, vault operations) that run *inside* the plugin process — no external servers. Lesson: an SDK MCP server instance binds to the first session that uses it and is silently unusable afterwards, so Exo builds **one instance per session**.
3. **Permission bridge.** The SDK calls our `canUseTool` callback for every tool use; Exo turns it into a permission card in the transcript, backed by allow/deny rules from settings, per-conversation "always allow", and a bypass mode. `ask_user` uses the same suspended-promise pattern: the tool call resolves only when the user clicks an option.

## Runtime defenses

A CLI process inside a sidebar can die in creative ways. Exo assumes it will:

- **Idle watchdog** — interrupts a turn that stalls with no output; suspended while an interactive card (permission / ask) is waiting on the user, because a thinking human is not a hung process.
- **Poisoned-session recovery** — when the CLI aborts a turn with `error_during_execution`, the live process is unusable and is dropped. Recovery is two-stage: the next message first **resumes** the same session id (the on-disk transcript survives the crash — full context, zero cost); if the resume itself re-errors, Exo falls back to a fresh session **seeded with a recap** built from the transcript it already holds. An error costs a process, never the conversation.
- **stderr ring buffer** — the CLI's diagnostics are captured per session and attached to error reports.
- **Checkpoints** — files are snapshotted before writes, powering "Rewind code + conversation" from any assistant message.

## Who remembers what

Three distinct memories, deliberately separated:

| Store | Owner | Contents | Survives |
|---|---|---|---|
| `~/.claude/projects/*.jsonl` | CLI | the model's real context (every message, tool call, result) | everything — this is what `resume` reattaches |
| `conversations.json` | Exo | the UI transcript (rendered messages, tool cards, checkpoints), recency-evicted at 30 conversations | plugin reloads |
| `data.json` | Exo | settings, open tabs, active tab | plugin reloads |

The context ring in the toolbar reads real `usage` events from the stream; clicking it sends a guided `/compact`. Token pressure is managed where it actually lives — in the CLI session — not simulated in the UI.

## The Capabilities hub

One pane (`src/ui/hub/`, view type `exo-connections` — the string is
workspace-persistent and never changes) holds everything the agent can do and
the machinery around it. Six tabs, each a self-contained renderer receiving a
`HubTabContext { app, plugin, rerender, base }`:

| Tab | What it manages |
|---|---|
| Overview | session + system status, Exo Queue actions |
| Skills | skill marketplace (import/remove) + Commands, Sub-agents, Hooks, Tools |
| MCP | add / edit / enable / disable / remove / reconnect / re-auth |
| Playbooks | custom prompts, schedule badge, read-only Run now |
| Automations | scheduled runs, Daily Pulse, restorable write runs |
| Memory | dream pass, store, open-loops, vault-memory files |

Two rules keep it coherent. **Rows with inline actions, never cards with
click-through** — seeing a thing and acting on it are the same gesture.
**Live caps first, disk scan as fallback**: the CLI's `system/init` snapshot is
the truth about what a session loaded; the filesystem scanners in
`core/capability-scan.ts` cover the gap before the first spawn and on Codex.

The chat keeps only a slim **session card** (`ui/session-card.ts`) — a glance at
provider/model/effort plus the live counts, with one button into the hub. Both
surfaces re-render when a new caps snapshot lands (`plugin.refreshHub()`).
Pure logic lives in `core/hub-sections.ts` (partitioning) and
`core/actions-hub.ts` (view models), both unit-tested without a DOM.

**Agent-native, not UI-only.** Everything the hub does with a click, the agent
can do from chat: `list_capabilities`, `manage_mcp_server`, `manage_skill`
(`obsidian/capability-tools.ts`) sit on the same core as the pane, so the two
halves cannot drift. Mutating tools take the standard permission card; only
vault-owned servers are editable, and skill import never touches the source
folder. The shared `Result`/`ok`/`err`/`getExo` kit lives in
`obsidian/tool-kit.ts` so `tools.ts` and `capability-tools.ts` don't import each
other.

**A source is more than a config.** `.mcp.json` says how to connect; it never
says what a server is *for*. Each server can carry a note at
`.claude/mcp/<name>.md` — what it's for, scope, what to avoid — which the agent
pulls on demand via `list_capabilities({ with_notes: true })` rather than having
it pushed into every session's prompt. Permissions work at the same granularity:
a rule's tool name can end in `*`, so `mcp__notion__*` governs a whole source
including tools it adds later (`core/permissions.ts`, `matchToolName`).

## Named agents

An agent is two files with two owners: the **brain** (`.claude/agents/<slug>.md`
— CLI-native, portable across Claude Code / Cowork / Codex, never written by
Exo) and the **contract** (`<memoryRoot>/agents/<slug>.md` — triggers, autonomy
tier, scope globs, `can_call`). The split is forced by fact: `.claude/` is
gitignored and does not sync to mobile, so trigger config kept there would be
neither versioned nor visible on a phone.

Principle 1 does the work here. Binding a turn to an agent (`@agent`, `/as`)
emits an explicit `Agent({ subagent_type })` delegation as a provider-only
rider — Exo does not run the agent, it stops being ambiguous about which one the
engine should. Consequently there is no per-agent `SessionOpts` field and no
`sessionSigOf()` entry to keep in sync.

Autonomy is the part Exo genuinely adds: schedule triggers ride the existing
30-minute heartbeat, and event triggers (`vault-event`, `tag`, `note-mention`)
are the plugin's only filesystem listeners. They are debounced, exclude
tool-owned trees (which is also what stops an agent re-triggering itself on its
own report), and start **disarmed** — Obsidian replays `create` for every file
while indexing. Runs execute through the headless profile, so checkpoint,
restore and the review queue come for free. Every run lands in an append-only
monthly ledger; `invoke_agent` lets one agent hand work to another under a
deny-by-default allowlist and a depth cap. Design: `docs/specs/2026-08-01-agents-design.md`.

## Headless mode

Not everything needs a chat. `headless.ts` runs playbooks through the **same adapter layer** as the chat, but in a bounded, non-interactive profile: read-only vault tools auto-allowed, every mutating tool auto-denied, a per-step idle timeout instead of interactive cards, and multi-step playbooks (`>>>`) running sequentially in one session. Same engine, same events — different permission posture.

## Design principles

1. **The engine is the product.** Exo adds surface (Obsidian-native UI, vault context, interactive cards), never a second brain. No prompt chains, no client-side agent logic duplicating what the CLI already does.
2. **Parity with the terminal.** If Claude Code can do it in a shell, Exo should not silently do less — and when it must (mobile, sandboxing), it says so.
3. **Errors are recoverable, context is sacred.** Processes are disposable; transcripts are not.
4. **Every provider is a guest.** The view depends on the `AgentSession` interface only; Claude and Codex are adapters, and the next engine is a pull request, not a rewrite.

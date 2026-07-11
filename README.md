<p align="center">
  <img src="assets/exo-logo.svg" width="96" height="96" alt="Exo logo" />
</p>

# Exo

An agentic AI assistant in your Obsidian sidebar, powered by the **Claude CLI** or the **Codex CLI**. Your vault is the agent's working directory. Custom-rendered, theme-aware chat UI — no terminal.

## Screenshots

<p align="center">
  <img src="assets/screenshot-empty.png" width="380" alt="Exo — new-chat empty state" />
</p>
<p align="center"><em>The new-chat empty state — the Exo mark, prompt suggestions, and related notes.</em></p>

<p align="center">
  <img src="assets/screenshot-chat.png" width="900" alt="Exo — a conversation with tool cards and the Context panel" />
</p>
<p align="center"><em>A conversation in a full-page pane: tool cards, the touched-files footer, and the live Context panel on the right.</em></p>

<p align="center">
  <img src="assets/screenshot-tune.png" width="380" alt="Exo — the tune dialog" />
</p>
<p align="center"><em>The tune dialog — model, effort, and permission in one place.</em></p>

## Features

- **Custom chat UI** — streaming markdown, message bubbles, theme-agnostic (built on Obsidian's native CSS variables; transparent panel that adapts to any theme).
- **Two backends, switchable** — Claude (via the Claude Agent SDK pointed at your installed CLI) and Codex (`codex exec --json`). Switch per conversation from the header.
- **Agentic** — the agent can Read / Write / Edit / Bash / Search with the vault as its working directory.
- **Permission gating** (Claude) — tool calls surface as cards; sensitive actions (Edit/Write/unlisted Bash) prompt with **Allow once / Always allow / Deny**, with a per-session allowlist and auto-allow for read-only tools. Codex is gated by its own sandbox (`workspace-write`).
- **Tool-call cards** — running / success / error, with diff preview for edits and command + output for shell.
- **Knowledge-work native** — answers stream with a live caret; assistant replies can be **inserted into the active note** or copied as markdown; tool cards link the **note they touched** (click to open it in the graph). The new-chat **empty state** centres the Exo mark with a soft breathing aura and gathers **Suggestions**, **Your prompts**, and related notes around it.
- **Unified composer** — one input box with the textarea and all controls inside. A single **`+`** opens a themed popover to attach a note, file, folder, or image; a **⚙ tune dialog** consolidates model, effort, and permission in one place, with an always-visible **permission dot** (green / amber / red) so the active mode is never a surprise. Typing while the agent streams **queues** the message by default (steer is a setting). The send button lives in the box. Colours follow the active theme — the provider brand colour only tints the identity mark.
- **Context panel** — in a wide full-page pane, a side panel summarizes the conversation: web sources searched, notes read, files created / edited, and skills used. It grows with its content and appears only when there's room (never in the sidebar).
- **Persistent sessions** — Claude conversations keep one warm SDK process across turns (streaming-input), so follow-ups skip cold start and context is retained. A footer shows live **context-window usage**.
- **Reasoning** — the model's thinking streams into a collapsible block.
- **Fast startup** — skips global hooks + MCP per turn for snappier responses (toggle in settings).
- **Resilient** — a clear setup card when the CLI isn't signed in; retry any turn.

### Obsidian-native (Claude; all toggleable in settings)

- **Native tools** — an in-process MCP server gives the agent graph- and metadata-aware tools alongside the standard ones: `search_vault`, `read_note`, `get_backlinks`, `get_neighborhood`, `list_notes`, `list_tags`, `get_active_context`, `create_note` (tag/frontmatter aware), `append_to_note`, `update_frontmatter`, `add_links`, `open_note`. `search_vault` uses the **Omnisearch** plugin's index (BM25 + fuzzy, attachments) when installed, and transparently falls back to a built-in scorer otherwise.
- **Vault memory** — boots each conversation with context from `_system/` (vault-context, preferences, active rules, recent sessions), and can write back via gated tools: `capture_decision`, `log_session`, `capture_learning` (tagged `created_by: exo`).
- **Touched-notes footer** — after each turn, a grouped footer shows what the agent **Edited** (with an ×N edit count, plus per-note hover **diff** and two-step **revert** on live turns) and what it **Read**. Replies are **wikilink-ified** by default (mentions of existing notes become clickable `[[links]]`); related notes surface in the empty state.
- **Composer power-ups** — `/` opens a palette of custom prompts + your vault's `.claude/` commands and skills; `@` mentions a file or folder to add it as context. **Settings are organized into tabs** (General / Chat / Agent & Permissions / Memory / Advanced), including a **default model per provider** that every new chat starts with, and **AI-generated chat titles** (a quick Haiku pass names the tab after the first exchange).
- **Context as document cards** — the active note and anything you attach (via `@` or "+ Note") appear as uniform cards above the composer: images preview as thumbnails, notes show a text preview, other files show an icon — each with a title, a *Current Document* / *Document* label, click-to-open and remove.
- **History** — conversations **persist to disk** (survive reload, with session resume). The history button opens a **card gallery** with per-conversation previews (title, snippet, provider, message count, date); click a card to reopen it. Copy any reply.

## Mobile

**Unsupported** — `isDesktopOnly: true` in `manifest.json`; `src/cli.ts` imports Node's `child_process`, `os`, `fs`, and `path` to spawn the local `claude`/`codex` CLI, which isn't available on mobile.

## Requirements

- Desktop Obsidian (uses Node child processes — `isDesktopOnly`).
- The `claude` and/or `codex` CLI installed and logged in. Paths auto-detect; override in settings if needed.
- Optional: the [Omnisearch](https://github.com/scambier/obsidian-omnisearch) plugin — if present, `search_vault` uses its index for better ranking.

## Privacy & Security

**Network use.** Exo itself makes no network requests and sends no telemetry — it collects no data and does not phone home to the plugin author or anyone else. What Exo *does* is spawn the **`claude`** and/or **`codex`** CLI that you already have installed and authenticated on your machine, as a local child process (this is why the plugin is desktop-only — see `isDesktopOnly` in `manifest.json`). Those CLIs are the ones that talk to the network: `claude` calls Anthropic's API, `codex` calls OpenAI's API, each using **your own existing CLI login / API key** — never a key or account belonging to Exo or its author.

**What leaves your machine, and to whom.** When you send a message, the prompt text plus whatever context Exo attaches (the active note, `@`-mentioned files/folders, tool results, and — if you enable the Obsidian-native layer — `_system/` memory content) is passed to the CLI process, which forwards it to Anthropic (Claude) or OpenAI (Codex) as part of your own authenticated session with them. That data goes only to the provider you're using, governed by your own account/agreement with them — **nothing is sent to, or visible to, the Exo author.**

**Your vault is the agent's working directory.** The CLI is launched with your vault as its working directory, so the agent can read, write, and edit files in your vault (and run shell commands) as directed by your prompts and its own reasoning.

**What gates what the agent can do:**
- **Claude backend** — Exo's permission system surfaces each tool call (Read/Write/Edit/Bash/etc.) as a card before it runs; sensitive actions (Edit, Write, unlisted Bash commands) require **Allow once / Always allow / Deny**, with a per-session allowlist and auto-allow limited to read-only tools. You control the permission mode (e.g. more/less restrictive) from the composer.
- **Codex backend** — gated by Codex's own sandbox (`workspace-write`); per-action approvals are not yet wired into Exo's UI, so Codex relies entirely on its CLI-level sandbox settings.

In short: Exo is a thin, local UI over CLIs you already trust and are already signed into — it adds no new network surface of its own, but it does give the agent read/write access to your vault, scoped by the permission/sandbox settings above.

## Install

**Via [BRAT](https://github.com/TfTHacker/obsidian42-brat)** (recommended for now):

1. Install the BRAT community plugin.
2. *Add beta plugin* → `mariomile/obsidian-exo`.
3. Enable **Exo** in Community Plugins, then open it from the ribbon or the command palette (*Exo: Open chat*).

**Manual:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/mariomile/obsidian-exo/releases/latest) into `<vault>/.obsidian/plugins/exo/`, then enable it.

## Develop

```bash
pnpm install
pnpm dev      # watch + auto-deploy (see .obsidian-plugin-dir)
pnpm build    # typecheck + production bundle
```

Create a `.obsidian-plugin-dir` file containing the absolute path to your vault's
`.obsidian/plugins/exo` folder to auto-deploy on each build.

## Architecture

- `src/main.ts` — plugin entry (view registration, ribbon, command, settings).
- `src/view.ts` — the chat `ItemView` (header, message list, tool/permission cards, composer, history, context chips).
- `src/providers/` — `ProviderAdapter` interface + `claude.ts` (Agent SDK) and `codex.ts` (CLI) adapters, normalized into a single `AgentEvent` stream.
- `src/cli.ts` — robust CLI path resolution (Obsidian doesn't inherit the shell PATH).
- `src/ui/tools.ts` — tool metadata + detail/diff rendering.

## Status

Implemented: text + reasoning streaming, agentic tools with permission gating (Claude), Codex backend with tool cards, theme-aware transparent UI, context chips + multi-note attach, persistent conversation history, parallel conversations with a message queue + stop, `/` and `@` palettes, effort + permission selectors, the **Capabilities** panel, and the full Obsidian-native layer (graph tools, `_system/` memory read/write, graph UI). Codex tool-event parsing is best-effort (the CLI event schema is version-sensitive); per-action Codex approvals (`codex proto`) are not yet wired — Codex relies on its sandbox. The Obsidian-native tools and memory writes are **Claude-only** (Codex has no in-process MCP equivalent).

## License

MIT

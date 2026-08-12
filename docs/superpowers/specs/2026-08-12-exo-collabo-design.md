# Exo Collabo — design

## Goal

Give Exo the ability to collaborate on documents between humans (who may not use Obsidian at all) and the agent, in real time, with a review-before-commit model — comments and suggestions that an owner explicitly accepts, never blind overwrites.

## Why fork proof-sdk

`EveryInc/proof-sdk` (MIT, 1080 stars, active) already ships the hard parts: a collaborative markdown editor (Milkdown/ProseMirror) with realtime CRDT sync (Yjs + Hocuspocus), a semantic provenance model (origin/basis/review per span), and an HTTP "agent bridge" contract (`AGENT_CONTRACT.md`) for creating documents and posting comment/suggestion/rewrite operations. Its own ADR shows the public repo is already separated from Every's hosted-product specifics (auth flows, branding, growth code) — the fork is close to a clean core already, not something to strip down first.

Rebuilding this from scratch on a different stack would mean re-solving realtime collaborative rich-text editing, CRDT merge, and a comment/suggestion review model — the genuinely hard engineering — for a worse v1. Forking buys that; the actual new work is the Exo-side integration.

## Architecture

Two separate deployables, connected only over HTTP:

1. **Exo Collabo** — the fork, deployed on Railway (not Vercel: Hocuspocus is a persistent WebSocket server, which Vercel's serverless model doesn't run). Express + Hocuspocus + SQLite on a Railway volume, plus proof-sdk's own Milkdown web client, served from the same service. This is where any human — with or without Obsidian — opens a `shareUrl` and edits/comments in realtime with presence.

2. **Exo integration** (inside `obsidian-exo`) — no Yjs/WebSocket client embedded in the plugin. The agent bridge is plain HTTP (create doc, read state, post ops, poll/ack events); Exo only ever needs an HTTP client, not a CRDT client. This keeps Obsidian's own editor (CodeMirror 6) completely untouched — Exo never tries to replace it with Milkdown.

## Components

- **Exo Collabo** (new repo, fork of proof-sdk) — minimally modified: `PROOF_SHARE_MARKDOWN_AUTH_MODE=api_key` so document creation isn't open to the internet, CORS/domain config, Railway env vars, SQLite volume mount. No rewrite of its editor, server, or provenance code.
- **`src/core/collab-bridge.ts`** (Exo, pure/testable) — HTTP client implementing the `AGENT_CONTRACT.md` flow: create document, read state, post ops (`comment.add`, `suggestion.add`, `suggestion.accept`, `suggestion.reject`, `rewrite.apply`), poll and ack events. Every mutation carries an `Idempotency-Key`.
- **`src/obsidian/` wiring** — two commands:
  - **"Condividi nota"** — push the current note's markdown to Exo Collabo, choosing the recipient's role (`viewer` / `commenter` / `editor`, proof-sdk's existing three roles — the choice is made per share, not a fixed default), get back a `shareUrl`, copy it. Stores `notePath → {slug, ownerSecret}` locally (plugin data, not in the vault) so re-sharing the same note reconnects instead of duplicating.
  - **"Importa da Exo Collabo"** — given a `shareUrl`/slug (whether or not it originated from Exo — a collaborator may have created it from scratch on Exo Collabo's own web app and just sent Mario the link), fetch the accepted/canonical state and write it into a new or existing vault note.
- **Agent tool** — the bridge's ops exposed as a tool in the existing toolkit (`core/tools.ts` / `capability-tools.ts`), active only when a shared session is open for the current note. The agent only ever proposes (`suggestion.add`/`comment.add`); it never writes directly into the shared doc.
- **Settings** — service URL + API key reuse the existing Connections pattern (`core/mcp-config.ts`), no new settings UI.

## Data flow

1. **Share** (from Exo): pick a role → Exo POSTs the note's markdown to `/documents` → get back `shareUrl` → send it.
2. **Create from scratch** (outside Exo): a collaborator creates a document directly on Exo Collabo's web app — no vault note involved at all.
3. Whoever holds the link works in the Milkdown web client per their role: `editor` writes directly; `commenter`/`viewer` can only propose via comments/suggestions.
4. The owner (`ownerSecret` holder — Mario) reviews and calls `suggestion.accept` or `suggestion.reject`. This is the only path from "proposed" to "canonical" content. The agent's proposals go through the same gate as any human's.
5. **Import into Obsidian**: from Exo, given any `shareUrl`/slug, pull the accepted/canonical state and create or update a vault note.
6. If the document originated from an Exo-shared note, "Import" updates that same note (via the stored `notePath → slug` mapping) instead of creating a duplicate.

## Error handling

- Exo Collabo unreachable → toast; the note stays editable normally. This is an additive, opt-in capability and must never block ordinary vault/note work.
- Invalid or lost `ownerSecret` (e.g., plugin data cleared) → the relevant command reports "you no longer have owner access; the document may still be live at `shareUrl`" rather than failing silently.
- A suggestion rejected by a human collaborator is expected behavior, not an error — the agent sees it on the next event poll and does not retry.
- Idempotency-Key on every mutation op so a network retry can't duplicate a comment or suggestion.

## Testing

- `collab-bridge.ts`: unit tests with mocked HTTP (create doc, post ops, poll/ack events), vitest — same convention as other `core/` modules.
- No live integration test against the deployed Exo Collabo instance in CI (external dependency). An optional smoke check (matching the existing `scripts/smoke.mjs` pattern) can ping a configured service URL when run locally.
- Exo Collabo keeps its own inherited test suite from proof-sdk (`doc-core`, server routes) — not Exo's responsibility to re-test.

## Out of scope (v1)

- No live presence/cursor view inside Obsidian itself — realtime collaborative editing happens in Exo Collabo's own web client; Obsidian only ever sees the accepted snapshot on explicit import/pull.
- No automatic/continuous sync between a vault note and its shared document — both "share" and "import" are explicit, user-triggered actions.
- No new settings UI beyond the existing Connections pattern.

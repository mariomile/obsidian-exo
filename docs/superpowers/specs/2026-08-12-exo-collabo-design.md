# Exo Collabo: design

## Goal

Give Exo the ability to collaborate on documents between humans (who may not use Obsidian at all) and the agent, in real time, with a review-before-commit model: comments and suggestions that an owner explicitly accepts, never blind overwrites.

## Why fork proof-sdk

`EveryInc/proof-sdk` (MIT, 1080 stars, active) already ships the hard parts: a collaborative markdown editor (Milkdown/ProseMirror) with realtime CRDT sync (Yjs + Hocuspocus), a semantic provenance model (origin/basis/review per span), and an HTTP "agent bridge" contract (`AGENT_CONTRACT.md`) for creating documents and posting comment/suggestion/rewrite operations. Its own ADR shows the public repo is already separated from Every's hosted-product specifics (auth flows, branding, growth code), so the fork starts from a clean core rather than something to strip down first.

Rebuilding this from scratch on a different stack would mean re-solving realtime collaborative rich-text editing, CRDT merge, and a comment/suggestion review model. That is the genuinely hard engineering, and the result would be a worse v1. Forking buys it; the actual new work is the Exo-side integration.

## Architecture

Two separate deployables, connected only over HTTP:

1. **Exo Collabo**: the fork, deployed on Railway. Not Vercel, because Hocuspocus is a persistent WebSocket server and Vercel's serverless model does not run one. Express + Hocuspocus + SQLite on a Railway volume, plus proof-sdk's own Milkdown web client served from the same service. This is where any human, with or without Obsidian, opens a share link and edits or comments in realtime with presence.

2. **Exo integration** (inside `obsidian-exo`): no Yjs or WebSocket client embedded in the plugin. The agent bridge is plain HTTP (create doc, read state, post ops, poll and ack events), so Exo only ever needs an HTTP client, not a CRDT client. Obsidian's own editor (CodeMirror 6) is untouched: Exo never tries to replace it with Milkdown.

## Components

- **Exo Collabo** (new repo, fork of proof-sdk), minimally modified: `PROOF_SHARE_MARKDOWN_AUTH_MODE=api_key` so document creation is not open to the internet, CORS and domain config, Railway env vars, SQLite on a mounted volume. No rewrite of its editor, server, or provenance code.
- **`src/core/collab-bridge.ts`** (pure, testable, Obsidian-free): HTTP client over an injected callable implementing the `AGENT_CONTRACT.md` flow: create document, read state, post ops, poll and ack events. Every mutation carries an `Idempotency-Key`.
- **`src/obsidian/collabo-commands.ts`**, three commands:
  - **Share this note**: push the current note's markdown, choosing the recipient's role (`viewer` / `commenter` / `editor`, proof-sdk's existing three roles, chosen per share rather than fixed), get back a link, copy it. Stores `notePath → {slug, ownerSecret, accessToken, role}` in plugin data (not in the vault) so re-sharing the same note reconnects instead of duplicating.
  - **Open as owner**: the share command copies the *recipient* link, which carries the recipient's role. Accepting a suggestion needs the owner credential, so opening the document as owner is its own entry.
  - **Import a document**: given a share link or a known slug, fetch the accepted state and write it into a new or existing vault note. Works for documents that never originated in Exo.
- **Agent tools** (`src/obsidian/collabo-tools.ts`): five `collabo_*` tools built on a bridge interface, following the `browser-tools.ts` pattern. The agent lists shares, reads a document, checks what humans did to its proposals, and proposes via comment or suggestion. It has no accept, reject, or rewrite tool.
- **Settings**: two plain fields (service URL, API key) in the Advanced tab, plus the share registry in plugin data. Not the Connections pane, which manages MCP servers and skills: Exo Collabo is neither.

## Data flow

1. **Share** (from Exo): pick a role, Exo POSTs the note's markdown to `/documents`, gets back a tokenised link, copies it, you send it.
2. **Create from scratch** (outside Exo): a collaborator creates a document directly on Exo Collabo's web app, with no vault note involved at all.
3. Whoever holds the link works in the Milkdown web client per their role: `editor` writes directly, `commenter` and `viewer` can only propose.
4. The owner reviews and accepts or rejects. This is the only path from "proposed" to "canonical" content, and the agent's proposals go through the same gate as any human's.
5. **Import into Obsidian**: given any share link or known slug, pull the accepted state and create or update a vault note. Pending suggestions are not part of that state, so the vault only ever receives approved text.
6. If the document originated from an Exo-shared note, import updates that same note via the stored mapping instead of creating a duplicate. Documents new to the vault land in `_inbox/`.

## Error handling

- Exo Collabo unreachable: toast, and the note stays editable normally. This is an additive, opt-in capability that must never block ordinary vault work.
- No service configured: the commands hide themselves and the tools are not registered, so the session tool list is byte-identical to before the feature existed.
- A slug the vault has no credential for is refused rather than opened, so import cannot write an empty note.
- A suggestion rejected by a human is expected behavior, not an error. The agent sees it once on the next event poll and does not retry.
- `Idempotency-Key` on every mutation so a network retry cannot duplicate a comment or suggestion.

## Testing

- `collab-bridge.ts`: unit tests with a recorded HTTP fake (create, state, ops, events, ack, link parsing), vitest, the same convention as other `core/` modules.
- `collabo-tools.ts`: unit tests with a fake bridge, mirroring `browser-tools.test.ts`, including an assertion that no accept, reject, or rewrite tool exists.
- Command logic (`shareNote`, `resolveImport`, `importDocument`, `docUrl`) tested without an Obsidian app by injecting dependencies.
- No live integration test against the deployed service in CI (external dependency). Each task carries a manual verification step against the real deployment instead.
- Exo Collabo keeps its own inherited test suite from proof-sdk, which is not Exo's responsibility to re-run.

## Constraints discovered during planning

- `src/main.ts` and `src/settings.ts` both sit exactly on their size-contract ceilings, and `src/view.ts` has 2 lines of headroom. The implementation frees budget by extraction and lowers the ceilings; it never raises one, and it does not touch `view.ts` at all.
- Because the Collabo bridge is stateless (unlike the agent browser, which owns a per-conversation lease), the tools resolve it from the app rather than having it curried in `view.ts`.

## Out of scope (v1)

- No live presence or cursor view inside Obsidian. Realtime editing happens in Exo Collabo's web client; Obsidian sees accepted snapshots on explicit import.
- No automatic or continuous sync between a vault note and its shared document. Share and import are both explicit, user-triggered actions.
- No agent-side accept, reject, or rewrite. An agent that could accept its own suggestion would make the review gate decorative.

# Chat + Cosmos Alignment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to work this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking; tick them in the same commit as the code they cover.

**Source:** `docs/ideation/2026-08-11-chat-cosmos-alignment-ideation.md` — all seven survivors, none dropped. This plan sequences them; it does not re-litigate them.

**Goal:** improve the design and UX of the Exo chat (sidebar chat list + conversation view) and align it with the Cosmos theme, while keeping Exo theme-agnostic by construction.

**Order rationale:** the token seam (Phase 1) makes every later visual move cheaper, so the CSS layer lands first (Phases 1–3), then the sidebar (Phases 4–5), then the conversation and the vault seam (Phases 6–7).

**Non-negotiables carried from `docs/design.md` and settled history:**
- The six laws hold. No gradients, no glassmorphism, no native selects, no hard-coded colors outside the two provider brand accents.
- The streaming invariant holds: while streaming, exactly one of {working row, open card, caret} is visible.
- Do not reintroduce permission alarm fatigue — the chip redesign already cured it.
- Geometry/timing tokens live on `:root`, not `.mva-root` (the modal token gotcha).
- `pnpm lint && pnpm test && pnpm build` must pass at the end of every phase.

---

## Phase 1 — The Cosmos Bridge: one token seam instead of 39 scattered fallbacks

A single seam block near the top of `styles.css` resolves every Exo token through the Cosmos chain once (`--mva-x: var(--mv-x, var(--cosmos-x, <obsidian fallback>))`); component rules consume only `--mva-*`. Inside the seam: a 4-step surface ladder (`--mva-surface-0..3`, `color-mix` from Obsidian vars, aliased to Cosmos's luminosity ladder when active), an elevation pair (`--mva-shadow-rest/lift` aliased to `--mv-card-rest/lift`), concentric radii built with the calc formula instead of three independent numbers, and one shared heartbeat duration replacing the nine unrelated pulse rhythms currently in the file (1.1s/1.2s/1.4s/1.6s/2s/2.6s/4.5s plus spins). Then rewire the existing scattered `var(--mv-*, literal)` / `var(--cosmos-*, literal)` call sites to read the seam. Extend `src/style-contract.test.ts` first so the new rules are enforced, and port Cosmos's design-contract ratchet so hex/`!important` counts can only go down.

- [x] A seam block exists near the top of `styles.css` where every Exo token resolves through the Cosmos chain (`--mv-*` → `--cosmos-*` → Obsidian fallback) exactly once
- [x] `--mva-surface-0..3` exist as a 4-step ladder built with `color-mix` from Obsidian vars, aliased to Cosmos's luminosity ladder when Cosmos is active
- [x] `--mva-shadow-rest` / `--mva-shadow-lift` exist and alias `--mv-card-rest` / `--mv-card-lift`
- [x] `--mva-r1/r2/r3` are concentric by construction: inner radius is a `calc()` of the outer radius minus the inset, never three independent numbers
- [x] One heartbeat duration token replaces the nine unrelated pulse rhythms; no rule declares its own pulse duration
- [x] No component rule outside the seam block reads `--mv-*` or `--cosmos-*` directly; they consume `--mva-*` only
- [x] `src/style-contract.test.ts` gains assertions for the above and fails against the pre-seam stylesheet
- [x] A design-contract ratchet script (ported from Cosmos `contract.sh`) records the current hex / `!important` counts and fails the build if either grows
- [x] `pnpm lint && pnpm test && pnpm build` pass
- [x] Exo still renders correctly under a non-Cosmos theme (default Obsidian dark and light): no missing background, no collapsed radius, no invisible text

## Phase 2 — Typography registers as tokens, and settle the six bubble proposals

Encode `docs/design.md`'s three type registers (eyebrow / title / body) as `--mva-type-*` tokens plus one class per register, then migrate the chat surfaces onto them. Use that lever to decide the six open `.mva-bubble` proposals from `docs/2026-07-mv-kit-audit.md` in one sitting: chat prose 14px vs native 16px, paragraph gap 0.5em vs 1rem, heading ramp, composer line-height 1.45 vs bubble 1.55, dead selectors, chip line-height. Each of the six gets a recorded decision in the audit note, not a silent merge.

- [x] `--mva-type-*` tokens exist for the three registers (eyebrow, title, body), including size, weight and letter-spacing per register
- [x] One class per register exists and the chat surfaces (bubble, composer, sidebar rows, step headers) use them instead of ad-hoc font declarations
- [x] Eyebrow register is never applied to a form-field label (design.md §3 rule)
- [x] All six `.mva-bubble` proposals from `docs/2026-07-mv-kit-audit.md` are resolved: chat prose size, paragraph gap, heading ramp, composer vs bubble line-height, dead selectors removed, chip line-height
- [x] Each of the six decisions is recorded with its verdict in `docs/2026-07-mv-kit-audit.md`
- [x] `docs/design.md` §3 reflects the tokenized registers
- [x] `pnpm lint && pnpm test && pnpm build` pass

## Phase 3 — One identity moment: the run is where Exo glows

Designate exactly one state as the cosmic identity carrier: a running turn. A restrained luminous treatment on the working row and the caret — soft accent-mixed glow via `color-mix` on `--interactive-accent`, synchronized to the single heartbeat duration from Phase 1, zeroed under `prefers-reduced-motion`. Everything else stays monochrome-quiet. Pair it with an accent audit: define `--mva-accent`, reserve it for genuine decision points (primary action, active ring, pending approval), and demote provider brand colors to identity dots only.

- [x] Only the running state carries the glow: the working row and the caret, nothing else
- [x] The glow is built with `color-mix` on `--interactive-accent`, never a hard-coded color and never a gradient
- [x] The glow animates on the single heartbeat duration from Phase 1 and collapses to nothing under `@media (prefers-reduced-motion: reduce)`
- [x] `--mva-accent` is defined and used only at genuine decision points: primary action, active ring, pending approval
- [x] Provider brand colors (`#d97757`, `#19c37d`) appear only as identity dots
- [x] The streaming invariant still holds: exactly one of {working row, open card, caret} is visible while streaming
- [x] `pnpm lint && pnpm test && pnpm build` pass

## Phase 4 — Live rows: running rows say what they're doing

`chat-list-view.ts`'s `statusText()` returns the constant `"Working"` for every running row, while `view.ts` already computes a live human phrase for the current tool and feeds it only to the wide-mode Recap Rail. Pipe that phrase through the chat-row source into the running row's preview line ("Searching the vault for…"), updated per tool call and never per token. Truncate with the existing fade-mask so a long phrase does not blow up the row.

- [x] The running tool's human phrase reaches the sidebar row through the chat-row source, not through a new global
- [x] A running row shows the live phrase instead of the constant "Working"; a running row with no phrase yet still shows a sensible status
- [x] The phrase updates per tool call, never per token
- [x] Long phrases truncate with the existing fade-mask treatment, without reflowing the row
- [x] `reconcileList` signature discipline holds: a tick with no phrase change touches no DOM
- [x] Tests cover the phrase reaching the row and the no-change tick
- [x] `pnpm lint && pnpm test && pnpm build` pass

## Phase 5 — Mission deck: the sidebar becomes the supervision instrument

Three moves on `chat-list-view.ts`. (a) A needs-you strip pinned above search: quiet chips, one per blocked chat, present only when non-empty, immune to section collapse. (b) Inline Allow/Deny on needs-permission rows, showing the one-line rule the approval would grant, so approvals clear without opening the transcript. (c) An idle-worker key: one command cycles to the next chat needing input, RTS-style. Attention hierarchy rendered dark-cockpit style — rows needing you at full luminosity, healthy and settled rows dimmer — using only the existing text-color ladder. This deliberately redraws the pane's reader/owner boundary: the sidebar starts mutating conversations, so the mutation goes through explicit plugin wrappers, never direct view reach-in, and the header comment is updated to say so.

- [x] A needs-you strip renders above search, one quiet chip per blocked chat, absent entirely when nothing is blocked
- [x] The strip is immune to section collapse: collapsing a section never hides a blocked chat from it
- [x] Needs-permission rows expose inline Allow / Deny, and each shows the one-line rule the approval would grant
- [x] Allow / Deny mutate only through plugin wrappers (`convo-bridge` / `main`), never by reaching into `ChatView` directly
- [x] A command cycles focus to the next chat needing input and wraps around
- [x] Attention hierarchy uses only the existing text-color ladder: rows needing you at full luminosity, healthy and settled rows dimmer
- [x] No new always-on alert surface: the strip is quiet at rest and does not reintroduce alarm fatigue
- [x] `chat-list-view.ts`'s header comment is updated to describe the new reader/owner boundary
- [x] Tests cover the strip contents, collapse immunity, the inline decision path, and the cycle command
- [x] `pnpm lint && pnpm test && pnpm build` pass

## Phase 6 — The re-entry system: returning to a chat is a designed moment

Three coordinated changes, all on data that already exists unrendered. (a) A fixed-slot "since you left" line at the last-read position when revealing a chat that worked without you: "since you left · 12 steps · 3 files changed · 1 question waiting", eyebrow register, slots clickable, dissolving once read. (b) Turn-end auto-fold: a settled turn compresses its whole work section to a single milestone line ("Edited 3 files, ran 2 commands · 41s") above the answer, expanding in one click. (c) State-contextual resume verbs above the empty composer (Resume, Course-correct, Approve) as the fast path for re-engagement. `steps.ts` `summarizeSteps` already computes the per-run stats, the sidebar already tracks `unseen`, and `steps.ts` `close()` already builds the folded header. This phase introduces a per-conversation read position, which is new persisted state.

- [x] A per-conversation read position is persisted and updated when the user reads a conversation
- [x] Revealing a chat that worked without you renders a fixed-slot "since you left" line at the last-read position, in the eyebrow register
- [x] The line's slots are fixed by position (steps, files changed, questions waiting) and each populated slot is clickable to its target
- [x] The line dissolves once read and does not return for the same position
- [x] A settled turn folds its work section to a single milestone line above the answer by default, expandable in one click
- [x] Resume verbs (Resume, Course-correct, Approve) appear above the empty composer and are contextual to the conversation state
- [x] The "since you left" band and the fold both respect the streaming invariant: neither renders a second live surface during a stream
- [x] Sidebar users get the re-entry line regardless of pane width (it is not gated to >900px like the Recap Rail)
- [x] Tests cover the read-position lifecycle, the slot contents, and the turn-end fold default
- [x] `pnpm lint && pnpm test && pnpm build` pass

## Phase 7 — Settle to Note: settled chats join the vault graph

A "Settle to note" action mirrors a settled conversation into a vault note with frontmatter (agent, provider, outcome, files touched) and a distilled body — not a raw transcript dump. Settled chats gain backlinks, graph presence, and vault search; the Settled group becomes a doorway into the vault instead of a dead archive. Live chats stay in the hand-rolled DOM: streaming and the invariant cannot render in markdown, so this action is available only on settled conversations.

- [x] A "Settle to note" action exists on settled conversations and is unavailable on running or blocked ones
- [x] The action is manual, not automatic
- [x] The written note carries frontmatter with agent, provider, outcome and files touched
- [x] The body is a distilled summary, not a raw transcript dump
- [x] The target folder is a single documented choice, resolved through the existing vault/memory-root path helpers rather than a hard-coded path
- [x] Re-settling the same conversation updates its existing note instead of creating a duplicate
- [x] The note is a real vault file: it appears in search, backlinks and the graph
- [x] Tests cover the frontmatter schema, the distillation, the settled-only gate, and the re-settle update path
- [x] `pnpm lint && pnpm test && pnpm build` pass

---

## Run log

### 2026-08-11 — all seven survivors, three briefs, one branch (`main`)

**Task.** Implement all 7 survivors from `docs/ideation/2026-08-11-chat-cosmos-alignment-ideation.md`: Cosmos Bridge token seam, typography registers, running-state identity glow, live running rows, mission-deck sidebar, the re-entry system, Settle to Note. Nothing was dropped or deferred.

**Sections that landed on HEAD.** All seven. Every checkbox above was verified against the working tree at `2673e1b`, not against the executor's report:

| Phase | Evidence on HEAD | Commits |
| --- | --- | --- |
| 1. Cosmos Bridge | `COSMOS BRIDGE START` seam on `body` in `styles.css`; `--mva-surface-0..3` (ends aliased, rungs 1/2 built with `color-mix`); `--mva-shadow-rest/lift`; `--mva-r3 → r2 → r1` by `calc()`; single `--mva-heartbeat: 1.6s`; `scripts/contract.sh` ratchet wired into `pnpm build`; `src/style-contract.test.ts` "Cosmos bridge: Phase 1 token seam" block | `4a92477`, `d1105fc`, `a9559b2`, `42caf30` |
| 2. Type registers | `--mva-type-eyebrow/title/body-*` tokens in the seam; `.mva-type-eyebrow` / `.mva-type-title` / `.mva-type-body` classes; `docs/design.md` §3 "The registers as tokens (Exo, 2026-08-11)" table; six bubble proposals resolved with verdicts in `docs/2026-07-mv-kit-audit.md` | `4a92477`, `d1105fc` |
| 3. Identity glow | `--mva-accent` defined and spent at decision points only; glow is `color-mix` on the accent, beats on `--mva-heartbeat`, dies under `prefers-reduced-motion`; zero provider brand hexes left in `styles.css`; four Phase 3 contract tests | `42caf30`, `a9559b2` |
| 4. Live rows | live tool phrase carried on the chat-row source (`convo-types.ts`), consumed by `chat-list-view.ts` instead of the constant "Working"; sampled per tick, never per token; fade-mask truncation | `6b516a3` |
| 5. Mission deck | needs-you strip pinned above search, outside `listHost` so section collapse cannot hide it; inline Allow / Deny carrying `permRuleLine`; "Go to the next chat that needs you" command; attention hierarchy on the existing text ladder; header comment rewritten for the new reader/owner boundary | `6b516a3`, `ec22650` |
| 6. Re-entry | `readIndex` persisted through `view.ts` save/load; `src/core/reentry.ts` + `src/ui/reentry.ts`; band anchored by `data-msg`, not by DOM position; settled runs fold to `milestoneLine`; resume verbs above the empty composer; not width-gated | `9326143`, `78cf6d7`, `2673e1b` |
| 7. Settle to Note | `canSettle` gate (settled only, manual only); `src/core/settle-note.ts` distillation + frontmatter; `src/obsidian/settle-note.ts` writing through the Vault API so the note is indexed; folder resolved through `exoPaths.chats`; re-settle finds its own note by frontmatter stamp, not filename | `9326143` |

**Verification at reconcile time.** `pnpm lint` 0 errors / 8 pre-existing warnings; `pnpm test` 2531 tests, 156 files, 0 failures; `pnpm build` green with `design contract OK (styles.css: hex 49/49, !important 6/6)`.

**What did not land.** Nothing. No brief was abandoned and no section was cut.

**Open items carried out of the run.**

- **Phase 6 + 7 exited review UNRESOLVED.** The brief went three review rounds; rounds 2 and 3 produced `78cf6d7` (the read position was not advancing when work arrived in front of the user) and `2673e1b` (the band was anchored positionally and landed on the wrong turn after a stopped-before-first-token turn, plus it did not repaint when the pane came back). The third round closed on the round cap without a recorded approval. Every acceptance criterion above is present and covered by tests, but the phase never got a clean reviewer sign-off. Worth one fresh pass on `src/ui/reentry.ts` before the next release.
- **Out-of-scope work in the plan's own file.** `be29095` ("style(browser): lay out the agent browser leaf so the webview fills the pane") added 43 lines to `styles.css` at 22:29, between this plan's Phase 6 commits. It belongs to the concurrent scoped-browser plan, not to this one. It passes the new seam contract, so nothing is broken, but the Cosmos Bridge now has a tenant that was never reviewed against it.
- **Ratchet slack is zero.** `design-contract.json` sits at exactly the current counts (hex 49, `!important` 6). The next commit that adds either fails the build, which is the point, but nobody has taken a pass at lowering them yet.

---
date: 2026-08-11
topic: chat-cosmos-alignment
focus: improve design/UX of the Exo chat (sidebar chat list + conversation view) and align it with the Cosmos theme and Mario's style
mode: repo-grounded
---

# Ideation: Exo Chat Design + Cosmos Alignment

## Grounding Context

**Codebase context.** Exo is a TypeScript Obsidian plugin with hand-rolled DOM and a single 6620-line `styles.css` (~165 border-radius declarations, 49 raw hex). Chat UI lives in `src/view.ts` (conversation), `src/ui/chat-list-view.ts` (sidebar with Running/Open/Settled groups, the least-iterated surface), `composer.ts`, `steps.ts` (thinking/tool timeline), agent tabs, `gallery-view.ts`. The suite rulebook is `docs/design.md` (six laws: theme vars for color, quiet surfaces, color-mix, reduced-motion, per-surface `--mva-*` namespace; three typography registers; anti-patterns: gradients/glassmorphism, native selects).

**Cosmos theme.** `cosmos-tokens.css` is the layer-zero token file: depth by luminosity (surface-0..3 derived from one seed via color-mix), concentric radii by construction (inner = outer minus inset, always calc), tuned two-layer card shadows (`--mv-card-rest/lift`, per-palette so elevation never inverts), monochrome interactive ("no blue buttons"), fade-mask truncation, 36px control height, three motion durations, palette flavors via scoped token override, and a build-time design-contract ratchet.

**The gap.** Exo is theme-agnostic by principle (788 Obsidian var reads) with thin Cosmos adoption: 27 `--mv-*` hits and 12 `--cosmos-*` hits, nearly all with hardcoded literal fallbacks; Exo's own radius scale (`--mva-r1/r2/r3` 6/9/13px) was never reconciled with Cosmos; card/hover surfaces read raw Obsidian tokens, so Exo inherits none of Cosmos's depth-by-luminosity.

**Settled history (not re-litigated).** Glass/blur rejected by Mario. Tool cards minimized ("content is the protagonist"). Streaming invariant: while streaming, exactly one of {working row, open card, caret} is visible. Permission alarm fatigue already fixed. Six typography proposals on `.mva-bubble` still open (from `docs/2026-07-mv-kit-audit.md`).

**External context.** Claude Code (collapsed thinking by default), Devin (3-panel session sidebar), the "Slow AI" pattern language (Run Contract Card, Conceptual Breadcrumbs, Resumption Summary, Course Correction), mission-control dashboards (Approvals Queue, Runs Ledger), RTS control groups and the idle-worker key, and the Linear/Raycast/Warp school: near-black canvas, 4-step surface ladder, one disciplined accent. Literal starfields read as kitsch; tasteful cosmic is restrained glow on near-black.

**Past learnings.** `docs/design.md` is the canonical brief; the modal `:root` token gotcha, the caret-insertion fix, and the Claudian bottom-inset regression are the documented traps to avoid.

## Ranked Ideas

### 1. The Cosmos Bridge: one token seam instead of 39 scattered fallbacks
**Description:** A single block at the top of `styles.css` resolves every Exo token through the Cosmos chain once (`--mva-x: var(--mv-x, var(--cosmos-x, <obsidian fallback>))`); component rules consume only `--mva-*`. Inside the seam: a 4-step surface ladder (`--mva-surface-0..3`, color-mix from Obsidian vars, aliased to Cosmos's luminosity ladder when active), an elevation pair (`--mva-shadow-rest/lift` aliased to `--mv-card-rest/lift`), concentric radii via the calc formula instead of three independent numbers, and one shared heartbeat duration replacing the nine unrelated pulse rhythms currently in the file (1.1s/1.2s/1.4s/1.6s/2s/2.6s/4.5s plus spins). Optionally port Cosmos's design-contract ratchet (`contract.sh`) so hex/!important counts can only go down.
**Warrant:** `direct:` styles.css already does this ad hoc: line 1195 `box-shadow: var(--cosmos-pop-shadow, var(--shadow-s))`, line 42 `--mva-card-radius: var(--mv-r-card, var(--mva-r2))`; grep shows 27 `--mv-*` hits all with literal fallbacks, and 9 distinct animation rhythms. cosmos-tokens.css states the radii rule: "concentrici by-construction... mai due numeri indipendenti."
**Rationale:** This is the structural answer to "align Exo with Cosmos": after the seam, every future Cosmos improvement (palette, shadow tuning, motion) lands in Exo by editing one block, while Exo stays theme-agnostic by construction. Under generic themes Exo gains a coherent depth system it currently lacks; under Cosmos it aligns exactly.
**Downsides:** A mostly-mechanical but wide refactor of a 6620-line stylesheet; visual regressions possible on non-Cosmos themes; the ratchet adds build friction.
**Confidence:** 90%
**Complexity:** Medium (CSS-only; one seam block + mechanical rewiring; optional script port)
**Status:** Unexplored

### 2. Mission deck: the sidebar becomes the supervision instrument
**Description:** Three moves on `chat-list-view.ts`. (a) A needs-you strip pinned above search: quiet chips, one per blocked chat, present only when non-empty, immune to section collapse. (b) Inline Allow/Deny on needs-permission rows (with the one-line rule it would grant), so approvals clear without opening the transcript. (c) An idle-worker key: one hotkey cycles to the next chat needing input, RTS-style. Attention hierarchy rendered dark-cockpit style: rows needing you at full luminosity, healthy/settled rows dimmer, using only the existing text-color ladder.
**Warrant:** `direct:` chat-list-view.ts renders `Needs permission` as a passive label and its header comment declares the pane "a READER, not an owner"; a collapsed section hides a blocked chat behind a numeric count. `external:` mission-control Approvals Queue ("one screen, one tap"), StarCraft's idle-worker key, Airbus dark-cockpit philosophy (lit = action required, dark = nominal).
**Rationale:** The most expensive failure in an agent UI is a human-blocked run the human doesn't notice; today that signal is a per-row dot that collapse and scroll can fully suppress, and every approval costs a context switch. The sidebar already knows which chats are blocked and why.
**Downsides:** Redraws the sidebar's reader/owner boundary (it starts mutating conversations); aggregation must not reintroduce the alarm fatigue the permission-chip redesign just cured.
**Confidence:** 80%
**Complexity:** Medium (sidebar contract change + one command + CSS)
**Status:** Unexplored

### 3. The re-entry system: returning to a chat is a designed moment
**Description:** Three coordinated changes. (a) A fixed-slot "since you left" line at the last-read position when revealing a chat that worked without you: "since you left · 12 steps · 3 files changed · 1 question waiting", eyebrow register, slots clickable, dissolves once read. (b) Turn-end auto-fold: a settled turn compresses its whole work section to a single milestone line ("Edited 3 files, ran 2 commands · 41s") above the answer; expanding stays one click. (c) State-contextual resume verbs above the empty composer (Resume, Course-correct, Approve) as the fast path for re-engagement.
**Warrant:** `direct:` steps.ts `summarizeSteps` already computes the per-run stats and the sidebar already tracks `unseen`; the Recap Rail is gated to >900px so sidebar users get none of it; steps.ts `close()` already builds the folded header. `external:` "Slow AI" Resumption Summary and Conceptual Breadcrumbs; SBAR fixed-slot handoffs (position carries meaning, prose does not). Five of six ideation frames converged on this independently, the strongest signal in the run.
**Rationale:** Multi-agent work means most sessions are re-entries, not fresh starts; today the design optimizes watching live and punishes coming back, and the data needed for the fix already exists unrendered.
**Downsides:** Introduces a per-conversation read-position concept; the milestone-line default is a trust call about summaries as the permanent record; must respect the streaming invariant.
**Confidence:** 85%
**Complexity:** Medium (data exists; new band + fold default + chips)
**Status:** Unexplored

### 4. One identity moment: the run is where Exo glows
**Description:** Designate exactly one state as the cosmic identity carrier: a running turn. A restrained luminous treatment (soft accent-mixed glow on the working row/caret via color-mix on `--interactive-accent`, zeroed under reduced-motion), synchronized to the single heartbeat duration from idea 1. Everything else stays monochrome-quiet. Pair it with an accent audit: define `--mva-accent`, reserve it for genuine decision points (primary action, active ring, pending approval), demote provider brand colors to identity dots only.
**Warrant:** `direct:` design.md law 2: interactive state is "the only time a surface tints"; running is a state, so the tint lives inside the law. `external:` the tasteful-cosmic bar from Linear (#08090a, one lavender accent) and Warp (dark void, one ember accent); production starfields read as kitsch everywhere they were found.
**Rationale:** Exo currently has discipline but no signature; Obsidian AI competitors are visually generic. Anchoring identity to the one state users actually watch gives recognition without violating a single law, and answers "il nostro stile" without decoration.
**Downsides:** A pure taste call only Mario can arbitrate; the quiet-surfaces line must be ruled on explicitly; risk of alarm-creep if the glow leaks to other states.
**Confidence:** 70%
**Complexity:** Low-Medium (CSS + one ruling)
**Status:** Unexplored

### 5. Live rows: running rows say what they're doing
**Description:** The sidebar's running row shows the static word "Working"; view.ts already computes a live human phrase for the current tool (fed today only to the wide-mode Recap Rail). Pipe that phrase into the running row's preview line ("Searching the vault for..."), updated per tool call, never per token. Extensions for later: a committed next-contact hint ("next: test results") and a tiny cadence strip that makes a stalled agent legible as a fading trail.
**Warrant:** `direct:` recap.ts documents that view.ts passes the running tool as a human phrase; chat-list-view.ts `statusText()` returns the constant "Working". The data exists and is discarded exactly where users stare during long runs.
**Rationale:** A static "Working" for 90 seconds is indistinguishable from a hang; this is the highest ratio of supervision value to implementation cost in the whole run.
**Downsides:** Row text now updates during runs (reconciler signature discipline must hold); phrases must stay short or truncation eats them.
**Confidence:** 90%
**Complexity:** Low (the phrase already exists; plumbing + truncation)
**Status:** Unexplored

### 6. Settle to Note: settled chats join the vault graph
**Description:** A "Settle to note" action mirrors a settled conversation into a vault note with frontmatter (agent, provider, outcome, files touched) and a distilled body. Settled chats gain backlinks, graph presence, and vault search; the Settled group becomes a doorway into the vault instead of a dead archive. Live chats stay in the hand-rolled DOM (streaming and the invariant cannot render in markdown).
**Warrant:** `reasoned:` the full "chats are markdown files" flip fails on streaming, but Settled conversations are by definition frozen, which is exactly what a note is; Exo's identity is an agent inside a knowledge vault, and conversations that produced decisions are currently invisible to the rest of that vault, breaking Obsidian's core promise of linkability.
**Rationale:** This is the most Exo-specific idea in the set: no competitor benefits from it because no competitor lives inside a vault. It converts chat history from app state into compounding knowledge.
**Downsides:** Schema and location decisions (folder, frontmatter, auto vs manual); duplication between gallery history and notes; needs a distillation step to avoid dumping raw transcripts.
**Confidence:** 75%
**Complexity:** Medium (export path + schema + one action; no UI rework)
**Status:** Unexplored

### 7. Typography registers as tokens, and settle the six bubble proposals
**Description:** Encode design.md's three type registers (eyebrow/title/body) as `--mva-type-*` tokens plus one class per register, migrate the chat surfaces, and use that lever to decide the six open `.mva-bubble` proposals in one sitting (chat prose 14px vs native 16px, paragraph gap 0.5em vs 1rem, heading ramp, composer line-height 1.45 vs bubble 1.55, dead selectors, chip line-height).
**Warrant:** `direct:` design.md: "Getting the register wrong is the single most common mistake... There are exactly three." The mv-kit audit lists all six proposals as analyzed and waiting on Mario's call.
**Rationale:** Reading is the core activity of a chat; the audit already did the tradeoff analysis, so this converts pre-vetted decisions into one-line token experiments and makes the suite's top failure mode structurally impossible.
**Downsides:** The 14px-to-16px question cascades into the heading ramp and bubble width; visible rhythm changes need Mario's eye, not just a merge.
**Confidence:** 85%
**Complexity:** Low-Medium (token layer + migration + six decisions)
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Focus takeover (promote chat to center pane, Devin-style) | Two live renderings of one conversation is a sync trap; big architectural fork for unproven need |
| 2 | Sidebar mode drops the tab strip | Real simplification but forks layout by mount context; decide after the mission-deck sidebar proves itself |
| 3 | Contract card before the first token | Touches the streaming invariant's first paint; anxiety cost of a pre-stream artifact unproven |
| 4 | Refusals become queued intents | Queued model-switch touches provider session lifecycle; value narrower than cost |
| 5 | Auto-retitle + in-row shimmer | Near-survivor; genuinely good but a small standalone quick win, not a direction. Worth doing regardless |
| 6 | Staged search (lexical instant, semantic band) | Solid fix, narrow surface; fold into a later sidebar pass |
| 7 | Flight-strip drag reorder in Running group | Fights the model-driven grouping the list is built on; cycle key covers the need cheaper |
| 8 | Preparatory beat (pre-announce permissions) | Needs model cooperation; a cue that fails to materialize erodes trust |
| 9 | Departure-board transition pulse | Alarm-creep risk against the fatigue fix; its "change is the only motion" principle folded into idea 2 |
| 10 | Streaming invariant as DOM contract; docs/solutions ledger | Good engineering hygiene, below the design ambition floor of this session |
| 11 | Tab-overflow state inheritance; delete-with-undo; open-exo dead end; auto-collapse history; control groups; fan-out children strip; 200px compact rows; status spine; telemetry sparkline; EFC hint | Real but subordinate: each folds into survivors 2, 3, or 5 as a component or extension, or waits behind them |

## Next Step

Pick one survivor and brainstorm it into requirements (`ce-brainstorm`), then plan. Natural first pick: idea 1 (the bridge makes every later visual move cheaper) or idea 3 (biggest daily UX delta).

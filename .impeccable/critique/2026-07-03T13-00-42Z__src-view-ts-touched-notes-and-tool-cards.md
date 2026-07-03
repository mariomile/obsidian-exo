---
target: note-visualization surface (tool-call rows + touched-notes footer)
total_score: 21
p0_count: 0
p1_count: 2
timestamp: 2026-07-03T13-00-42Z
slug: src-view-ts-touched-notes-and-tool-cards
---
Method: dual-agent (A: saas-ux-designer · B: general-purpose detector-scan)

Note on visual evidence: Exo runs inside Obsidian's Electron shell, not a browser-servable page — no dev-server URL exists for standard live-server/injection browser automation. Assessment A used the real screenshot Mario shared of his own production chat history as visual evidence instead of a fresh browser capture; no overlay/injection was attempted or claimed.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|:---:|------|
| 1 | Visibility of System Status | 3 | Pulsing dot → green/red on completion is clear and quiet. |
| 2 | Match Between System and Real World | 3 | "Read note"/"Edited" language is natural; labels are plain. |
| 3 | User Control and Freedom | 2 | Revert exists but only for writes, only on hover — real control, low discoverability. |
| 4 | Consistency and Standards | 1 | Same touched note rendered two ways (row + chip) with mismatched verbs ("Append" vs `EDITED`). |
| 5 | Error Prevention | 3 | Two-step arm→confirm revert genuinely prevents accidental destructive action. |
| 6 | Recognition Rather Than Recall | 2 | Filenames are visible, but redundancy forces cross-referencing instead of recognition. |
| 7 | Flexibility and Efficiency of Use | 1 | Power-user multi-file turns balloon vertically; no coalescing. |
| 8 | Aesthetic and Minimalist Design | 1 | Three stacked metadata bands, one payload duplicated — the core failure. |
| 9 | Error Recovery | 3 | Diff + two-step revert on write chips is a strong, correctly-gated recovery path. |
| 10 | Help and Documentation | 2 | aria-labels exist (hardening pass) but no in-surface hint that revert/diff/attach exist. |
| **Total** | | **21/40** | **Functional but cluttered — real, fixable issues, not catastrophic** |

## Anti-Patterns Verdict

**LLM assessment:** Not chatbot-slop (no avatars, no gradient sparkle, no "AI thinking" theater — the pulsing brand-color dot is a restrained status signal). It leans toward the *other* rejected register instead: dense dev-tool chrome. Rendering one full-width labeled row per file operation ("Append", "Rename note", "Read note", "Edit note", stacked) is the VSCode/Cursor "operations log" pattern PRODUCT.md explicitly rejects — a turn touching 6 files produces 6 stacked chrome rows before a word of content appears. The deeper tell isn't any single element: it's that the surface **shows the same work twice** — "Append Lexroom.md" (live row) and "Lexroom" (end-of-turn chip) are the same event in two visual languages a few hundred pixels apart. Restating your own metadata is chrome that carries no new information, a direct hit against PRODUCT.md's "chrome exists only when it carries information."

**Deterministic scan:** `detect.mjs --json` against `styles.css` (exit code 2, 2 findings) returned zero hits inside the actual touched-notes surface (`.mva-tool*`, `.mva-sources`/`.mva-src-*` are clean). Both findings are out of scope: a `border-left: 3px solid` at line 361 belongs to `.mva-bubble blockquote` (legitimate Markdown blockquote styling, not a card accent — a defensible false positive), and a `transition: width` at line 2553 belongs to `.mva-outline-tick` (already reviewed and accepted today as an intentional, low-cost animation ported faithfully from the notion-outline plugin). No false positives to correct within this critique's actual target.

**Measured weight:** the collapsed tool row is `min-height: 24px` + `padding: 3px` top/bottom = 30px per row; rows stack at `gap: 8px` inside `.mva-assistant-body`. A 4-tool-call turn (a normal note-editing turn) costs **4 × 30px + 3 × 8px ≈ 144px** of pre-content chrome before the `.mva-sources` footer or a single word of the assistant's answer.

## Overall Impression

The collapsed-by-default philosophy is the right instinct, and the theming discipline (dot color, accent border, no hardcoded values) is solid. What breaks it is **double-accounting**: the live per-tool-call rows and the end-of-turn footer both persist after the turn and both enumerate the same files, so every note-editing turn pays a two-band metadata tax before the reader reaches the actual content. That's the single biggest opportunity — the fix is structural (stop rendering the same fact twice), not a paint job.

## What's Working

1. **Collapsed-by-default is correct.** `createToolCard()` opens `is-collapsed`, drops the icon/spinner to a 7px dot — progressive disclosure per PRODUCT.md principle #3. The bones are right, only the execution over-weighs them.
2. **Theme-derived color throughout.** No hardcoded values; the write-chip accent border is a legitimate single-signal "this mutated your vault" marker — exactly the "one accent is enough" principle in practice.
3. **Revert/diff on write chips earns its place.** Two-step arm→confirm revert plus a real diff view is the one piece of chrome here that carries information you can't get elsewhere, and it's correctly gated behind an actual checkpoint.

## Priority Issues

**[P1] Two surfaces render the same touched-notes payload**
- **Why it matters:** the live rows and the `.mva-sources` footer both persist and both list the same files — the single largest contributor to "too much focus / makes the chat heavy," and a direct violation of "chrome exists only when it carries information."
- **Fix:** live rows are a **streaming-only** affordance — real-time status while a tool is running. Once the turn settles, they dissolve; only the footer (which already groups, de-dupes via `×count`, and carries revert/attach) persists. One file-list per turn, not two.
- **Suggested command:** `/impeccable distill`

**[P1] One full-width row per tool call doesn't scale to agentic turns**
- **Why it matters:** a 6-operation turn front-loads ~180px+ of vertical chrome before any prose — actively fighting "keep going without switching context," the exact workflow Exo's power-user persona lives in.
- **Fix:** coalesce consecutive file operations into one compact multiline group, or a single "Working… (4 files)" line that expands on click, instead of an independent stacked block per call.
- **Suggested command:** `/impeccable distill` (structure) + `/impeccable layout` (grouping)

**[P2] The collapsed row spends more prominence than its own comment intends**
- **Why it matters:** the CSS comment calls it "a single thin muted row," but it still carries `font-weight: 500`, a monospace filename, and a persistent underline when the target is a link — three prominence signals on metadata meant to be secondary.
- **Fix:** drop to `font-weight: 400`; remove the persistent underline on `.mva-tool-target.mva-link`, reveal it on hover only (the row is already fully clickable).
- **Suggested command:** `/impeccable quieter`

**[P2] The EDITED/READ split adds two tracked headers for a distinction already shown three other ways**
- **Why it matters:** read-vs-write is already encoded via icon, accent border, and accent icon color — the uppercase tracked group labels are redundant chrome on top of redundant chrome, and uppercase-tracked type is itself a "look at me" signal.
- **Fix:** drop the text group labels; if scannability needs a lead-in, use one lowercase muted word, not two tracked uppercase headers.
- **Suggested command:** `/impeccable distill`

**[P3] Revert is hover-gated with no discoverability signal**
- **Why it matters:** "revert what the agent just did" is the action a user reaches for under mild panic — hiding it fully behind hover risks a user not knowing it exists at the moment they need it, especially a first-timer.
- **Fix:** keep hover-reveal, but give write chips a faint persistent affordance (e.g., a low-opacity indicator the hover expands) so the capability is discoverable without being loud. Read-chip actions (low-stakes) can stay fully hover-hidden.
- **Suggested command:** `/impeccable clarify`

## Persona Red Flags

**Mario (power user, multi-file agentic turns, daily):** every substantive turn produces a tall metadata stack (live rows) plus a footer restating it plus an action-icon strip. Reading back through a session means scrolling past three metadata bands per turn to reach the prose — the chrome scales *with* how much useful work the agent did, which is backwards.

**First-timer:** sees the same filenames as underlined row-links *and* as pill chips with mismatched verbs ("Append" vs. the file listed under `EDITED`) and reasonably wonders if these are different things. Won't discover revert at all (hover-only, no hint).

## Minor Observations

- `×{count}` on write chips is a genuinely good de-dup signal — extend the same logic upstream so live rows don't show 3 separate "Edit note X.md" rows for the same file mid-stream.
- `EDITED`/`READ` ordering (writes first) is the right priority; preserve it wherever the two surfaces get merged.
- Verify the running→ok→error dot swap (`.svg-icon` → `::before`) doesn't cause a 1px reflow.
- With border/background zeroed on collapse, the only structure holding rows together is the 7px dot alignment — at `gap: 8px` the stack can read as floating fragments rather than one group; the P1 coalescing fix addresses this as a side effect.

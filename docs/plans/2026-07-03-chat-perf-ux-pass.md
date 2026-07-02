# Chat performance & UX deep pass — Implementation Plan

> **For agentic workers:** execute feature-by-feature IN ORDER. No test harness: verification per feature = `npm run typecheck` + `npm run build` (exit 0) + commit with the given message. Live validation is orchestrator-owned.

**Goal:** Kill the four measured pains: streaming jank (O(n²) re-render), scroll yank, perceived cold start, and the raw ask_user card — plus a card-coherence pass.

**Diagnosis (verified in code):** `renderText` empties and re-parses the ENTIRE accumulated reply per tick (view.ts ~1798-1812); `scrollConvo` unconditionally forces `scrollTop = scrollHeight` on every event (~2547); the CLI session spawns lazily on first send; the AskCard (renderAskCard) is functionally complete but visually unrefined.

---

## Feature 1: Incremental streaming renderer (kills the O(n²) jank)

**Files:** `src/view.ts`.

Current: `AssistantCtx.curTextEl` holds ONE div; every `scheduleRender` tick calls `renderText` → `el.empty()` + `MarkdownRenderer.render(app, ENTIRE curRaw, el, …)`. Replace with stable-prefix + live-tail rendering:

1. Add to `AssistantCtx`: `stableLen: number` (chars of curRaw already final-rendered; init 0 wherever ctx is created) and `tailEl: HTMLElement | null` (init null).
2. Add a module-level helper — the last SAFE block boundary (double newline **outside** a code fence):
```ts
/** Index just after the last blank-line block boundary that is not inside a
 * ``` fence, or 0. Rendering the prefix up to here is layout-stable. */
function stableBoundary(md: string): number {
  let fence = false, last = 0;
  const lines = md.split("\n");
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(```|~~~)/.test(line.trim())) fence = !fence;
    pos += line.length + 1;
    if (!fence && line.trim() === "" && i < lines.length - 1) last = pos;
  }
  return last;
}
```
3. Rework `renderText(ctx, streaming)`:
   - **streaming=true** (tick): compute `b = stableBoundary(ctx.curRaw)`. If `b > ctx.stableLen`: render ONLY `curRaw.slice(ctx.stableLen, b)` into a NEW child div (`ctx.curTextEl.createDiv()`, class `mva-md-block markdown-rendered`) appended before the tail, and set `ctx.stableLen = b`. Then re-render the tail: if `ctx.tailEl` missing create it as the LAST child (`mva-md-tail markdown-rendered`); `tailEl.empty()`; `MarkdownRenderer.render(app, curRaw.slice(ctx.stableLen), tailEl, "", this)` → caret appended to tailEl in the `.then` (keep the clearCarets/caret logic, scoped to tailEl).
   - **streaming=false** (flush/final): `ctx.curTextEl.empty(); ctx.stableLen = 0; ctx.tailEl = null;` then ONE full render of the (optionally wikilinkified) whole text — exactly today's final-render semantics, so wikilinkify and correctness are untouched.
4. Wherever the code resets `ctx.curTextEl = null` (new text segment, error, permission card, ask card…), also reset `ctx.stableLen = 0; ctx.tailEl = null;` — grep every `curTextEl = null` site and every place a new `curTextEl` is created.
5. With per-tick work now O(tail), tighten the debounce ladder in `scheduleRender`: `const delay = len > 8000 ? 150 : len > 3000 ? 100 : 60;` (the length now matters far less; keep a mild ladder for very chatty streams).
6. CSS: `.mva-md-block { }` needs no visual difference — but check that consecutive blocks don't double the paragraph margins (add `.mva-md-block > :first-child { margin-top: 0 }`-style corrections ONLY if visually needed during your build; keep bubbles visually identical).
7. Typecheck + build → commit: `perf(chat): incremental streaming renderer — stable blocks render once`

## Feature 2: Scroll pinning (kills the yank + thrash)

**Files:** `src/view.ts`, `styles.css`.

1. Add view fields: `private pinnedToBottom = true;` and in `onOpen` (where `this.listEl` is created/wired) attach ONE scroll listener:
```ts
this.listEl.addEventListener("scroll", () => {
  const el = this.listEl;
  this.pinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  this.updateJumpPill();
}, { passive: true });
```
2. Rework `scrollConvo(c)`: only act when `c === this.active`; if `this.pinnedToBottom`, batch the write in a rAF (coalesce: keep a `private scrollRaf: number | null`; skip if one is pending):
```ts
private scrollConvo(c: Convo): void {
  if (c !== this.active || !this.pinnedToBottom) { this.updateJumpPill(); return; }
  if (this.scrollRaf !== null) return;
  this.scrollRaf = requestAnimationFrame(() => {
    this.scrollRaf = null;
    this.listEl.scrollTop = this.listEl.scrollHeight;
  });
}
```
3. **Jump pill**: a small floating button (absolute, bottom-right above the composer, `mva-jump-pill`, chevron-down icon via `setIcon`) visible only when `!pinnedToBottom && active convo is streaming OR has unseen content`; click → `pinnedToBottom = true` + scroll to bottom + hide. Implement `updateJumpPill()` creating/removing it lazily. Switching tabs (`activate`/tab click) resets `pinnedToBottom = true`.
4. When the USER sends a message (`send()`), force `pinnedToBottom = true` (you always want to see your own message land).
5. CSS: `.mva-jump-pill` — pill, `var(--background-secondary)` bg, border, shadow-sm, hover accent; respects reduced-motion (no bounce, just fade).
6. Typecheck + build → commit: `feat(chat): scroll pinning + jump-to-bottom pill (no more yank)`

## Feature 3: Session pre-warm (hides the cold start)

**Files:** `src/view.ts`, `src/settings.ts`.

1. Setting `prewarmSession: boolean` default `true` — "Pre-warm the agent session. Start the CLI session in the background when Exo opens, so the first message skips the cold start."
2. In the view, add `private prewarm(): void` → `if (!this.plugin.settings.prewarmSession) return; const c = this.active; if (c.session || c.streaming) return; void this.ensureSession(c).catch(() => {});` (swallow errors — a real send will surface them with the existing UX).
3. Call `this.prewarm()`: at the end of `onOpen`, on tab switch/creation (wherever the active convo changes), and after settings changes that rebuild the session are saved. Ensure `ensureSession` is idempotent/reentrant (it caches by sessionSig — verify; if a concurrent call risk exists, guard with a simple `private prewarming = false` flag).
4. Guard: do NOT prewarm when the provider is Codex (spawn-per-turn model, nothing to warm) — only for Claude.
5. Typecheck + build → commit: `perf(chat): pre-warm the Claude session on open (first message skips cold start)`

## Feature 4: Hooks cost transparency (small)

**Files:** `src/settings.ts`, `src/ui/capabilities.ts`.

1. Extend the "Run Claude Code hooks" setting desc with the honest cost: "Note: hooks run at session start and on every tool call — heavy or network-bound hooks (check what's in your global settings) slow turns down. Turn off if Exo feels sluggish."
2. Hooks card in capabilities: append a faint hint line "Hooks run at session start and per tool call — they add latency if slow."
3. Typecheck + build → commit: `docs(hooks): surface the latency cost of hooks in settings + card`

## Feature 5: ask_user card redesign

**Files:** `src/view.ts` (`renderAskCard` + the read-only `ask` branch of `renderConvoDom`), `styles.css`.

Keep the EXACT same behavior/contract (selections, multiSelect, Other, single-question-single-select resolves on click, Submit otherwise, `{t:"ask"}` persistence). Redesign the presentation:

1. **Layout per question**: header chip (small, uppercase-free, accent-tinted pill — reuse `.mva-src-label` look but as a rounded chip `mva-ask-chip`) on its own line; question text `font-weight:600; font-size:13px`; options as a vertical list of **selectable rows** (`mva-ask-opt`): radio-dot (single) or checkbox-square (multi) leading indicator drawn in CSS (a 14px circle/square span `mva-ask-ind`), label (`13px`, `--text-normal`), description under it (`11.5px`, `--text-muted`), 8px 10px padding, 6px radius, 1px border `--background-modifier-border`, hover: border-hover + bg `--background-modifier-hover`; selected: border `--interactive-accent`, indicator filled accent, bg accent 8% via color-mix.
2. **Other…** becomes a ghost row at the end of the options list (same row anatomy, dashed border, pencil icon instead of the indicator); clicking it expands an inline text input inside the row (autofocus); typing marks the row selected; Enter submits when the card is single-question single-select, otherwise participates in Submit.
3. **Submit**: right-aligned `.mva-btn.mva-btn-primary`, disabled (`opacity .5; pointer-events none`) until every question has a selection; on multi-question cards add a subtle per-question answered check in the chip.
4. **Keyboard**: options are `button` elements already — ensure logical tab order and that ArrowUp/ArrowDown move focus within a question's options (a small keydown handler on the options container); Enter/Space activate (native button behavior covers it).
5. **Resolved state** (both live-resolved and the restored `renderConvoDom` branch): collapse to a compact summary — header chip + "→ answer" line per question (class `mva-ask-answer`), options hidden. Live: after resolve, remove/hide the option rows and render the same summary (so transcript and restore look identical).
6. Reduced motion respected (no transitions beyond opacity/border-color 120ms).
7. Typecheck + build → commit: `feat(ask): redesign the ask card — selectable rows, indicators, ghost Other, compact resolved state`

## Feature 6: Card coherence & density pass

**Files:** `styles.css` primarily; `src/view.ts`/`src/ui/tools.ts` only if a class is missing.

1. Introduce shared tokens at the top of the Exo CSS block: `--mva-card-pad: 10px 12px; --mva-card-radius: var(--mva-r2); --mva-card-border: 1px solid var(--background-modifier-border);` and apply to ALL five card families (tool card, permission card, ask card, dream modal cards use modal styles — skip, playbook/capabilities cards) — replacing their individually hardcoded values. Visual target: identical padding/radius/border rhythm across families.
2. **Tool-card density**: collapsed single-line by default is already the pattern; verify and tighten: reduce vertical padding of tool cards to 6px 10px, label 12.5px, and cap expanded output height with `max-height: 240px; overflow-y: auto` if not already.
3. Message rhythm: assistant/user bubble spacing — normalize the gap between turns to a single value (12px) and intra-turn element gap to 8px. Only adjust CSS, no DOM changes.
4. Sweep for leftover `text-faint` on interactive labels (a11y contrast — should be `text-muted`).
5. Typecheck + build → commit: `style(chat): unify card tokens + density pass across all card families`

---

## Self-review notes
- F1 is the risky one: the fence-parity boundary and the `curTextEl = null` reset sweep are the two correctness traps — the final flush render is the safety net (always full re-render at turn end).
- F2 changes scroll behavior globally in the view — the pill must never appear when pinned; tab switch resets pin.
- F3 must not fight `sessionSigOf` rebuilds — prewarm AFTER settings save, and it's a no-op when a session exists.
- F5 keeps the tool contract byte-identical (answers payload unchanged) — presentation only.
- Order matters: F1 before F2 (both touch the streaming path), F5 before F6 (F6 tokenizes what F5 creates).

# Ask User tool — Implementation Plan

> **For agentic workers:** execute task-by-task. Steps use `- [ ]`. This repo has **no unit-test harness** — the verification step for every task is `npm run typecheck` (and `npm run build` before commit), plus the live-validation checklist in Task 6. Commit after each task.

**Goal:** Give the Exo agent an `ask_user` tool that renders structured, selectable questions as a chat card (Claude Code AskUserQuestion parity) and returns the user's choices.

**Architecture:** In-process MCP tool whose handler awaits an `askBridge` promise provided by the view; the view renders an `AskCard` (permission-card pattern) and resolves the promise on submit. Answers persist as a new `{ t: "ask" }` segment.

**Tech Stack:** TypeScript, Obsidian API, `@anthropic-ai/claude-agent-sdk` in-process MCP (`tool`, `createSdkMcpServer`), zod.

**Spec:** `docs/specs/2026-07-02-ask-user-tool-design.md`

---

## File structure

- `src/obsidian/tools.ts` — the `ask_user` tool + `askBridge` param on `createObsidianToolServer`.
- `src/view.ts` — `AskCard` UI, the `askBridge` impl + routing, watchdog suspension, Stop hook, `{t:"ask"}` segment type + persistence/restore.
- `src/providers/claude.ts` — add built-in `AskUserQuestion` to `disallowedTools` when the obsidian server is active.
- `styles.css` — ask-card styles (reuse `.mva-perm*` / `.mva-btn*`).

---

### Task 1: Ask segment type + shared question types

**Files:** Modify `src/view.ts` (Segment union + a shared `AskQuestion` type), `src/obsidian/tools.ts` (import/duplicate the type).

- [ ] **Step 1: Add the question type + segment variant in `view.ts`.**
Near the `Segment` type (currently `text` | `tool`), add:
```ts
export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}
type Segment =
  | { t: "text"; md: string }
  | { t: "tool"; name: string; input: unknown; ok: boolean | null; output: string }
  | { t: "ask"; questions: AskQuestion[]; answers: Record<string, string> };
```

- [ ] **Step 2:** `npm run typecheck` — expect errors in `renderConvoDom`/`serialize`/`convoPreview` where the segment union is switched on (they don't handle `"ask"` yet). That's expected; the next tasks handle those sites. If typecheck errors are ONLY "not all code paths handle ask" in those functions, proceed; add a temporary `case "ask": break;` / `else if (s.t === "ask")` no-op in `convoPreview` and `renderConvoDom` and `serialize` so typecheck passes with a placeholder render (`"[question]"`).

- [ ] **Step 3:** `npm run typecheck` passes. `npm run build`.

- [ ] **Step 4: Commit.**
```bash
git add src/view.ts && git commit -m "feat(ask): add {t:'ask'} segment + AskQuestion type"
```

---

### Task 2: The `ask_user` tool + `askBridge` plumbing

**Files:** Modify `src/obsidian/tools.ts`.

- [ ] **Step 1: Add the `askBridge` param to the factory.** Change the signature:
```ts
export function createObsidianToolServer(
  app: App,
  alwaysLoad = true,
  memoryWrite = true,
  askBridge?: (questions: AskQuestion[]) => Promise<Record<string, string>>
) {
```
Add the type (duplicate the shape to avoid a view→tools import cycle):
```ts
interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}
```

- [ ] **Step 2: Add the tool, after `getActiveContext` (a non-write, user-facing tool):**
```ts
  const askUser = tool(
    "ask_user",
    "Ask the user structured questions with selectable options. Use this to resolve a genuine choice you can't infer — approach, scope, ambiguity between concrete options. Prefer it over asking in free text. Up to 4 questions; 2–6 options each; set multiSelect for multi-choice.",
    {
      questions: z.array(
        z.object({
          question: z.string(),
          header: z.string(),
          options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(2).max(6),
          multiSelect: z.boolean().optional(),
        })
      ).min(1).max(4),
    },
    async (args) => {
      if (!askBridge) return ok("No user is present (headless run) — proceed with your best judgment.");
      try {
        const answers = await askBridge(args.questions as AskQuestion[]);
        return ok(JSON.stringify(answers));
      } catch (e) {
        return ok(`User dismissed the question — proceed with your best judgment. (${e instanceof Error ? e.message : ""})`);
      }
    }
  );
```

- [ ] **Step 3: Register it** in the `tools:` array (add `askUser,` in the read/utility group, e.g. after `getActiveContext`).

- [ ] **Step 4:** `npm run typecheck` (expect: unused-ok since callers don't pass askBridge yet — fine, it's optional). `npm run build`.

- [ ] **Step 5: Commit.**
```bash
git add src/obsidian/tools.ts && git commit -m "feat(ask): ask_user in-process tool + askBridge param"
```

---

### Task 3: AskCard UI + the bridge in the view

**Files:** Modify `src/view.ts`, `styles.css`.

- [ ] **Step 1: Add per-turn routing state.** In `AssistantCtx` add `pendingAsk: (() => void) | null` is on the Convo already for perm; add an ask analogue on the Convo interface: `pendingAsk: (() => void) | null;` (init `null` in `makeConvo`/`restore`). Track the "current ask target ctx": add a field `private askTargetCtx: AssistantCtx | null = null;` on ChatView; set it in `addAssistantTurn` (`this.askTargetCtx = ctx;`).

- [ ] **Step 2: Implement `askBridge`** as a method:
```ts
  private askBridge(questions: AskQuestion[]): Promise<Record<string, string>> {
    const ctx = this.askTargetCtx;
    const c = ctx?.convo ?? this.active;
    return new Promise((resolve, reject) => {
      if (!ctx) { reject(new Error("no active turn")); return; }
      this.renderAskCard(ctx, c, questions, resolve, reject);
    });
  }
```

- [ ] **Step 3: Implement `renderAskCard`** (models `addPermissionCard`):
```ts
  private renderAskCard(
    ctx: AssistantCtx, c: Convo, questions: AskQuestion[],
    resolve: (a: Record<string, string>) => void, reject: (e: Error) => void
  ): void {
    this.dropThinking(ctx);
    ctx.curTextEl = null; ctx.curTextSeg = null;
    const card = ctx.bodyEl.createDiv({ cls: "mva-ask" });
    const answers: Record<string, string> = {};
    const seg: Segment = { t: "ask", questions, answers };
    ctx.segments.push(seg);
    let done = false;
    const finish = () => {
      if (done) return; done = true; c.pendingAsk = null;
      card.addClass("is-resolved"); card.querySelectorAll("button,input").forEach((el)=>((el as HTMLElement).setAttribute("disabled","true")));
      resolve(answers);
    };
    c.pendingAsk = () => { if (done) return; done = true; c.pendingAsk = null; reject(new Error("cancelled")); };
    const selections = questions.map(() => new Set<string>());
    const maybeSubmit = () => {
      const allAnswered = questions.every((q,i)=> selections[i].size>0);
      if (allAnswered) { questions.forEach((q,i)=> answers[q.header] = [...selections[i]].join(", ")); finish(); }
    };
    questions.forEach((q, i) => {
      const qEl = card.createDiv({ cls: "mva-ask-q" });
      qEl.createSpan({ cls: "mva-src-label", text: q.header });
      qEl.createDiv({ cls: "mva-ask-question", text: q.question });
      const opts = qEl.createDiv({ cls: "mva-ask-opts" });
      const single = questions.length === 1 && !q.multiSelect;
      for (const o of q.options) {
        const b = opts.createEl("button", { cls: "mva-ask-opt" });
        b.createDiv({ cls: "mva-ask-opt-label", text: o.label });
        if (o.description) b.createDiv({ cls: "mva-ask-opt-desc", text: o.description });
        b.onclick = () => {
          if (q.multiSelect) { b.toggleClass("is-sel", !b.hasClass("is-sel")); selections[i].has(o.label)?selections[i].delete(o.label):selections[i].add(o.label); }
          else { opts.querySelectorAll(".mva-ask-opt").forEach(x=>x.removeClass("is-sel")); b.addClass("is-sel"); selections[i].clear(); selections[i].add(o.label); if (single) maybeSubmit(); }
        };
      }
      // Other…
      const other = qEl.createEl("input", { cls: "mva-ask-other", attr: { type: "text", placeholder: "Other…" } });
      other.addEventListener("input", () => { if (other.value.trim()) { if (!q.multiSelect) selections[i].clear(); selections[i].add(other.value.trim()); } else selections[i].delete(other.value.trim()); });
    });
    if (!(questions.length === 1 && !questions[0].multiSelect)) {
      const actions = card.createDiv({ cls: "mva-ask-actions" });
      actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Submit" }).onclick = () => { questions.forEach((q,i)=> answers[q.header] = [...selections[i]].join(", ")); if (Object.values(answers).some(v=>v)) finish(); };
    }
    this.scrollConvo(c);
  }
```
(Note: for single-select single-question, clicking submits immediately; otherwise a Submit button. "Other…" text adds a free value.)

- [ ] **Step 4: Add `askBridge` to the tool server build.** In `ensureSession`, where `createObsidianToolServer(this.app, wantAlwaysLoad, wantMemoryWrite)` is called, pass a 4th arg `(qs) => this.askBridge(qs)`. Also include the ask state in `sessionSigOf`? No — the bridge is stable; leave sig as-is.

- [ ] **Step 5: CSS.** Add to `styles.css` (reuse tokens):
```css
.mva-ask { border:1px solid var(--background-modifier-border); border-radius:var(--mva-r2); background:color-mix(in srgb,var(--interactive-accent) 4%,var(--background-primary)); padding:10px 12px; }
.mva-ask-q { margin-bottom:10px; }
.mva-ask-question { font-weight:600; color:var(--text-normal); margin:2px 0 6px; }
.mva-ask-opts { display:flex; flex-direction:column; gap:6px; }
.mva-ask-opt { text-align:left; padding:7px 10px; border:1px solid var(--background-modifier-border); border-radius:var(--mva-r1); background:var(--background-primary); cursor:pointer; }
.mva-ask-opt:hover { border-color:var(--background-modifier-border-hover); }
.mva-ask-opt.is-sel { border-color:var(--interactive-accent); background:color-mix(in srgb,var(--interactive-accent) 10%,transparent); }
.mva-ask-opt-label { font-size:12.5px; color:var(--text-normal); font-weight:550; }
.mva-ask-opt-desc { font-size:11px; color:var(--text-muted); margin-top:2px; }
.mva-ask-other { width:100%; margin-top:6px; padding:5px 8px; border:1px solid var(--background-modifier-border); border-radius:var(--mva-r1); background:var(--background-primary); color:var(--text-normal); font-size:12px; }
.mva-ask-actions { display:flex; justify-content:flex-end; margin-top:8px; }
.mva-ask.is-resolved { opacity:0.75; }
```

- [ ] **Step 6:** `npm run typecheck`; `npm run build`.

- [ ] **Step 7: Commit.**
```bash
git add src/view.ts styles.css && git commit -m "feat(ask): AskCard UI + askBridge wiring"
```

---

### Task 4: Watchdog suspension + Stop cancel + disallow built-in

**Files:** Modify `src/view.ts`, `src/providers/claude.ts`.

- [ ] **Step 1: Suspend the idle watchdog while an interactive card is pending.** In `runTurn`, the `bump()` re-arms the 120s watchdog on every event. Add a guard: a boolean `let interactive = false;` in `runTurn`. In `bump()`, `if (interactive) return;` before arming. Set `interactive = true` when an ask OR permission card opens, and `interactive = false; bump();` when it resolves. Concretely: in the `permission-request` handler wrap the card-open path to set `interactive=true`, and in the ask path (the tool-call-start for `ask_user`) too; on resolve of either, clear it and `bump()`. Simplest robust hook: set `interactive = true` right before `this.renderAskCard`/`this.addPermissionCard`, and pass a callback that sets `interactive=false; bump();` — or clear it in the `finish`/`settle` closures. Wire it via `c.pendingAsk`/`c.pendingPerm` lifecycle.

- [ ] **Step 2: Stop cancels a pending ask.** In `stop()`, after `c.pendingPerm?.();` add `c.pendingAsk?.();`.

- [ ] **Step 3: Disallow the SDK's built-in AskUserQuestion when our tool is active.** In `claude.ts`, where `disallowedTools` is set for native-first, also (whenever `opts.obsidianServer` is present) include `"AskUserQuestion"`:
```ts
// when obsidianServer is present, prevent the SDK's UI-less AskUserQuestion:
...(opts.obsidianServer ? { disallowedTools: [ ...(opts.nativeFirst ? NATIVE_FIRST_DISALLOW : []), "AskUserQuestion" ] } : (opts.nativeFirst && opts.obsidianServer ? { disallowedTools: NATIVE_FIRST_DISALLOW } : {})),
```
(Consolidate with the existing `nativeFirst` disallow block so there's a single `disallowedTools` — don't emit the key twice.)

- [ ] **Step 4:** `npm run typecheck`; `npm run build`.

- [ ] **Step 5: Commit.**
```bash
git add src/view.ts src/providers/claude.ts && git commit -m "fix(ask): suspend watchdog on pending cards, Stop cancels ask, block built-in AskUserQuestion"
```

---

### Task 5: Persist + restore ask segments

**Files:** Modify `src/view.ts`.

- [ ] **Step 1: `serialize()`** — the assistant-message map keeps `text` and slices `tool` output; `ask` segments are plain data (questions + answers) → they serialize as-is. Confirm the map's default arm passes non-tool segments through unchanged (it does: `s.t === "tool" ? {...} : s`). No change needed unless answers are large — they aren't.

- [ ] **Step 2: `renderConvoDom()`** — in the assistant loop, add an `ask` branch that renders the resolved card read-only:
```ts
} else if (s.t === "ask") {
  const card = body.createDiv({ cls: "mva-ask is-resolved" });
  for (const q of s.questions) {
    const qEl = card.createDiv({ cls: "mva-ask-q" });
    qEl.createSpan({ cls: "mva-src-label", text: q.header });
    qEl.createDiv({ cls: "mva-ask-question", text: q.question });
    qEl.createDiv({ cls: "mva-ask-answer", text: `→ ${s.answers[q.header] ?? "—"}` });
  }
}
```
Add `.mva-ask-answer { font-size:12px; color:var(--text-muted); margin-top:4px; }` to styles.css.

- [ ] **Step 3: `convoPreview()`** — replace the temporary `ask` placeholder with a short summary: `seg.t === "ask" ? "↳ asked: " + seg.questions.map(q=>q.header).join(", ") : ...`.

- [ ] **Step 4:** `npm run typecheck`; `npm run build`.

- [ ] **Step 5: Commit.**
```bash
git add src/view.ts styles.css && git commit -m "feat(ask): persist + restore ask segments read-only"
```

---

### Task 6: Live validation

**Files:** none (manual, in Obsidian).

- [ ] **Step 1:** `npm run build`, then in Obsidian **disable→enable** the Exo plugin (NOT `plugin:reload` — it's flaky after a rebuild).
- [ ] **Step 2:** `obsidian dev:errors` → no load errors; confirm the tool exists: `eval` → the obsidian MCP server lists `ask_user` (or just prompt the agent).
- [ ] **Step 3:** In a chat (tools ON, Claude), prompt: *"Ask me, using ask_user, whether to use approach A or B (single question, 2 options)."* → a card appears; click an option → the agent continues with the answer.
- [ ] **Step 4:** Multi-select: *"Ask me which of these 4 features to build, multi-select."* → toggles + Submit; verify comma-joined answer reaches the agent.
- [ ] **Step 5:** Multi-question (2 questions in one call) → answer both → single Submit.
- [ ] **Step 6:** "Other…" → type a free answer, submit → verify it's what the agent receives.
- [ ] **Step 7:** Open a card and **wait > 120s** before answering → verify NO "timed out" (watchdog suspended).
- [ ] **Step 8:** Open a card, press **Stop** → turn ends cleanly, agent tool result is "dismissed".
- [ ] **Step 9:** **Reload** the vault → the resolved ask card persists in the transcript showing the chosen answers.

---

## Self-review notes
- Spec coverage: tool (T2), bridge+card (T3), watchdog fix (T4), Stop (T4), disallow built-in (T4), persistence (T1/T5), headless graceful (T2). ✓
- Types: `AskQuestion` defined in view.ts (exported) + duplicated in tools.ts to avoid a cycle; `{t:"ask"}` segment consistent across T1/T3/T5. ✓
- No unit tests (repo has none) — verification = typecheck + build + the Task 6 live checklist, consistent with how this codebase has been validated all session.

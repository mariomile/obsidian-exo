# Memory Injection Calibration: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every standing/per-turn memory injection pay for what it costs, following the bb pattern (compact catalog in standing instructions, full records pulled on demand). This is a CALIBRATION of the existing layered memory, not a rebuild: three targeted fixes plus a live verification. No new stores, no new tools, no new settings.

**Architecture:** Exo's memory injection already matches the bb pattern in most places; the audit below proves it. Three confirmed mismatches get fixed: (1) the boot preamble's "Recent sessions" slice injects 637 chars of pure frontmatter/boilerplate and **zero** session entries; (2) with `injectContextContent` ON, attached-note bodies are inlined **unbounded**; (3) those same bodies are re-inlined **every turn** even when unchanged. Fix 1 lands as a pure helper in a new `src/core/boot-content.ts` wired into `src/obsidian/memory.ts`. Fixes 2–3 extend the pure `assembleContext` (`src/core/context-assembly.ts`) and wire through `src/view.ts` with a handful of lines, mirroring the `injectedMemoryIds` stamp-after-send pattern that proactive recall already uses.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest.

**Audit doc:** the Baseline section below IS the audit; re-verify the numbers before starting; they were measured 2026-08-11 against the real vault.

---

## Baseline: what Exo injects today (measured 2026-08-11)

Measured against the live vault (`/Users/mariomiletta/Vaults/marioverse.ai`, memory root `_system`, settings: `agentFolderEnabled=true`, `proactiveRecall=true` k=3, `injectContextContent=false`) by replicating `readBootContext` with the repo's own pure modules (script in Task 4).

**Standing (system-prompt append, once per session, prompt-cached across turns)**: assembled in `src/obsidian/memory.ts` `readBootContext`, cached per view lifetime (`ExoView.memoryPreamble`), appended in `src/providers/claude.ts:203` as `[EXO_HOUSE_RULES, systemPrompt, memoryPreamble]`:

| Section | Chars today | Notes |
|---|---|---|
| Identity (persona+human+now compiled) | 3,773 | blocks 945/1494/1118; advisory limits, whole-block, warns on overflow, sound |
| Boilerplate (conventions + precedence) | ~640 | fixed strings, sound |
| Vault context | 3,531 | file is 9,017 → capped 3,500 with `…(truncated)` marker; **~180 chars of the budget are YAML frontmatter** |
| Preferences | 2,529 | file is 3,667 → capped 2,500; **~230 chars are frontmatter** |
| Active rules | 406 | 13 rule **titles only**, already the bb catalog pattern |
| Recent sessions | 637 | ⚠️ **0 session entries.** Head-slice of `session-log.md` whose first `## [` entry starts at byte 4,530; the 600-char slice (`SESSION_LOG_CHARS_WITH_NOW`) is 100% frontmatter + the "⛔ file GENERATO" warning block |
| Open loops | 289 | parsed + bounded, sound |
| **Total** | **11,932** | cap `MAX_BOOT_AGENT` = 12,000 → 68 chars of headroom |

Plus `memoryStoreNoteProactive` + `agentFolderNote` (~1,300 chars, fixed) and `EXO_HOUSE_RULES` (~270).

**Per turn (outbound message)**: `src/view.ts` `runTurnBody`, joined at line ~6136 as `[sendPrefix, coldRecap, compactPrefix, childReports, recallBlock, agentMessage]`:

| Injection | Bound | Verdict |
|---|---|---|
| Proactive recall block | k=3, minScore 3.0, **800-char list budget**, per-convo dedup stamped only after `session.send` commits, back-reference guard, UI affordance | **Already bb-grade, stricter than bb's 3,900 cap. Untouched.** |
| Context notes (flag OFF, current) | paths only, ~1 line each | Already title+pointer + on-demand `mcp__obsidian__` read tools. Sound. |
| Context notes (flag ON, latent) | **UNBOUNDED full body, re-sent EVERY turn** (`view.ts:5569` `cachedRead` straight into `contents`, no cap, no dedup) | **Mismatch → Tasks 2–3** |
| Ambient selection | unbounded but user-visible (chip shows char count) | Deliberate display=send contract, untouched, see Self-Review |
| Cold recap | ≤5,000 chars, cold spawn only (`core/recovery.ts:buildRecap`) | Sound |
| Child reports | ≤10 reports, `EXCERPT_CAP` 2,000 | Sound |

**On-demand read/write paths (the bb "CLI commands" equivalent), already exist, no new tools needed:** `recall` (BM25 over the store, verbatim, k≤12, `as_of` point-in-time), `remember` (verbatim append), `rethink_memory` (identity), plus the full `mcp__obsidian__*` read tools for any vault file. The union store (578 entries / 209 KB across 2 monthly files) is never injected wholesale.

---

## Global Constraints

- Test runner: `pnpm test` (vitest). Typecheck: `pnpm typecheck`. Lint: `pnpm lint`. Full gate: `pnpm release:check`.
- New logic goes in pure modules under `src/core/` with **no Obsidian imports**. `src/view.ts` (ratchet **6,600**, currently 6,518, ~82 lines of headroom total, budget ≤15 for this plan) and `src/main.ts` (ratchet 3,480) get wiring only. Check `tests/size-contract.test.ts` after every wiring step; if it reddens, the logic belongs in a core module; never raise a ceiling.
- **Every task states its per-turn char delta** and the verification re-measures it.
- Test discipline: failing test first, then minimal implementation, then a **mutation check** (revert the key line of the implementation, confirm the test goes red, restore); a test that survives the mutation is rewritten.
- The vault at `/Users/mariomiletta/Vaults/marioverse.ai` is Mario's REAL vault: **read-only** for all measurement. Task 4's settings flips must record the original values first and restore them; no memory file under `_system/` is ever written.
- `pnpm build` deploys `main.js` straight into the live vault plugin dir (`.obsidian-plugin-dir`). **Never reload the plugin while a turn is in flight**; the reload kills the live turn. Reload only when Exo is idle.
- Behavioral seams: with `injectContent` off / no new opts passed, `assembleContext` output must stay **byte-identical** (the existing tests in `src/core/context-assembly.test.ts` are the proof; they must pass unmodified). `readBootContext` flag-OFF/ON-equivalence tests in `tests/boot-context-seam.test.ts` compare outputs to each other, not to frozen strings, so frontmatter-stripping keeps them green, but re-check the "halves the session-log slice" test, whose fixture may need the new head semantics.
- No new settings, stores, or agent tools. New caps are code constants.
- Commit after each task, explicit paths only (never `git add -A`). This plan file lives in gitignored `docs/plans/`; do **not** commit it.

---

### Task 1: Boot slices must carry signal, not boilerplate

The "Recent sessions" section pays 637 chars for zero session entries: `readBootContext`'s `read()` head-slices the raw file, and `session-log.md`'s first entry starts at byte 4,530 (frontmatter + title + the "⛔ Questo file è GENERATO" warning). Vault-context and preferences similarly burn ~410 chars of their caps on YAML frontmatter. Fix: a pure `bootFileHead` that strips frontmatter and (for generated logs) skips to the first `## ` heading before capping.

**Per-turn char delta:** ≈ 0 (section caps unchanged; total stays ≤12,000). Signal delta: session-log slice goes from **0 entries to ~6–8 entry lines**; ~410 chars of frontmatter across vault-context + preferences are replaced by real content (vault-context is truncated at 3,500 of 9,017, so every recovered char buys content that was previously cut).

**Files:**
- Create: `src/core/boot-content.ts`
- Create: `tests/boot-content.test.ts`
- Modify: `src/obsidian/memory.ts` (the `read` closure inside `readBootContext`)
- Possibly touch: `tests/boot-context-seam.test.ts` (fixture only, if the "halves" test asserts raw offsets)

**Interfaces:**
- Consumes: `stripFrontmatter` from `src/core/agents.ts` (already exported, `src/core/agents.ts:159`).
- Produces: `bootFileHead(raw: string, max: number, opts?: { fromFirstHeading?: boolean }): string`: frontmatter-free (and optionally heading-anchored) head, capped with the exact same `"\n…(truncated)"` marker `memory.ts`'s local `cap` uses.

- [ ] **Step 1: Write the failing test**

Create `tests/boot-content.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { bootFileHead } from "../src/core/boot-content";

const FM = `---\ntype: memory\ncreated_by: claudian\ntags:\n  - type/memory\n---\n`;

describe("bootFileHead", () => {
  it("strips YAML frontmatter before capping", () => {
    const out = bootFileHead(`${FM}# Title\nreal content`, 100);
    expect(out).not.toContain("created_by");
    expect(out).toContain("real content");
  });

  it("fromFirstHeading skips a prose header and lands on the first ## entry", () => {
    const boilerplate = "# Session Log\n\n> ⛔ Questo file è GENERATO: non modificarlo a mano.\n".repeat(8);
    const raw = `${FM}${boilerplate}\n## [2026-08-11 12:02] lint | Delete pass\nbody\n## [2026-08-10 15:03] refactor | Archivio\n`;
    const out = bootFileHead(raw, 200, { fromFirstHeading: true });
    expect(out.startsWith("## [2026-08-11 12:02]")).toBe(true);
    expect(out).not.toContain("GENERATO");
  });

  it("fromFirstHeading falls back to the stripped body when no heading exists", () => {
    const out = bootFileHead(`${FM}just prose, no headings`, 100, { fromFirstHeading: true });
    expect(out).toBe("just prose, no headings");
  });

  it("caps with the explicit truncation marker", () => {
    const out = bootFileHead("x".repeat(500), 100);
    expect(out).toBe("x".repeat(100) + "\n…(truncated)");
  });

  it("returns short content unchanged (no marker)", () => {
    expect(bootFileHead("short", 100)).toBe("short");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/boot-content.test.ts`
Expected: FAIL; module `src/core/boot-content` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/boot-content.ts`:

```typescript
/**
 * Boot-injected file heads, pure (no Obsidian imports).
 *
 * WHY (2026-08-11 calibration): `readBootContext` head-slices raw files, but the
 * head of a vault note is its YAML frontmatter, and for GENERATED logs (the
 * session log) also a fixed prose header. Measured on the real vault, the
 * 600-char "Recent sessions" slice carried 0 session entries: 637 chars of pure
 * boilerplate. Every boot char must carry signal; frontmatter and generated-file
 * warnings carry none for the model.
 */
import { stripFrontmatter } from "./agents";

export interface BootHeadOpts {
  /** Skip everything before the first `## ` heading, for generated log files
   *  whose prose header (title, "file is generated" warning) carries no signal.
   *  Falls back to the frontmatter-stripped body when no heading exists. */
  fromFirstHeading?: boolean;
}

/** Same marker `readBootContext`'s cap has always used, truncation stays explicit. */
const TRUNCATION_MARKER = "\n…(truncated)";

export function bootFileHead(raw: string, max: number, opts: BootHeadOpts = {}): string {
  let body = stripFrontmatter(raw);
  if (opts.fromFirstHeading) {
    const m = /^## /m.exec(body);
    if (m) body = body.slice(m.index);
  }
  body = body.trim();
  return body.length > max ? body.slice(0, max) + TRUNCATION_MARKER : body;
}
```

Note the `.trim()`: without it the slice can start with blank lines between frontmatter and content. If the mutation check below shows an existing seam test depends on untrimmed output, drop the trim and adjust the test fixture instead: verify, don't assume.

- [ ] **Step 4: Verify green + mutation check**

Run: `pnpm vitest run tests/boot-content.test.ts` → PASS.
Mutation: comment out the `if (m) body = body.slice(m.index);` line → the `fromFirstHeading` test must FAIL. Restore.

- [ ] **Step 5: Wire into `readBootContext`**

In `src/obsidian/memory.ts`:

```typescript
import { bootFileHead, type BootHeadOpts } from "../core/boot-content";
```

Change the `read` closure to accept opts and delegate:

```typescript
  const read = async (path: string, max: number, headOpts?: BootHeadOpts): Promise<string> => {
    const f = app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      try {
        return bootFileHead(await app.vault.cachedRead(f), max, headOpts);
      } catch {
        /* ignore */
      }
    }
    return "";
  };
```

And the session-log call site becomes:

```typescript
  const log = await read(paths.sessionLog, logChars, { fromFirstHeading: true });
```

The other three call sites (`vaultContext`, `preferences`, `openLoops`) stay as-is; they now get frontmatter-stripping for free through `bootFileHead`. The local `cap` helper stays (still used for the loops section and the final `maxBoot` cap).

- [ ] **Step 6: Full gate**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green. If `tests/boot-context-seam.test.ts`'s "halves the session-log slice" test fails, its fixture (`"## session one\n## session two"`) starts at a heading already, so lengths shifted only by the new trim, adjust the *assertion*, never the semantics under test (flag ON with `now.md` signal must still yield a shorter log slice than flag OFF).

- [ ] **Step 7: Commit**

```bash
git add src/core/boot-content.ts tests/boot-content.test.ts src/obsidian/memory.ts tests/boot-context-seam.test.ts
git commit -m "boot preamble: strip frontmatter and generated-log headers from injected file heads"
```

---

### Task 2: Bound inlined note bodies (`injectContextContent` ON)

With the flag ON, `view.ts:5569` inlines each attached note's **entire body** into every outbound turn; no cap of any kind. A 40k-char open note costs ~10k tokens per turn, silently. bb's rule: bounded index always, full content on demand, and the on-demand path (native/`mcp__obsidian__` read tools) already exists, so a truncation marker that names the note is safe.

**Per-turn char delta:** worst case per attached note drops from unbounded to **≤ 6,000 + marker**; zero delta for notes under the cap; zero delta with the flag OFF (Mario's current live setting, this is latent hardening, done because the flag is one click away).

**Files:**
- Modify: `src/core/context-assembly.ts`
- Modify: `src/core/context-assembly.test.ts`
- Modify: `src/view.ts` (one constant + one field in the `assembleContext` call, ~3 lines)

**Interfaces:**
- Consumes: existing `AssembleContextInput` / `AssembledContext`.
- Produces: `AssembleContextInput.maxCharsPerNote?: number` (absent → today's behavior, byte-identical); `AssembledContext.truncatedPaths: string[]` (subset of `injectedContentPaths` whose body was cut).

- [ ] **Step 1: Write the failing test**

Add to `src/core/context-assembly.test.ts`:

```typescript
  it("caps an inlined body at maxCharsPerNote with a marker naming the note", () => {
    const body = "x".repeat(300);
    const r = assembleContext({
      paths: ["Notes/Big.md"],
      selection: null,
      injectContent: true,
      contents: { "Notes/Big.md": body },
      maxCharsPerNote: 100,
    });
    expect(r.block).toContain("x".repeat(100));
    expect(r.block).not.toContain("x".repeat(101));
    expect(r.block).toContain('…[truncated, read "Notes/Big.md" for the rest]');
    expect(r.injectedContentPaths).toEqual(["Notes/Big.md"]);
    expect(r.truncatedPaths).toEqual(["Notes/Big.md"]);
  });

  it("a body at exactly the cap is not truncated", () => {
    const r = assembleContext({
      paths: ["a.md"],
      selection: null,
      injectContent: true,
      contents: { "a.md": "y".repeat(100) },
      maxCharsPerNote: 100,
    });
    expect(r.block).not.toContain("truncated");
    expect(r.truncatedPaths).toEqual([]);
  });

  it("without maxCharsPerNote behavior is unchanged and truncatedPaths is empty", () => {
    const r = assembleContext({
      paths: ["a.md"],
      selection: null,
      injectContent: true,
      contents: { "a.md": "z".repeat(5000) },
    });
    expect(r.block).toContain("z".repeat(5000));
    expect(r.truncatedPaths).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/context-assembly.test.ts`
Expected: FAIL; `maxCharsPerNote` / `truncatedPaths` don't exist.

- [ ] **Step 3: Write minimal implementation**

In `src/core/context-assembly.ts`, add to `AssembleContextInput`:

```typescript
  /**
   * Per-note ceiling on an inlined body (chars). Over-cap bodies are cut with an
   * explicit marker pointing at the note, because the model can always read the
   * rest on demand via its file tools, bounded injection, unbounded access.
   * Absent → unbounded (legacy behavior, byte-identical).
   */
  maxCharsPerNote?: number;
```

Add to `AssembledContext`:

```typescript
  /** Subset of `injectedContentPaths` whose body was cut at `maxCharsPerNote`. */
  truncatedPaths: string[];
```

In `assembleContext`, declare `const truncatedPaths: string[] = [];`, include it in the returned object, and change the inline branch:

```typescript
        if (typeof body === "string") {
          injectedContentPaths.push(p);
          let text = body.trim();
          const cap = input.maxCharsPerNote;
          if (cap !== undefined && text.length > cap) {
            text = `${text.slice(0, cap)}\n…[truncated, read "${p}" for the rest]`;
            truncatedPaths.push(p);
          }
          inlined.push(`Context note "${p}":\n${text}`);
        } else {
```

- [ ] **Step 4: Verify green + mutation check**

Run: `pnpm vitest run src/core/context-assembly.test.ts` → all PASS, including every pre-existing test unmodified (the byte-identity proof).
Mutation: change `text.length > cap` to `text.length >= cap` → the exact-boundary test must FAIL. Restore.

- [ ] **Step 5: Wire the constant in `view.ts`**

Near the other module constants (by `MAX_PERSIST_OUTPUT`, ~line 198):

```typescript
/** Per-note ceiling when `injectContextContent` inlines bodies, bounded injection,
 *  the model reads the rest on demand. Aligned with the 6000-char source caps in
 *  `core/agent-self.ts`. */
const MAX_INLINE_NOTE_CHARS = 6000;
```

And in `runTurnBody`'s `assembleContext` call (~line 5576):

```typescript
    const assembled = assembleContext({ paths, selection, injectContent, contents, maxCharsPerNote: MAX_INLINE_NOTE_CHARS });
```

Run: `pnpm vitest run tests/size-contract.test.ts` → view.ts must stay under 6,600.

- [ ] **Step 6: Full gate + commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add src/core/context-assembly.ts src/core/context-assembly.test.ts src/view.ts
git commit -m "context inlining: bound each inlined note body at 6000 chars with explicit read-on-demand marker"
```

---

### Task 3: Stop re-paying for unchanged inlined bodies every turn

Still flag-ON territory: an attached note is re-inlined in full on **every** turn of the conversation, even byte-identical. `injectedMemoryIds` solves exactly this for recalled memories (pay once, then it lives in cached history) but does not cover note content. Same pattern, same stamp-after-send discipline: a note body already sent in this conversation, whose file mtime hasn't changed since, degrades to a pointer line; the content is already in the transcript.

**Per-turn char delta:** for a conversation with a 3k-char note attached across 10 turns: **30k → ~3.6k** (full body once + ~65-char pointer × 9). Zero delta with the flag OFF, on the first turn, or whenever the note was edited between turns (mtime change → re-inline, so the model never works from a stale body).

**Files:**
- Modify: `src/core/context-assembly.ts`
- Modify: `src/core/context-assembly.test.ts`
- Modify: `src/ui/convo-types.ts` (one transient field, next to `injectedMemoryIds` at ~line 232)
- Modify: `src/view.ts` (wiring in `runTurnBody`: build the unchanged set before assembling, stamp after `session.send`, ~10 lines)

**Interfaces:**
- Consumes: Task 2's shape.
- Produces: `AssembleContextInput.unchangedPaths?: ReadonlySet<string>`; `AssembledContext.reusedPaths: string[]`; `Convo.inlinedNoteMtimes?: Map<string, number>` (transient, like `injectedMemoryIds`, not persisted; a plugin reload simply re-inlines once).

- [ ] **Step 1: Write the failing test**

Add to `src/core/context-assembly.test.ts`:

```typescript
  it("an unchanged already-sent note degrades to a pointer line instead of re-inlining", () => {
    const r = assembleContext({
      paths: ["a.md", "b.md"],
      selection: null,
      injectContent: true,
      contents: { "a.md": "body A", "b.md": "body B" },
      unchangedPaths: new Set(["a.md"]),
    });
    expect(r.block).not.toContain("body A");
    expect(r.block).toContain("- a.md (content already provided earlier in this conversation)");
    expect(r.block).toContain("body B");
    expect(r.reusedPaths).toEqual(["a.md"]);
    expect(r.injectedContentPaths).toEqual(["b.md"]);
    expect(r.includedPaths).toEqual(["a.md", "b.md"]);
  });

  it("without unchangedPaths every body inlines and reusedPaths is empty", () => {
    const r = assembleContext({
      paths: ["a.md"],
      selection: null,
      injectContent: true,
      contents: { "a.md": "body A" },
    });
    expect(r.block).toContain("body A");
    expect(r.reusedPaths).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/context-assembly.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation**

In `AssembleContextInput`:

```typescript
  /**
   * Paths whose body was already inlined earlier in THIS conversation and whose
   * file is unchanged since (caller checks mtime). They degrade to an annotated
   * pointer line, the content already lives in the transcript, so re-inlining
   * pays for the same bytes every turn. An edited note (new mtime) must NOT be
   * in this set: staleness beats savings.
   */
  unchangedPaths?: ReadonlySet<string>;
```

In `AssembledContext`:

```typescript
  /** Paths that degraded to a pointer because their unchanged body was already sent. */
  reusedPaths: string[];
```

In the inline branch of `assembleContext`, before the `typeof body === "string"` check:

```typescript
        if (input.unchangedPaths?.has(p)) {
          reusedPaths.push(p);
          bare.push(`- ${p} (content already provided earlier in this conversation)`);
          continue;
        }
```

(with `const reusedPaths: string[] = [];` declared and returned; the non-inline `else` branch and no-input path return `reusedPaths: []` implicitly via the shared declaration).

- [ ] **Step 4: Verify green + mutation check**

Run: `pnpm vitest run src/core/context-assembly.test.ts` → PASS, pre-existing tests unmodified.
Mutation: remove the `continue;` → the dedup test must FAIL (body A would inline too). Restore.

- [ ] **Step 5: Wire in `convo-types.ts` and `view.ts`**

`src/ui/convo-types.ts`, next to `injectedMemoryIds`:

```typescript
  /** path → file mtime at the moment its body was last inlined into an outbound
   *  turn of THIS conversation. Same lifecycle and same stamp-after-send rule as
   *  `injectedMemoryIds`; transient (not persisted). */
  inlinedNoteMtimes?: Map<string, number>;
```

`src/view.ts` `runTurnBody`, while collecting `contents` (~line 5563), also collect mtimes and compute the unchanged set:

```typescript
    let noteMtimes: Record<string, number> = {};
    // …inside the existing `if (f instanceof TFile)` after the cachedRead:
            noteMtimes[p] = f.stat.mtime;
```

then before the `assembleContext` call:

```typescript
    const unchangedPaths = new Set(
      Object.keys(noteMtimes).filter((p) => c.inlinedNoteMtimes?.get(p) === noteMtimes[p])
    );
```

pass `unchangedPaths` into `assembleContext`, and stamp **exactly where `injectedMemoryIds` stamps** (after `outbound` is built, immediately before/after the recall stamping at ~line 6142, same rationale, quote it):

```typescript
      // Same commit-point rule as injectedMemoryIds above: a body is "already
      // provided" only once the send that carried it is real.
      if (assembled.injectedContentPaths.length) {
        if (!c.inlinedNoteMtimes) c.inlinedNoteMtimes = new Map();
        for (const p of assembled.injectedContentPaths) c.inlinedNoteMtimes.set(p, noteMtimes[p]);
      }
```

Note: `assembled` must therefore be reachable at the send site; it already is (same function scope).

Run: `pnpm vitest run tests/size-contract.test.ts` → view.ts under 6,600. If the added lines break the ratchet, extract the unchanged-set computation into a pure helper in `context-assembly.ts` (e.g. `selectUnchanged(noteMtimes, stamped)`) instead of trimming comments.

- [ ] **Step 6: Full gate + commit**

```bash
pnpm test && pnpm typecheck && pnpm lint
git add src/core/context-assembly.ts src/core/context-assembly.test.ts src/ui/convo-types.ts src/view.ts
git commit -m "context inlining: dedupe unchanged note bodies per conversation (stamp after send, mtime-invalidated)"
```

---

### Task 4: Live verification (obsidian-cli) + before/after measurement

**Files:** none committed (one throwaway measurement script under `/tmp`).

**Interfaces:**
- Consumes: everything above.
- Produces: measured before/after numbers appended to this plan, or a bug list.

- [ ] **Step 1: Re-measure the boot preamble against the real vault (read-only)**

Recreate the audit's measurement script at `/tmp/measure-preamble.mts`; it replicates `readBootContext` with the repo's pure modules over the real files. Baseline results from 2026-08-11 are in the table above. Post-Task-1, change the script's session-log line to use the new helper:

```typescript
import { bootFileHead } from "/Users/mariomiletta/Dev Projects/obsidian-exo/src/core/boot-content";
// …
const log = bootFileHead(readFileSync(`${V}/memory/session-log.md`, "utf8"), 600, { fromFirstHeading: true });
const ctx = bootFileHead(readFileSync(`${V}/vault-context.md`, "utf8"), 3500);
const prefs = bootFileHead(readFileSync(`${V}/memory/preferences/preferences.md`, "utf8"), 2500);
```

(Full script skeleton: read the audit commit of this plan or rebuild from `readBootContext`: identity via `compileIdentity` + `AGENT_BLOCKS`, loops via `parseLoopsFile`/`dueLoops`/`activeLoops`, caps 3500/2500/600/1500, final cap 12000. Run with `npx tsx`.)

Expected assertions:
- session-log section now contains **≥ 3** lines matching `^## \[` (baseline: 0);
- session-log section contains no `GENERATO` and no `created_by:`;
- vault-context / preferences sections contain no `created_by:`;
- total ≤ 12,000.

Record the actual numbers.

- [ ] **Step 2: Build and deploy**

Run: `pnpm build` (typecheck + esbuild; deploys `main.js` into the live vault plugin dir). Confirm Exo is idle in Obsidian, then reload the plugin, via Obsidian UI or:

```bash
obsidian-cli plugin reload exo
```

(Verify the exact subcommand with `obsidian-cli --help`; do not assume.) **Never reload mid-turn.**

- [ ] **Step 3: Verify the live boot preamble**

Record current settings first (read-only): `python3 -c "import json; d=json.load(open('/Users/mariomiletta/Vaults/marioverse.ai/.obsidian/plugins/exo/data.json')); print({k:d.get(k) for k in ['injectContextContent','debugContext']})"` → baseline was `{injectContextContent: False, debugContext: False}`.

Open a **new** Exo conversation (the preamble is cached per view, a reload resets it) and send a short turn. Then ask Exo: *"What does the 'Recent sessions' section of your boot context contain? Quote its first two lines."* The answer must quote `## [2026-08-…]` session entries, not frontmatter or the GENERATO warning.

- [ ] **Step 4: Verify inline cap + dedup (settings flip WITH restore)**

1. In Exo settings turn ON `injectContextContent` and `debugContext` (record that you did).
2. Open a large note (>6,000 chars, e.g. `_system/vault-context.md` is 9k; opening it for reading mutates nothing) so it becomes the active-context doc.
3. Send turn 1; in the devtools console find the `[Exo][ctx]` line: `content injected:` must list the note, the serialized block must end the note's body with `…[truncated, read "…" for the rest]`, and `outbound bytes` must be bounded (~6.3k + message, not ~9.2k).
4. Send turn 2 in the same conversation without touching the note: the `[Exo][ctx]` serialized block must show `- <path> (content already provided earlier in this conversation)` and a much smaller `outbound bytes`. Record both byte numbers (the before/after per-turn delta).
5. Edit the note is NOT allowed (real vault), mtime-invalidation is covered by unit tests; skip the live edit case.
6. **Restore** `injectContextContent` and `debugContext` to their recorded values (baseline: both OFF).

- [ ] **Step 5: Confirm proactive recall untouched**

In the same session, send a message that should recall (e.g. mention a topic known to be in the store). The "N memories recalled" affordance must still appear and the diag line `recall injected N` must still fire, this task changed nothing on that path; this is the regression tripwire.

- [ ] **Step 6: Record results**

Append a `## Verification` section to this plan file with the real numbers from Steps 1, 3, 4 (before/after outbound bytes, preamble section sizes, entry counts) and anything that failed. Do not commit the plan (gitignored); it is the working record.

---

## Self-Review

**What the audit confirmed vs the bb pattern, and what this plan deliberately does NOT do:**

- **Proactive recall is already stricter than bb** (800-char per-turn list budget vs bb's 3,900-char standing catalog; per-convo dedup; relevance floor; send-commit stamping). Untouched.
- **The rules section is already a bb catalog** (13 titles + "read the file for detail"). Untouched.
- **On-demand deep reads already exist** (`recall` with `as_of`, `remember`, the `mcp__obsidian__*` read tools). **No new tools, no new store, no new index**; adding any would duplicate existing read paths, the exact wrong shape named in the brief.
- **Not shrinking the ~12k boot preamble toward bb's 3,900.** It rides the system prompt once per session and is prompt-cached; identity + vault-context + preferences are the always-relevant layer, and the measured total (11,932) sits under its cap. Trading real signal for a marginal cached-token saving is a loss. The calibration instead makes every one of those chars carry signal (Task 1).
- **Ambient selection stays unbounded.** Capping it would break the display-state = send-state contract this module exists to enforce (the chip shows the char count; the user chose the selection). Noticed, not touched.
- **`listAgentBrains`' silent `slice(0, 8000)`** (`src/core/capability-desc.ts:199`) is a parse-time bound on brain files, not a per-turn injection; out of scope. Noticed, not touched.
- **`ExoView.memoryPreamble` is cached for the view's lifetime**, so boot-context edits don't reach an already-open view until reload. Staleness, not tokens; out of scope. Noticed, not touched.

**Spec coverage:** map-what's-injected-with-real-numbers → Baseline table (measured, not estimated); confirm/reject the candidate findings → confirmed: boot slice carrying zero signal (Task 1), unbounded full-content injection (Task 2), per-turn repeat not covered by `injectedMemoryIds` (Task 3, checked: that set covers only memory entries); rejected: missing on-demand read tool (exists), missing hard cap on the preamble (exists, with marker, at 12,000); per-turn char delta stated on every task; pure logic in `src/core/` with tests, `view.ts` wiring only under the ratchet; real-vault safety (read-only measurement, settings flips recorded and restored, no memory-file writes, no mid-turn reload).

**Known unverified seams** the implementer must check rather than assume: the exact assertions of the "halves the session-log slice" test in `tests/boot-context-seam.test.ts` (may pin lengths the new trim shifts); whether `vitest` picks up `src/core/context-assembly.test.ts` colocated (it does today, confirm before relying on new tests there); the exact `obsidian-cli` plugin-reload subcommand; whether `f.stat.mtime` is populated for every `TFile` the composer can attach (a `0`/`undefined` mtime must degrade to "changed" (i.e. re-inline), never to "unchanged"); the current real line count of `view.ts` against the 6,600 ratchet at implementation time; and the live values of `injectContextContent`/`debugContext` before flipping them (baseline recorded 2026-08-11: both OFF).

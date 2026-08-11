# Codex Question-Flow Parity — Verification & Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Codex conversation can ask Mario a structured clarification question, render the same ask card the Claude path renders, block until answered, and receive the answer — with the same stop/teardown posture. Modeled on bb's `ask-user-question` plugin (`/tmp/bb-analysis/plugins/ask-user-question/`), which reimplements Claude Code's `AskUserQuestion` so every provider gets the same blocking clarification UX.

**Architecture:** No new feature surface. The investigation (below, stated as verified fact) found the parity **already implemented** across three routes that all land on the same `askBridge` → `renderAskCard` path. What is missing is (a) tests on the seams a plausibly-broken edit would silently pass, (b) a pin on the one config value the whole posture hangs on (`tool_timeout_sec=3600`), and (c) any live verification on a real Codex session. This plan therefore collapses — honestly — to two small pure-module extractions (which also buy back view.ts ratchet headroom), a regression net, and a live verification task. No behavior changes.

## Verified current state (read from `main`, 2026-08-11)

**The tool is registered for Codex, with the answer path wired end-to-end:**

- `ask_user` is defined in `src/obsidian/tools.ts:510-540`. Handler: no `askBridge` → "No user is present (headless run)"; bridge resolves → `ok(JSON.stringify(answers))`; bridge rejects → `ok("User dismissed the question…")` — a normal result, **never** `isError` (tools.ts:531-539).
- It is unconditionally in the registration list (`tools.ts:1419`) — not gated by any flag.
- The Codex session builds the same tool array with `askBridge: (qs) => this.askBridge(c, qs)` per-convo (`src/view.ts:811-824`) and hands it to a **per-session, isolated** loopback executor (`main.ts:2423-2451` — `ensureCodexBridge` starts a fresh `startCodexBridge()` per call; no shared-singleton clobbering between parallel sessions).
- Read-only sandbox (`codexSandbox === "read-only"`) filters to read tools **plus `ask_user` explicitly** (`view.ts:825-830`): `readOnlySandbox ? all.filter((t) => READ_BASENAMES.has(t.name) || t.name === "ask_user") : all`. This is the right call and stays: bridge writes bypass codex's sandbox so writes must be filtered, but `ask_user` mutates nothing — blocking the turn on a question card is user interaction, not a write.
- The whole timeout chain is already hardened for a human-scale block:
  - Obsidian-side HTTP server: `server.requestTimeout = 0` with the comment "ask_user can legitimately wait minutes for the human — never time out" (`src/obsidian/codex-bridge.ts:69-71`).
  - The stdio script codex spawns uses hand-rolled `node:http` with `req.setTimeout(0)`, **specifically because** undici's hidden 300s `headersTimeout` killed answers given after 5 minutes (`src/obsidian/codex-bridge-script.ts:1-9, 43`).
  - The MCP server registration passes `tool_timeout_sec=3600` (codex's default is 60s) (`src/providers/codex-app-server.ts:257-262`).
- Codex emits bridged tool calls as `mcp__${server}__${tool}` → `mcp__obsidian__ask_user` (`codex-app-server.ts:699-704`), which is exactly the name `view.ts:5710` and `view.ts:5872` special-case — so the generic tool chip is suppressed and no permission card is raised for it, same as Claude.

**Two additional native Codex ask routes are wired to the same card:**

- `item/tool/requestUserInput` server requests (`codex-app-server.ts:460-498`) and `mcpServer/elicitation/request` (`codex-app-server.ts:500-511`) both call `opts.requestUserInput`, which view.ts:858-863 routes to the same `askBridge`. Adapter behavior is unit-tested (`tests/codex-session.test.ts:316-389`).
- `renderAskCard` (`view.ts:4670-4843`) already handles the native-question extras: `secret` renders a masked input (`view.ts:4801`), zero-option questions fall through to the "Other…" free-text row, and single-question cards resolve on Enter (`view.ts:4806-4814`).

**Stop/teardown posture is provider-agnostic** (lives on `Convo`, not on an adapter):

- Stop cancels the open card: `c.pendingAsk?.()` (`view.ts:5182-5183`) → `askBridge` rejects → the tool returns the dismissal result → codex receives a normal tool result while the turn is interrupted.
- Turn teardown also cancels (`view.ts:6258-6263`), and `c.currentCtx = null` makes late `ask_user` calls reject cleanly.
- The idle watchdog is suspended while an ask card waits (`docs/architecture.md:51`).

**Fan-out already follows from the main path.** `renderAskCard` fires `emitConvoState(c.id, "needs-input", { reason: "ask" })` (`view.ts:4706`) regardless of provider; `deriveLane` maps `pendingAsk` → `needs-input`/`ask` with precedence over `streaming` (`src/core/session-cards.ts:103-110`); the driver's `outcomeFromState` reports `blocked` to the parent (`src/core/child-reports.ts`, tested). A Codex child spawns its session through the same `spawnSession` (`view.ts:723`) that wires the bridge, so a Codex child asking a question surfaces in the sidebar and the board's needs-input lane exactly like a Claude child. Nothing to wire — but it has never been seen live, so the final task exercises it.

**Claude path, for reference:** the built-in `AskUserQuestion` is aliased to `mcp__obsidian__ask_user` via `toolAliases` (`src/providers/claude.ts:280-295`), so both providers converge on one tool and one card.

**The actual gaps (all verification-shaped, none functional):**

1. The read-only-sandbox filter is untested inline view.ts logic. Delete `|| t.name === "ask_user"` and nothing goes red.
2. The `requestUserInput` header→id answer mapping (`view.ts:858-863`) is untested inline logic.
3. No test pins `tool_timeout_sec=3600` — a regression to codex's 60s default would silently kill every answer Mario takes more than a minute to give. `tests/codex-session.test.ts:533-541` tests bridge release, not the spawn args.
4. The `ask_user` handler contract (dismissal is a normal result, never `isError` — a poisoned-turn hazard on Codex) has no test; neither does the no-timeout posture of the bridge chain.
5. Zero live verification of the bridged `ask_user` on a real Codex session, and none of the fan-out child scenario.

**Deliberate divergence from bb, documented not fixed:** bb's plugin has an away-from-keyboard timeout that returns "No response after Ns — proceed using your best judgment" (`/tmp/bb-analysis/plugins/ask-user-question/src/tool-definition.ts`, `buildTimeoutMessage`). Exo's posture is: block indefinitely (watchdog suspended), cancel on Stop or turn teardown; on Codex there is additionally the 3600s engine-side ceiling. This is a better fit for a persistent sidebar (the "pending interaction" is already surfaced by the needs-input lane, the sidebar row, and the `notifyOnce` OS notification at `view.ts:4680` — bb's pending-interaction banner concept, already built). No AFK timeout is added.

## Global Constraints

- Test runner: `pnpm test` (vitest). Typecheck: `pnpm typecheck`. Lint: `pnpm lint`. Full gate: `pnpm release:check`.
- **Zero ratchet headroom.** `src/view.ts` is at exactly 6600/6600 lines and `src/main.ts` at 3480/3480 (`tests/size-contract.test.ts`). Every task that touches view.ts must be net-negative there; main.ts is not touched at all. Never raise a ceiling.
- New logic goes in pure modules under `src/core/` with **no Obsidian imports**. `view.ts` gets thin wiring only.
- **Byte-identical tool lists.** No new gating is introduced. The Task 1 extraction must return the *same array reference* on the non-read-only path, and a test pins that.
- Tests are judged by mutation: for each test, ask "would a plausibly-broken implementation pass?" — the specific mutations each task targets are named in its steps.
- Commit after each task, on `main` (house rule for the Obsidian repos: no PRs; release via bump/tag later, not in this plan). Stage explicit paths only.
- Do **not** commit this plan file.
- The live-verification task runs against Mario's **real vault**. The CLI binary is `obsidian-cli` (the `obsidian` on PATH is the app). `pnpm build` deploys `main.js` into the live vault via `.obsidian-plugin-dir` — never reload the plugin while a turn is in flight, and restore every setting touched.

---

### Task 1: Extract the Codex sandbox toolset filter into core (pure)

The read-only filter — including the deliberate `ask_user` carve-out — moves out of view.ts into a tested pure module. Behavior is identical; view.ts shrinks.

**Files:**
- Create: `src/core/codex-toolset.ts`
- Create: `tests/codex-toolset.test.ts`
- Modify: `src/view.ts` (replace the inline filter at 825-830 with one call; net −4 lines)

**Interfaces:**
- Consumes: nothing (generic over `{ name: string }` — no SDK or Obsidian imports).
- Produces: `codexSessionToolset<T extends { name: string }>(all: T[], readOnlySandbox: boolean, readToolNames: Iterable<string>): T[]`

**Mutations this must catch:** dropping the `ask_user` carve-out; filtering (or copying) the array when the sandbox is not read-only (byte-identical discipline); forgetting the `mcp__obsidian__` prefix strip so the read set never matches.

- [ ] **Step 1: Write the failing test**

Create `tests/codex-toolset.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { codexSessionToolset } from "../src/core/codex-toolset";

const READ = new Set(["mcp__obsidian__search_vault", "mcp__obsidian__read_note"]);
const tools = [
  { name: "search_vault" },
  { name: "read_note" },
  { name: "create_note" },
  { name: "ask_user" },
];

describe("codexSessionToolset", () => {
  it("returns the input array ITSELF when the sandbox is not read-only", () => {
    // Reference equality on purpose: the tool list sent to sessions must stay
    // byte-identical when no gating applies — a defensive copy would already
    // be drift surface.
    expect(codexSessionToolset(tools, false, READ)).toBe(tools);
  });

  it("keeps only read tools in a read-only sandbox", () => {
    const names = codexSessionToolset(tools, true, READ).map((t) => t.name);
    expect(names).toContain("search_vault");
    expect(names).toContain("read_note");
    expect(names).not.toContain("create_note");
  });

  it("keeps ask_user in a read-only sandbox even though it is not a read tool", () => {
    const names = codexSessionToolset(tools, true, READ).map((t) => t.name);
    expect(names).toContain("ask_user");
  });

  it("matches read names by basename (the read set carries the mcp__obsidian__ prefix)", () => {
    // A broken prefix strip would filter EVERYTHING out in read-only mode.
    expect(codexSessionToolset(tools, true, READ).length).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/codex-toolset.test.ts`
Expected: FAIL — cannot resolve `../src/core/codex-toolset`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/codex-toolset.ts`:

```typescript
/**
 * Codex session toolset — the pure half of the Codex ↔ Obsidian bridge's
 * sandbox honesty (no Obsidian imports).
 *
 * Bridge tool handlers run in the Obsidian process and BYPASS codex's own
 * sandbox, so a read-only sandbox must get read tools only. `ask_user` is the
 * deliberate exception: it mutates nothing — blocking the turn on a question
 * card is user interaction, not a write — and a read-only session that cannot
 * ask a clarifying question would be needlessly dumber than its Claude twin.
 *
 * When the sandbox is not read-only, the input array is returned AS-IS (same
 * reference): the tool list sent to sessions stays byte-identical to a build
 * where this function is not in the path.
 */

/** Interaction tools that stay in a read-only sandbox besides the read set. */
const INTERACTION_TOOLS = new Set(["ask_user"]);

const MCP_PREFIX = "mcp__obsidian__";

export function codexSessionToolset<T extends { name: string }>(
  all: T[],
  readOnlySandbox: boolean,
  readToolNames: Iterable<string>
): T[] {
  if (!readOnlySandbox) return all;
  const readBasenames = new Set(
    [...readToolNames].map((n) => (n.startsWith(MCP_PREFIX) ? n.slice(MCP_PREFIX.length) : n))
  );
  return all.filter((t) => readBasenames.has(t.name) || INTERACTION_TOOLS.has(t.name));
}
```

- [ ] **Step 4: Wire view.ts (net-negative)**

In `src/view.ts`, replace lines 825-830:

```typescript
        const READ_BASENAMES = new Set(
          [...OBSIDIAN_READ_TOOLS].map((n) => n.replace("mcp__obsidian__", ""))
        );
        b.bridge.setTools(
          readOnlySandbox ? all.filter((t) => READ_BASENAMES.has(t.name) || t.name === "ask_user") : all
        );
```

with:

```typescript
        b.bridge.setTools(codexSessionToolset(all, readOnlySandbox, OBSIDIAN_READ_TOOLS));
```

Add `codexSessionToolset` to the imports (new import line from `./core/codex-toolset`). If `OBSIDIAN_READ_TOOLS` was imported solely for this block, keep the import — it is still the argument. Net: −4 lines in view.ts.

- [ ] **Step 5: Run tests, typecheck, and the ratchet**

Run: `pnpm vitest run tests/codex-toolset.test.ts tests/size-contract.test.ts && pnpm typecheck`
Expected: PASS, and `src/view.ts` now under 6600.

- [ ] **Step 6: Commit**

```bash
git add src/core/codex-toolset.ts tests/codex-toolset.test.ts src/view.ts
git commit -m "refactor(codex): extract sandbox toolset filter into tested core module"
```

---

### Task 2: Extract the native-question answer mapping (pure)

The `requestUserInput` closure maps card answers (keyed by `header`, as `renderAskCard` resolves them) to the id-keyed record the Codex app-server reply needs. It is four lines of untested logic in view.ts; a broken mapping silently returns empty answers to codex.

**Files:**
- Modify: `src/core/codex-toolset.ts` (add `mapUserInputAnswers` — same module: both functions are the pure half of Codex session wiring)
- Modify: `tests/codex-toolset.test.ts`
- Modify: `src/view.ts` (replace the closure body at 858-863; net −3 lines)

**Interfaces:**
- Consumes: nothing (structural `{ id: string; header: string }` — no import of `UserQuestion` needed, keeping core free of provider imports).
- Produces: `mapUserInputAnswers(questions: { id: string; header: string }[], answers: Record<string, string>): Record<string, string>`

**Mutations this must catch:** keying the result by header instead of id (codex would see no answers — it keys by question id); dropping the `?? ""` default (a skipped question would make `Object.fromEntries` carry `undefined`, and `elicitationContent` / the `requestUserInput` reply shape expect strings).

- [ ] **Step 1: Write the failing test**

Add to `tests/codex-toolset.test.ts`:

```typescript
import { mapUserInputAnswers } from "../src/core/codex-toolset";

describe("mapUserInputAnswers", () => {
  const questions = [
    { id: "q1", header: "Audience" },
    { id: "q2", header: "Tone" },
  ];

  it("keys the result by question id, reading card answers by header", () => {
    expect(mapUserInputAnswers(questions, { Audience: "Founders", Tone: "Direct" })).toEqual({
      q1: "Founders",
      q2: "Direct",
    });
  });

  it("fills an unanswered question with an empty string, never undefined", () => {
    const out = mapUserInputAnswers(questions, { Audience: "Founders" });
    expect(out).toEqual({ q1: "Founders", q2: "" });
  });

  it("questions sharing a header share the answer (codex defaults header to id, so collisions are self-inflicted)", () => {
    const dup = [
      { id: "a", header: "Pick" },
      { id: "b", header: "Pick" },
    ];
    expect(mapUserInputAnswers(dup, { Pick: "yes" })).toEqual({ a: "yes", b: "yes" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/codex-toolset.test.ts`
Expected: FAIL — `mapUserInputAnswers` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/codex-toolset.ts`:

```typescript
/**
 * Map ask-card answers to the id-keyed record a Codex app-server reply needs.
 * The card resolves answers keyed by `header` (that is what the user saw);
 * codex addresses questions by `id`. Missing answers become "" so every id is
 * present in the reply — the app-server's answer shape expects a string per
 * question, and an absent key would be dropped by the reply serializer.
 */
export function mapUserInputAnswers(
  questions: { id: string; header: string }[],
  answers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(questions.map((q) => [q.id, answers[q.header] ?? ""]));
}
```

- [ ] **Step 4: Wire view.ts (net-negative)**

Replace `src/view.ts:858-863`:

```typescript
      requestUserInput: async (questions) => {
        const answers = await this.askBridge(c, questions);
        return Object.fromEntries(
          questions.map((question) => [question.id, answers[question.header] ?? ""])
        );
      },
```

with:

```typescript
      requestUserInput: async (questions) =>
        mapUserInputAnswers(questions, await this.askBridge(c, questions)),
```

Add `mapUserInputAnswers` to the existing `./core/codex-toolset` import from Task 1. Net: −3 lines.

- [ ] **Step 5: Run tests, typecheck, ratchet**

Run: `pnpm vitest run tests/codex-toolset.test.ts tests/size-contract.test.ts tests/codex-session.test.ts && pnpm typecheck`
Expected: PASS (codex-session tests confirm the adapter contract around the mapping still holds).

- [ ] **Step 6: Commit**

```bash
git add src/core/codex-toolset.ts tests/codex-toolset.test.ts src/view.ts
git commit -m "refactor(codex): extract native-question answer mapping into tested core module"
```

---

### Task 3: Pin the `ask_user` handler contract

The handler's three outcomes — answers as JSON, headless degradation, dismissal as a **normal** result — are the tool's whole behavior, and none is tested. The dismissal shape matters doubly on Codex: an `isError` result here has previously poisoned turns (the `item{type:error}` incident), so the "never isError" property gets pinned both directly and through the bridge executor.

**Files:**
- Modify: `tests/obsidian-tools-registry.test.ts` (handler contract — this is the file that owns `buildObsidianTools` behavior)
- Modify: `tests/codex-bridge.test.ts` (the same dismissal through `callBridgeTool`, i.e. exactly what codex receives)

**Interfaces:**
- Consumes: `buildObsidianTools` (existing), `callBridgeTool` (existing).
- Produces: tests only.

**Mutations this must catch:** turning the dismissal into `isError: true`; returning answers as anything but the bridge's JSON; making the headless path throw instead of degrade.

- [ ] **Step 1: Write the failing-or-green tests (they may pass immediately — that is fine, they are regression pins; verify each fails under the mutation it targets by temporarily breaking `tools.ts:531-539` locally, then reverting)**

Add to `tests/obsidian-tools-registry.test.ts`:

```typescript
describe("ask_user handler contract", () => {
  const QUESTIONS = {
    questions: [
      { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
    ],
  };
  type ToolResult = { isError?: boolean; content: Array<{ text?: string }> };
  const askUserOf = (opts?: Parameters<typeof buildObsidianTools>[1]) => {
    const t = buildObsidianTools(app, opts).find((x) => x.name === "ask_user");
    if (!t) throw new Error("ask_user not registered");
    return t;
  };

  it("returns the bridge's answers as JSON", async () => {
    const t = askUserOf({ askBridge: async () => ({ Approach: "A" }) });
    const res = (await t.handler(QUESTIONS, {})) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toBe(JSON.stringify({ Approach: "A" }));
  });

  it("degrades to best-judgment guidance when no bridge is wired (headless)", async () => {
    const res = (await askUserOf().handler(QUESTIONS, {})) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toMatch(/best judgment/i);
  });

  it("reports a dismissal (Stop / teardown) as a NORMAL result, never isError", async () => {
    // isError here would poison the Codex turn — the dismissal is guidance to
    // the model ("proceed"), not a failure.
    const t = askUserOf({
      askBridge: async () => {
        throw new Error("cancelled");
      },
    });
    const res = (await t.handler(QUESTIONS, {})) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toMatch(/dismissed/i);
  });
});
```

Add to `tests/codex-bridge.test.ts` (this file already imports `callBridgeTool`; add `import { buildObsidianTools } from "../src/obsidian/tools";` and `import type { App } from "obsidian";` — the `ask_user` handler never touches `app`, so `{} as App` is safe, same as the registry test):

```typescript
describe("ask_user through the bridge executor", () => {
  it("a dismissal reaches codex as a normal MCP result, never isError", async () => {
    const tools = buildObsidianTools({} as App, {
      askBridge: async () => {
        throw new Error("cancelled");
      },
    });
    const res = await callBridgeTool(tools, "ask_user", {
      questions: [{ question: "Which?", header: "Approach", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toMatch(/dismissed/i);
  });
});
```

- [ ] **Step 2: Verify the mutation coverage, then green**

Run: `pnpm vitest run tests/obsidian-tools-registry.test.ts tests/codex-bridge.test.ts`
Expected: PASS. Then, as a one-time check (not committed): change `tools.ts:537` to return `err(...)` instead of `ok(...)`, re-run, confirm both new dismissal tests go RED, revert.

- [ ] **Step 3: Commit**

```bash
git add tests/obsidian-tools-registry.test.ts tests/codex-bridge.test.ts
git commit -m "test(ask_user): pin the handler contract — answers JSON, headless degradation, dismissal never isError"
```

---

### Task 4: Pin the no-timeout chain

Three independent pieces keep a long-blocked `ask_user` alive on Codex, and none is tested: the `tool_timeout_sec=3600` spawn arg (a silent fallback to codex's 60s default is the single most likely future regression), the script's `node:http`/`setTimeout(0)` posture (already regressed once — `UND_ERR_HEADERS_TIMEOUT`), and the bridge server's willingness to hold a request open. The first two get direct pins; the third gets a real end-to-end slow-handler test through the real bridge + real script at human-plausible scale (1.5s — a unit test cannot wait out a 300s undici timeout, which is what the source-marker assertions are for; the E2E proves the mechanism, the markers pin the implementation choice that makes the long tail safe).

**Files:**
- Modify: `tests/codex-session.test.ts` (spawn-arg pin)
- Modify: `tests/codex-bridge-script.test.ts` (source markers + slow-handler E2E through `startCodexBridge`)

**Interfaces:**
- Consumes: `CodexSession` + `FakeCodexProcess` harness (existing, `tests/codex-session.test.ts:15-106`); `CODEX_BRIDGE_SCRIPT`, `startCodexBridge`, the real-node-child harness (existing, `tests/codex-bridge-script.test.ts:14-53`).
- Produces: tests only.

**Mutations this must catch:** removing/lowering `tool_timeout_sec`; swapping the script back to `fetch`; removing `req.setTimeout(0)`; reintroducing a request timeout on the bridge server short enough to kill a multi-second block.

- [ ] **Step 1: Spawn-arg pin**

Add to `tests/codex-session.test.ts` (module scope already has `CodexSession`, `FakeCodexProcess`, `OPTS`, `vi`):

```typescript
  it("registers the obsidian bridge with a 1-hour tool timeout — ask_user can wait for the human", () => {
    const child = new FakeCodexProcess();
    const spawn = vi.fn(() => child as never);
    const session = new CodexSession(
      { ...OPTS, codexBridge: { port: 4321, token: "tok", scriptPath: "/bridge.mjs" } },
      { spawn, requestTimeoutMs: 500, turnStartTimeoutMs: 500 }
    );
    try {
      const args = spawn.mock.calls[0]?.[1] as string[];
      const override = args.find((a) => typeof a === "string" && a.includes("mcp_servers.obsidian="));
      expect(override).toBeDefined();
      // Codex's per-server default is 60s — that would kill every answer Mario
      // takes more than a minute to give. 3600 is the deliberate ceiling.
      expect(override).toContain("tool_timeout_sec=3600");
      expect(override).toContain('EXO_BRIDGE_PORT="4321"');
      expect(override).toContain('EXO_BRIDGE_TOKEN="tok"');
    } finally {
      session.dispose();
    }
  });
```

Place it inside the existing `describe("CodexSession app-server lifecycle", ...)` block, near the bridge-release test at line 533. If `spawn.mock.calls[0][1]`'s position differs from `(bin, args, opts)`, read the call at `src/providers/codex-app-server.ts:329` and adjust the index — the args array is the second parameter today.

- [ ] **Step 2: Script posture pins + slow-handler E2E**

Add to `tests/codex-bridge-script.test.ts` (add `import { startCodexBridge } from "../src/obsidian/codex-bridge";` and `import { buildObsidianTools } from "../src/obsidian/tools";` is NOT needed — use a minimal inline tool):

```typescript
describe("no-timeout posture", () => {
  it("the script keeps the hand-rolled node:http transport (undici's hidden 300s headersTimeout is the documented regression)", () => {
    expect(CODEX_BRIDGE_SCRIPT).toContain("node:http");
    expect(CODEX_BRIDGE_SCRIPT).toContain("req.setTimeout(0)");
    expect(CODEX_BRIDGE_SCRIPT).not.toContain("fetch(");
  });

  it("a call whose handler resolves only after a human-scale delay still answers, through the REAL bridge and the REAL script", async () => {
    const bridge = await startCodexBridge();
    bridge.setTools([
      {
        name: "ask_user",
        description: "d",
        inputSchema: {},
        handler: async () => {
          await new Promise((r) => setTimeout(r, 1500));
          return { content: [{ type: "text", text: '{"Approach":"A"}' }] };
        },
      } as never,
    ]);
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        EXO_BRIDGE_PORT: String(bridge.port),
        EXO_BRIDGE_TOKEN: bridge.token,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    try {
      const call = await rpc(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ask_user", arguments: {} },
      });
      expect(JSON.stringify(call.result)).toContain("Approach");
      expect(JSON.stringify(call.result)).not.toContain("isError");
    } finally {
      child.kill();
      bridge.stop();
    }
  }, 15_000);
});
```

Note: the file's `rpc` helper has a 5000ms internal timer (`tests/codex-bridge-script.test.ts:40`) — 1500ms fits. The `it` timeout is raised to 15s for slow CI. The empty `inputSchema: {}` is valid: `callBridgeTool` wraps it in `z.object({})`, which accepts `{}`.

- [ ] **Step 3: Run the tests**

Run: `pnpm vitest run tests/codex-session.test.ts tests/codex-bridge-script.test.ts`
Expected: PASS. One-time mutation check (not committed): change `tool_timeout_sec=3600` to `=60` in `src/providers/codex-app-server.ts:262` → the spawn-arg test goes RED; revert.

- [ ] **Step 4: Full gate**

Run: `pnpm release:check`
Expected: lint clean, all tests pass (including both ratchets, now with margin from Tasks 1-2), build succeeds.

- [ ] **Step 5: Commit**

```bash
git add tests/codex-session.test.ts tests/codex-bridge-script.test.ts
git commit -m "test(codex): pin the ask_user no-timeout chain — 3600s tool timeout, node:http script, slow-handler E2E"
```

---

### Task 5: Live verification on a real Codex session (+ fan-out child), with cleanup

**Files:** none (verification only; results recorded in this plan file, uncommitted).

**Interfaces:**
- Consumes: everything above, the running Obsidian instance, the `obsidian-cli` skill.
- Produces: a verified end-to-end question flow on Codex, or a bug list with repro steps.

This is Mario's real vault. Rules: reload only when idle, restore every setting, delete every artifact created. Prerequisites to check before starting: `codex` CLI signed in, `node` on the PATH Exo resolves (otherwise the bridge is skipped with a Notice — `main.ts:2407-2418`).

- [ ] **Step 1: Build and reload**

Run: `pnpm build` (deploys `main.js` to the vault plugin dir). Confirm via `obsidian-cli` that no Exo turn is streaming (no `.mva-ask` card open, no working row), then reload the plugin (follow the obsidian-cli skill; e.g. `obsidian-cli eval "app.plugins.disablePlugin('exo').then(() => app.plugins.enablePlugin('exo'))"`). A reload kills live turns — this is why the idle check comes first.

- [ ] **Step 2: Record and switch provider**

Read and note the current values (restore targets):

```bash
obsidian-cli eval "const s = app.plugins.plugins.exo.settings; JSON.stringify({ provider: s.provider, sandbox: s.codexSandbox, orchestration: s.orchestrationEnabled })"
```

Switch to Codex for the test (verify the exact mutation path against the settings tab first — a per-convo provider switcher in the composer, if present, is preferable to mutating settings):

```bash
obsidian-cli eval "const p = app.plugins.plugins.exo; p.settings.provider = 'codex'; p.saveSettings()"
```

- [ ] **Step 3: The bridged ask_user, end to end**

Open the Exo view, start a **new** conversation (it picks up the provider), and send — via the cross-plugin API — a prompt that forces the tool (not the native path):

```bash
obsidian-cli eval "app.plugins.plugins.exo.askExo('Use the ask_user tool from the obsidian MCP server to ask me exactly one question: which option do I prefer, A or B. After I answer, reply with one sentence naming my choice.', true)"
```

Verify, in order (poll with `obsidian-cli eval` on the DOM; adapt selectors to what is actually rendered):

1. The tool call renders as the **ask card** (`document.querySelector('.mva-ask')` non-null), not a generic tool chip and not a permission card.
2. While the card is open, the conversation is in needs-input: the sidebar row / board card shows the waiting state (this is `deriveLane` reading `pendingAsk` — reason `ask`).
3. Answer by clicking option A: `obsidian-cli eval "document.querySelector('.mva-ask .mva-ask-opt')?.click()"`.
4. The card collapses to the resolved summary (`.mva-ask.is-resolved`), the turn resumes, and the final assistant text names "A" — the answer made the round trip through the loopback bridge into the codex process.
5. Take more than 60 seconds to answer on a second run (repeat the prompt, wait 90s, then click): the answer must still land — this is the live proof of `tool_timeout_sec=3600` over codex's 60s default.

- [ ] **Step 4: Stop posture**

Trigger a third question, and while the card is open press Stop (the composer stop button, or Esc with the view focused). Verify: the card resolves as dismissed (no stuck `pendingAsk` — the sidebar leaves needs-input), the turn ends without a poisoned session, and a follow-up message in the same conversation works normally.

- [ ] **Step 5: Fan-out child on Codex**

Only if orchestration is available; record the flag first (Step 2) and enable it if off. In a Codex parent conversation:

```
Use spawn_task to delegate a child task titled "Ask test": its prompt must instruct it to
immediately use the ask_user tool to ask which colour I prefer (red or blue), and then
reply with the colour I picked.
```

Verify: the child conversation appears in the sidebar (indented under the parent, not in the tab strip); when it asks, it lands in the sidebar's needs-input state and the board's needs-input lane exactly like a Claude child (reason `ask`); opening the child shows the same ask card; answering lets it finish; the parent receives the "waiting for input" and completion reports.

- [ ] **Step 6: Cleanup (mandatory — real vault)**

1. Delete the test conversations (parent, child, and the Step 3/4 chats) via the sidebar/gallery delete path.
2. Remove or archive the "Ask test" entry from the tasks ledger (through the board UI, so the write goes through the shared queue).
3. Restore `provider`, `codexSandbox`, and `orchestrationEnabled` to the values recorded in Step 2, and save settings.
4. Confirm no orphaned codex processes / bridge ports: session disposal releases the per-session bridge (`stop` at `codex-app-server.ts:965-967`); a stray `node .../codex-bridge.mjs` in `ps` after all test convos are closed is a bug — report it.

- [ ] **Step 7: Record results**

Append a `## Verification` section to this plan file with real outcomes per step — including anything that failed, with the exact repro. Do not commit the file.

---

## Self-Review

**Scope coverage:** current state established as verified fact with file:line — header section; end state (same card, same components, blocking, answered, same stop/cancel posture) — already implemented, proven by Tasks 3-5; timeout posture — Task 4 pins all three links plus the >60s live case in Task 5 Step 3.5; read-only sandbox decision — kept and justified (ask_user mutates nothing; blocking UX is not a write), pinned by Task 1's test; byte-identical discipline — Task 1's reference-equality test makes it structural; fan-out interaction — follows from provider-agnostic `renderAskCard`/`emitConvoState`/`deriveLane` (no wiring needed), exercised live in Task 5 Step 5; house rules — all new logic pure and unit-tested, view.ts net −7 lines against a zero-headroom ratchet, main.ts untouched; honest collapse — stated plainly: the plan is verification + regression hardening, not feature work.

**Tests by mutation:** every task names the specific plausible breakages its tests catch; Tasks 3 and 4 include one-time mutation checks (break, confirm red, revert) because those tests may be born green.

**Deliberate non-work:** no AFK timeout (bb divergence documented in the header); no changes to `renderAskCard` (secret masking, zero-option, Enter-resolve already handled); no test for the view-side card itself (`view.ts` has no test harness — a known repo-wide condition, not this feature's debt to pay).

## Known unverified seams

Things the implementer must check live rather than trust from reading:

1. **Late answers past 3600s on Codex.** Assumed: codex abandons the MCP call at `tool_timeout_sec`, the turn ends, and Exo's turn teardown (`view.ts:6258-6263`) cancels the stale card. Not provable from source — if Step 3.5's 90s case works, the 1h edge is accepted as designed behavior without a live 1-hour test.
2. **Whether Codex models reliably choose `mcp__obsidian__ask_user`** when prompted generically (vs. free-text questions or the native `request_user_input`). Step 3's prompt names the tool explicitly to remove model discretion; if the model still refuses, that is a prompt/description finding, not a wiring bug — record it.
3. **Exact Codex app-server event shapes for `mcpServer/elicitation/request`** (`codex-app-server.ts:500-511`): the `requestUserInput` route is unit-tested, the elicitation route's params shape (`elicitationQuestions`/`elicitationContent`) was not verified against a live codex emission in this investigation.
4. **DOM selectors and command ids in Task 5** (`.mva-ask`, `.mva-ask-opt`, the stop button, sidebar needs-input class from `chat-rows`): verify against the running app before scripting clicks; adapt, don't force.
5. **The provider-switch path for a new conversation** (`view.ts:366, 2103` read `settings.provider` at creation): if the composer has a per-convo provider toggle, prefer it over mutating settings and restore accordingly.
6. **`spawn.mock.calls[0][1]` positional assumption** in Task 4 Step 1 matches `runtime.spawn(bin, args, opts)` at `codex-app-server.ts:329` today; re-check if the harness changed.

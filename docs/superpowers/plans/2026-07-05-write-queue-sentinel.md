# Write Queue + Provenance Sentinels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `@user`/`@generated` provenance sentinels to the Memory Union Store, a truth-firewall supersede guard, and a single serialized write queue for all store appends.

**Architecture:** Extend the pure `memory-store.ts` type/format/parse with an optional `source` field (default `user`, emitting a metadata line only for `generated`). Add a pure `guardSupersede` firewall helper. Add a new pure `write-queue.ts` promise-chain serializer. Wire `tools.ts` `remember` through one shared queue instance and surface `@generated` provenance in `recall`.

**Tech Stack:** TypeScript, Vitest, ESLint. No new deps. Obsidian API only in `tools.ts`.

## Global Constraints

- Do NOT bump plugin version — leave `manifest.json` / `versions.json` untouched.
- Do NOT modify vault markdown under `_system/memory/store/`.
- `@user` store files must round-trip byte-identical to today's format (omit the source line for `user`).
- Parsing stays tolerant: unknown/malformed lines never break parsing; missing source → `user`.
- All existing tests keep passing. `npm run typecheck`, `npm run lint`, `npm run test` must all pass.
- `write-queue.ts` is pure TS — no Obsidian imports.

---

### Task 1: Provenance sentinels in memory-store.ts

**Files:**
- Modify: `src/core/memory-store.ts`
- Test: `tests/memory-store.test.ts`

- [ ] Add `MemorySource = "user" | "generated"` and `source: MemorySource` to `MemoryEntry`.
- [ ] `formatEntry`: emit `- source: @generated` ONLY when `source === "generated"` (placed after `session`, before tags/supersedes). Omit for `user`.
- [ ] Extend `META` regex to accept `source`; parse `@generated`/`generated` → `generated`, everything else/missing → `user`.
- [ ] Update test `entry()` factory to default `source: "user"`; add tests: generated round-trip emits the line, user omits it, legacy file (no source line) parses as `user`, malformed source value falls back to `user`.

### Task 2: guardSupersede firewall helper

**Files:**
- Modify: `src/core/memory-store.ts`
- Test: `tests/memory-store.test.ts`

- [ ] Pure `guardSupersede(candidate, existing): { ok: true } | { ok: false; reason: string }`. Rejects when candidate is `generated`, has a `supersedes` target, and that target resolves (by id in `existing`) to a `user` entry. Allows: user→anything, generated→generated, generated→(unknown/missing target).
- [ ] Tests for each branch.

### Task 3: write-queue.ts serializer

**Files:**
- Create: `src/core/write-queue.ts`
- Test: `tests/write-queue.test.ts`

- [ ] `WriteQueue` class with `enqueue<T>(fn: () => Promise<T>): Promise<T>`, strict FIFO, one task at a time, rejected task rejects only its own promise and does not poison the chain.
- [ ] Tests: FIFO order, error isolation, synchronous concurrent enqueue serialization (shared counter proves no overlap).

### Task 4: wire remember + recall

**Files:**
- Modify: `src/obsidian/tools.ts`

- [ ] Instantiate one `WriteQueue` in `createObsidianToolServer`.
- [ ] `remember` stamps `source: "user"` and performs its read+append inside `queue.enqueue(...)`.
- [ ] `recall` appends ` · @generated` to the header line for generated entries.

### Task 5: verify

- [ ] `npm run typecheck && npm run lint && npm run test` — all green. Commit.

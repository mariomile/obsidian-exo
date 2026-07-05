# Spec — Memory Union Store: Provenance Sentinels + Serialized Write Queue

**Date:** 2026-07-05
**Status:** Implemented
**Scope:** `src/core/memory-store.ts`, `src/core/write-queue.ts`, `src/obsidian/tools.ts`

The Memory Union Store (Exo's append-only, verbatim, union memory — see the header
comment in `src/core/memory-store.ts`) gains two guarantees: every entry declares
**who wrote it**, and every append to the store goes through **one serialized
write path** so concurrent writers can never interleave or clobber a monthly file.

---

## 1. Provenance sentinels (`@user` / `@generated`)

Every Memory Union Store entry carries a `source`:

- **`@user`** — Mario's verbatim words / explicit statements. The `remember` tool,
  driven by the user stating a durable preference/fact/decision or correcting the
  agent, produces `@user` entries.
- **`@generated`** — content written autonomously by a background pass (the future
  observer pass or dream pass) that synthesizes memories without an explicit user
  statement.

In the `MemoryEntry` type this is `source: 'user' | 'generated'` (aliased
`MemorySource`). On disk it is a metadata sentinel line inside the entry block:

```
## mem-1720000000000 fact
- at: 2024-07-03T12:00:00.000Z
- session: sess-1
- source: @generated
- tags: pricing

The synthesized memory text.
```

The line is emitted **only for `@generated` entries** (see §2). The `@` prefix is
the human-visible sentinel; the parser accepts the value with or without it.

## 2. Legacy default — no sentinel ⇒ `@user`

Backward compatibility is a hard requirement: **existing store files must remain
valid and unchanged.**

- `parseStoreFile` treats a **missing** `- source:` line as `source: 'user'`.
- A malformed / unknown source value (anything that isn't `@generated` /
  `generated`) also parses as `'user'` — the store is append-only and
  human-edited, so a stray line must never break parsing.
- `formatEntry` **omits** the source line for `'user'` entries. Therefore an
  existing `@user` file round-trips **byte-identical** to today's format; only
  `@generated` entries add the new line.

Round-trip invariant: `parseStoreFile(formatEntry(e)).source === e.source` for
both values.

## 3. Truth-firewall rule

Provenance is asymmetric. A `@generated` entry must **never** overwrite the record
of what the user actually said. Concretely, for supersedence:

| Candidate source | May supersede a `@user` entry? | May supersede a `@generated` entry? |
|---|---|---|
| `@user` | ✅ yes | ✅ yes |
| `@generated` | ❌ **never** | ✅ yes |

- `@user` may supersede **anything** (user corrections are authoritative).
- `@generated` may supersede **only** `@generated`.
- A `@generated` entry may NEVER supersede or contradict a `@user` entry.

Enforced by the pure helper `guardSupersede(candidate, existing)`:

```ts
guardSupersede(candidate: MemoryEntry, existing: MemoryEntry[]):
  { ok: true } | { ok: false; reason: string }
```

It resolves `candidate.supersedes` against `existing` by id. It rejects
(`ok: false`) exactly when the candidate is `@generated`, names a `supersedes`
target, and that target resolves to a `@user` entry. When the candidate has no
`supersedes`, or the target id is unknown/missing, the guard does not block on
this rule (an unknown target already surfaces nothing in recall).

## 4. Single-queue write-path contract

**All appends** to `_system/memory/store/` go through **one in-process serialized
queue** (`WriteQueue`, `src/core/write-queue.ts`). Current writer: the `remember`
tool. Future writers (observer pass, dream pass) MUST enqueue through the same
shared instance so that read-modify-write cycles on a monthly file never
interleave and never clobber each other.

`WriteQueue` is a pure promise-chain serializer (no Obsidian imports):

```ts
class WriteQueue {
  enqueue<T>(fn: () => Promise<T>): Promise<T>
}
```

Contract:

- **Strict FIFO** — tasks execute in enqueue order, one at a time; the next task
  starts only after the previous settles.
- **Result pass-through** — `enqueue` returns the awaited result (or rejection) of
  `fn`.
- **Error isolation** — a rejected task rejects **only its own** returned promise
  and does **not** poison the chain; later tasks still run in order.
- **Concurrent-safe** — many `enqueue` calls fired synchronously run strictly in
  order and never overlap (verifiable with a shared counter that is never > 1
  concurrently).

The `remember` handler performs its full read-existing-file → append-block →
write cycle inside a single `enqueue(...)` closure, so the check-then-write is
atomic with respect to other queued writers.

---

## Acceptance criteria

1. `MemoryEntry.source: 'user' | 'generated'` exists; format→parse round-trips it.
2. Sentinel-less (legacy) files parse as `'user'`; `@user` files stay
   byte-identical.
3. `guardSupersede` blocks generated-supersedes-user, allows the rest.
4. `WriteQueue` is strict FIFO with error isolation, covered by
   `tests/write-queue.test.ts`.
5. `remember` writes through the shared queue and stamps `source: 'user'`; `recall`
   shows `· @generated` for generated entries.
6. `npm run typecheck`, `npm run lint`, `npm run test` all pass; plugin version
   unchanged.

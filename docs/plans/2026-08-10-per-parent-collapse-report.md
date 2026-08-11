# Per-parent collapse — implementation report

**Date:** 2026-08-11 · **Branch:** `main` · **Commits:** `3c43905`, `31f761a`, `0734788`, plus this doc

A conversation that fanned out could only be put away by collapsing the entire
section it sat in. It now carries its own collapse control, on an axis fully
independent of the section one.

---

## 1. The shape of `hasChildren`

`GroupedConvo<T>` (`src/core/child-tree.ts`) gained `hasChildren: boolean`,
decided inside `groupAcrossHomes` where the parent→children buckets already
exist. `ChatRow` (`src/core/chat-rows.ts`) carries it forward via `stampNesting`
(the renamed `stampDepth`, which now stamps both facts in one pass).

The definition is **"does anything render nested UNDER this row in the output"**,
not the structural "does this id appear as someone's `parentConvoId`". Three
consequences, each of them the reason for the choice:

- **Always `false` at depth 1.** The indent is capped at one level, so a
  grandchild renders *beside* its parent, not under it. A control on the middle
  row would promise to hide a row it does not own.
- **`false` for a parent whose only child was anchored away.** A child that is
  running or blocked on the user stays in `Needs you` / `Running` instead of
  nesting (`isAnchored`). Nothing renders under the parent, so a chevron there
  would open onto an empty group.
- **`false` for a parent whose child the query filtered out.** `buildChatList`
  filters before grouping, so a filtered-out child is simply not in the pass.

It is decided once, in the grouping pass, and never re-derived downstream — the
pass is the only place that knows about anchoring and filtering.

`hasChildren` is part of the row signature in `rowModel`, so a chat that gains
or loses children rebuilds its row (adding or removing the control). Whether it
is currently *collapsed* is deliberately **not** in the signature — see §4.

## 2. Settings field and persistence

**`settings.chatsCollapsedParents: string[]`** — conversation ids, defaulting to
`[]` (`src/settings.ts`). A separate list from `chatsCollapsed`, not a shared
one: the two are keyed in different namespaces, so merging them would let a
conversation whose id read `settled` fold the Settled section.

Predicates live next to the section pair in `src/core/chat-list-state.ts`:

| Function | Contract |
|---|---|
| `isParentCollapsed(list, convoId)` | absent = **expanded** — no migration |
| `toggleParentCollapsed(list, convoId)` | returns a **new** array; expanding *filters*, so a duplicate is deduped in one click |
| `collapseChildren(items, list)` | `{ hidden: Set<id>, counts: Map<id, n> }` for one painted list |

The section pair and the parent pair now share one implementation
(`isCollapsed` / `flipCollapsed`), so the two contracts cannot drift apart.

`collapseChildren` reads the collapse **positionally**, not by walking
`parentConvoId`, and that is the point: the tree is flattened to one indent, so a
grandchild's own parent is a depth-1 row while the row it must disappear *with*
is the depth-0 one above them both. The rendered run — a depth-0 row followed by
every depth-1 row up to the next depth-0 row — *is* the subtree, by construction
in `groupAcrossHomes`. Sections are concatenated into a single call: every
section begins at depth 0, so a new section's first row closes the previous run.

Written on the gesture (`toggleParent` → `saveSettings()`), not on a later save.
A stale id (conversation deleted or archived since) is never consulted again, so
the list needs no pruning pass.

## 3. Isolating the click target from row-open

The row itself is `clickable(row, () => revealConversation(r.id))`. The control
is a **separate** `clickable` span inside it whose handler calls
`e.stopPropagation()` first.

`stopPropagation` is load-bearing for **both** gestures, not just the mouse:
`clickable` wires `click` *and* `keydown` (Enter/Space) with the same handler, and
both bubble to the row's identical pair. Without it, folding the children would
also open the chat.

It is a `div`/`span` made operable by `clickable` (`role="button"`, `tabindex=0`,
Enter/Space, `aria-expanded`), never a `<button>` — the trap already documented
on the section header: Obsidian's `button:not(.clickable-icon)` out-specifies a
single-class rule and strips the layout out from under it. The `aria-label` names
the hidden count (`Show 3 nested chats` / `Hide nested chats`), because the count
and the rotation are the whole of the sighted channel.

### Placement — trailing, not leading

The control **trails the title**, before the age, in both densities. A leading
disclosure chevron is the more conventional choice and it was rejected on this
file's own standing rule: *"Markers trail the title, never precede it: a leading
icon shifts the title right on exactly the rows that have one, so the column
breaks on the few rows and holds on the many."* The left gutter is also already
fully spent — 6px inset + a 10px status-dot box + 4px of air — so a leading
chevron would either collide with the dot or push every title right by 14px.

Visually subordinate to the section chevron by three channels at once: **10px vs
12px**, `--text-faint` vs the header's own colour, and a different position
entirely (inline at the row's right edge vs leading a full-width header with a
hairline rule). The rotation transition is `mva-chats-group-chevron`'s pattern
reused, not a second one, and it is added to the existing
`prefers-reduced-motion` block alongside it.

### Collapsed count

Shown inline in the control, between the chevron and the age (`> 3  18h`), and
**only while collapsed** — the same rule the section headers already follow, via
the same `:empty { display: none }` idiom. Expanded, the rows are right there and
the number is noise. This is what keeps "put these away" from being the same
gesture as "forget these exist".

## 4. Interaction with DOM reconciliation

Hiding is a **class on the element `reconcileList` already settled**
(`.is-kid-hidden` → `display: none`), applied by `applyChildCollapse` in a pass
right after reconciliation — never a shorter model list, never a rebuild:

- Expanding pays for no rebuild of rows that never left the DOM.
- The collapsed flag stays **out** of the row signature, so pressing Enter on the
  control cannot rebuild the element the focus is sitting on.
- `display: none` also removes the row from the accessibility tree, so nothing is
  hidden from the eye and left in the reading order.

The pass indexes `list.children` rather than querying: after reconciliation the
children *are* `spec.items` in order, by construction.

`collapseChildren` is resolved **once per paint**, over every section at a time,
and the same result feeds both the DOM pass and `this.order` (the arrow-key
axis) — two passes over the same rule is how a renderer and its keyboard axis
stop agreeing about what is on screen.

## 5. Can a collapsed group outlive its parent?

**No, and it is confirmed rather than assumed.** `buildChatList` applies the
query filter *before* grouping, so a parent that a search filtered out is not in
`present` at all and its children are promoted to roots at depth 0
(`effectiveParent` → `undefined`). Same for an archived or deleted parent. The
identical rule covers section relocation: a child is emitted into *the parent's*
home, so the two can never land in different sections.

The only remaining case is a stale id in `chatsCollapsedParents` for a
conversation no longer on screen — harmless, because `collapseChildren` only ever
asks about ids it is currently walking. Covered by a test
(`ignores a collapsed id that is not on screen`).

Only depth-0 rows can carry the control, enforced at the model layer
(`hasChildren` is false at depth 1), not by a renderer check.

## 6. Verification

```
pnpm test       138 files, 2246 tests, 0 failures
pnpm typecheck  clean
pnpm lint       0 errors, 8 warnings (all pre-existing)
```

Size contract: `view.ts` **untouched** by this feature (6591 / 6600),
`main.ts` untouched (3480 / 3480), `settings.ts` 1338 / **1340** (ceiling
*lowered* from 1343 — see §8).

### Mutation check

Every new test was run against a deliberately broken implementation. Six
mutations, all caught:

| Mutation | Tests failed |
|---|---|
| parent never marked `hasChildren` | 9 |
| depth-1 row marked (grandchild chain) | 2 |
| `collapseChildren` hides every child unconditionally | 5 |
| run never closes at a new depth-0 row (section bleed) | 3 |
| toggle removes one match instead of deduping | 1 |
| absent state means *collapsed* (no-migration broken) | 1 |

### Live verification

`pnpm build` → `obsidian-cli plugin:reload id=exo` → `dev:errors` clean, before
and after.

The two real parent/child pairs in the vault (`c199`→`c200`,
`c202`→`c203`, E2E probes from the fan-out session earlier the same day) were
temporarily un-archived to surface them in the sidebar.

**Expanded** (`/tmp/crop-expanded.png`): both parent rows carry a small `⌄`
between the title and the age; their children sit indented beneath them with
**no** control of their own; the `SETTLED` header's own chevron is visibly larger
and sits at the far left leading a full-width rule. The two read as different
things at a glance.

**Collapsed** (`/tmp/crop-collapsed.png`, after a real dispatched click on
`c199`'s control): the chevron rotated to `>`, the count `1` appeared between it
and the age, the child row vanished and `Task residui post-release` closed up
behind it. `Test E2E board-closed` was **completely unaffected** — still `⌄`, no
count, `PONG` still nested under it.

Measured in the same session:

| Check | Result |
|---|---|
| toggle rendered only on parent rows | 2 toggles / 2 parents / 56 rows |
| click on the control | `chatsCollapsedParents: ["c199"]`, `activeTabId` and `openTabIds` **unchanged** — the chat did not open |
| click on the row body (`.mva-chats-name`) | opened `c199`, collapse state unchanged |
| Enter on the control | expands, chat does not open |
| Space on the control | collapses again |
| collapse the `SETTLED` section | `chatsCollapsed: ["settled"]`, `chatsCollapsedParents` untouched |
| re-expand the section | parent **still** collapsed, count still `1`, sibling's child still visible |
| arrow-key axis (`view.order`) | excludes the hidden child, keeps the visible one |
| `aria-expanded` | `true` expanded / `false` collapsed |

### Live-vault cleanup

Mario's real vault, so everything was put back:

- `_system/orchestration/tasks.md` backed up to `/tmp/tasks.md.bak` before the
  probe and `diff`-verified **identical** afterwards (it was never written to —
  no `spawn_task` was needed, since real parent/child pairs already existed).
- All four probe conversations re-archived (`c199`, `c200`, `c202`, `c203`).
- `chatsCollapsedParents` and `chatsCollapsed` cleared back to `[]`.
- The `c199` tab that the row-body-click test opened was closed and
  `activeTabId` restored to `c204`; `openTabIds` matches the pre-test snapshot
  exactly.
- `dev:errors` clean at the end.

## 7. Concurrency hazard hit during this work

Another agent session was working in the **same** working tree and ran a
`git stash` / `git stash pop` cycle mid-edit (reflog: `reset: moving to HEAD`).
It silently reverted three source files for about a minute before restoring them
— and restored them *staged*. It also had `src/view.ts` and
`src/ui/convo-types.ts` staged throughout.

Mitigations used, worth repeating: commit in small units as soon as each layer is
green (a commit is the only thing a `reset --hard` cannot take), and stage/commit
with **explicit pathspecs** (`git commit -- <paths>`) so another session's staged
files are never swept into your commit.

## 8. Incidental: the size ratchet on `settings.ts`

`src/settings.ts` sat at its ceiling **exactly** (1343/1343), so adding a single
persisted preference turned the suite red — and a `MVASettings` key has no other
file it can live in, which is the escape the contract otherwise assumes.

Rather than raise the ceiling (which the contract forbids), `BACKGROUND_MODEL_OPTIONS`
moved to `src/core/model-options.ts` — a product catalogue of which models may
run a background pass, parked in a UI file, next to the module that already owns
the model-picker catalogue and the `ModelOption` type it was restating
structurally. 1348 → 1337 real lines, ceiling **lowered** 1343 → 1340 with a
3-line stated margin, following the reasoning the contract already applies to
`view.ts` and `main.ts`.

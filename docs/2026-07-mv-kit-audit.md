# mv-kit audit — Exo (coherence wave)

Audit of `styles.css` (5168 lines), `src/ui/` (22 files) and `src/settings.ts`
(1394 lines) against `obsidian-cosmos-theme/docs/mv-kit.md` — the golden rule
plus all 5 sections, **desktop and phone columns both**. Program context:
`obsidian-cosmos-theme/docs/2026-07-24-suite-coherence-design.md`.

Scope: coherence only (radius / type / icons / motion tokens / empty states /
microcopy). No layout redesign, no DOM restructure, no bulk normalization —
per the design doc's §C/D non-goals.

**Verdict vocabulary**

| Verdict | Meaning |
|---|---|
| **pass** | Compliant at HEAD. Nothing to do. |
| **FIX** | A real kit MUST is unmet. The exact proposed change is written out in the row; it is applied in the NEXT step, not here. |
| **waived** | The rule does not apply here, or applying it would exceed the coherence-only boundary. Reason always given, never silence. |

**The commit carrying this audit is documentation-only** — it stages
`docs/2026-07-mv-kit-audit.md` and nothing else, and no CSS or TS changed while
this revision was written. It is *not* true that nothing changed since the
pinned baseline `e0eb74d`: five code commits landed before this document was
written, and the audit grades the tree as it stands at HEAD. See "State of the
tree" below, which names them and their effect on every **pass** they produced.

---

## Platform premise — Exo is desktop-only

`manifest.json` line 9: `"isDesktopOnly": true`. Exo depends on Node builtins
through the Agent SDK and never loads on iOS/Android; `styles.css` contains
zero `.is-mobile` / `.is-phone` / `pointer: coarse` selectors (one
`body:not(.is-mobile)` guard at line 39, which exists to *exclude* the mobile
branch, not to style it).

Consequence for this audit: every phone-column MUST in the kit
(§2 `--cosmos-touch-min`, §2 phone micro-label size, §3 `--cosmos-press-scale`,
§3 the three phone entrance recipes, §4 the phone-shipped recipes) is
**structurally unreachable** — there is no phone surface for the rule to
govern. Those rows carry an explicit **waived, N/A (desktop-only)** verdict, and
**every phone cell in every table below states its own reason** — why *that*
rule cannot bite on phone — rather than a bare "N/A". Zero bare N/A cells
remain: `grep -c '[|] N/A [|]'` over this file returns **0** — zero table cells
and, because the command is written with its pipes in bracket form, zero
self-matches from the sentence printing it. (Same device as the
comment-terminator check in §0, for the same reason: a document that prints a
command must not be falsified by its own text. An earlier revision printed this
one with bare pipes, claimed 0, and returned 1 — itself.) The reasons are
not all the same: some rules
are platform-independent by construction (a truncated CSS comment, a `:root`
redefinition), some carry the same value on both of the kit's columns (radius
tiers, `--mv-t`), and some are pointer-only states (hover) with no phone analogue
at all. Those are three different kinds of N/A and they are distinguished
row by row.

**The one exception, per the kit's own wording:** §3's
`prefers-reduced-motion: reduce` MUST is platform-independent ("respected on
both desktop and phone… on every surface"). It is audited as a live rule, not
waived — see §3, where all **13** blocks implementing it are enumerated with
their roles.

---

## State of the tree at audit time

This repo already carries part of the coherence wave. Commits between
`e0eb74d` (the pinned baseline, untouched by this step) and HEAD that changed
audited files:

| Commit | Effect on audited surface |
|---|---|
| `2c660fa` | Cosmos elevation/radius/duration consumption with literal fallbacks (10 sites) |
| `0be8ea7`, `d6bb132` | English microcopy sweep (Connections pane, cockpit, main, queue) |
| `7af553f` | Reverted a `setIcon` swap in the Connections pane (DOM change, out of scope) |
| `52efeb6` | Turn-entrance tokenization + the blanket reduced-motion block extended to `.mva-settings-tab` and `.exo-mention-popover` |

**Provenance, stated plainly** (an earlier revision of this file claimed
`bc530e2` and `1aa6a9c` came from prior sessions; the reflog shows otherwise and
that claim is withdrawn): every commit in `e0eb74d..HEAD` was created in the same
continuous working stream as this audit. Concretely, the CSS and TS fixes above
were applied **first**, and this document audits the corrected tree — it is not
an audit of `e0eb74d` frozen in time. The doc's stated baseline is therefore
current HEAD, whose real numbers are **5168 lines / 50 hex / 7 `ms` hits of which
6 raw / 6 `!important`**, not the `e0eb74d` figures (5154 / 49 / 6). `e0eb74d`
itself is untouched and nothing has been pushed.

`bc530e2`, `1aa6a9c` and the current commit are three successive revisions of
this one file. They are left unsquashed on purpose: squashing across the five
interleaved code commits (`2c660fa`, `0be8ea7`, `52efeb6`, `7af553f`, `d6bb132`)
would rewrite their hashes for no reviewable gain. Whether "exactly one atomic
commit" is read per-run or per-step is the orchestrator's call; this section
exists so the call is made on facts rather than on a claim.

So a **pass** below sometimes means "compliant at HEAD because an earlier
commit in this wave closed it", not "was always compliant". Where that is the
case the row says so and names the line. Every **FIX** below is genuinely open
at HEAD and was re-verified against the working tree, not inherited from an
older doc.

---

## File-coverage note

### `styles.css` — 5168 lines, 100% covered

Walked section by section using the file's own banner comments as the unit of
work. **59 ranges**, contiguous and exhaustive (1 → 5168, no gaps, no overlaps).

Every one of the 13 `prefers-reduced-motion` blocks is named in the row whose
range contains it, so the coverage note and the §3 enumeration agree line for
line.

| Lines | Section | Findings raised |
|---|---|---|
| 1–59 | File header, `:root` geometry/timing tokens, `.mva-root`, focus rings | §1 (`--mva-r1`), golden rule |
| 60–112 | Header + brand mark | — |
| 113–231 | List / tab bar | — |
| 232–255 | Per-tab agent count | §3 (spin loop, 253) |
| 256–419 | Chat column + Recap Rail | §1 (shadow 307), §4 (recap-empty 336), §2 (eyebrows 323/331) |
| 420–509 | Live current-activity row | §1 (shadow 477), §3 (pulse 437), §3 reduced-motion ×2 (459 `.mva-recap-row`/`.mva-recap-more`; 491 `.mva-jump-pill`, which *narrows* rather than zeroes) |
| 510–545 | Reading column, bottom-anchored flow, turn entrance | §3 (turn entrance 533 — closed) |
| 546–631 | Proactive-recall affordance | §3 reduced-motion (625 `.mva-recall-header`/`.mva-recall-caret`) |
| 632–709 | Rethink diff + persona/now proposal card | §2 (eyebrow 651) |
| 710–818 | Incremental streaming blocks | §3 (pulse 890 group is below; 863/869 here) |
| 819–877 | Todos | §2 (eyebrow 832) |
| 878–898 | Thinking dots | §3 (loop 890, phase offsets 893/896) |
| 899–1052 | Composer: agents chip, agents list, unified input box | §1 (popover shadow 964, radius fallbacks 963/973), §2 (eyebrow 990) |
| 1053–1131 | Autocomplete popover | §1 (shadow 1065) |
| 1132–1153 | Toolbar icon buttons | — |
| 1154–1353 | Toolbar selectors (chip + popover), risk colouring, tune dialog, permission dot | §1 (shadow 1244), §2 (eyebrow 1330), hex block |
| 1354–1526 | Context strip + note/selection cards | `!important` (1466) |
| 1527–1671 | Message actions, expand affordance, send button | §3 (height transition 1636), §3 (blink 1566) |
| 1672–1828 | Empty state / chat welcome hero | §3 (entrance 1687–1689, breathe 1719), §3 reduced-motion (1758 `.mva-empty-star::before`), §2 (eyebrow 1778), §4 (hero) |
| 1829–1919 | Assistant body | — |
| 1920–2321 | Tool card, steps timeline, touched-notes footer, subagent activity | §2 (eyebrow 2224), §3 (spin 1952, pulse 2047, shimmer 2171) |
| 2322–2358 | Diff | — |
| 2359–2381 | Params | — |
| 2382–2424 | Permission card | hex block |
| 2425–2594 | Ask card | §3 reduced-motion (2589 `.mva-ask-opt`, which *narrows* rather than zeroes) |
| 2595–2686 | Plan card | §3 reduced-motion (2681 `.mva-plan-card .mva-reason-chevron`) |
| 2687–2719 | Buttons (`.mva-btn` base) | §5 (no `mod-cta`) |
| 2720–2895 | History gallery | §2 (eyebrows 2852/2868), §1 (radius fallbacks 2848/2864) |
| 2896–2908 | Reasoning | — |
| 2909–2957 | Context ring (donut) | §3 (220ms override 2928, hover wash 2938), §3 reduced-motion (2951 `.mva-ctx-ring` + `::after`) |
| 2958–2999 | Quota badge | hex block |
| 3000–3023 | Compact divider | §2 (eyebrow 3009) |
| 3024–3096 | Inline edit + its out-of-root spinner | §1 (radius fallback 3040), §3 (spin 3083, dedicated reduced-motion guard 3091) |
| 3097–3145 | Prompt-variables modal (`.mva-pv` form recipe) | §5 (form conventions) |
| 3146–3206 | Image attachments | §1 (radius fallback 3192) |
| 3207–3338 | Sources / touched-notes footer | hex block |
| 3339–3412 | Onboarding + memory-setup picker | — |
| 3413–3467 | Surfacing chips | §2 (eyebrows 3422/3450) |
| 3468–3502 | Queue | — |
| 3503–3620 | Capabilities pane | hex block |
| 3621–3658 | Keyframes (all 12 named animations) | §3 (loop cadences) |
| 3659–3682 | Blanket `prefers-reduced-motion` block (comment 3659, `@media` opens **3660**) | §3 (live rule), `!important` ×3 |
| 3683–3722 | Gallery card delete | — |
| 3723–3833 | Artifact preview cards | hex (bare `#fff`, 3776) |
| 3834–3870 | Working indicator (F1) | §3 (working-pulse 3847) |
| 3871–3879 | Turn duration (F2) | — |
| 3880–3935 | Proactive compaction nudge | — |
| 3936–4068 | Chat outline (strip, floating panel, jump flashes, focus ring) | §1 (shadow 3995), §3 (width transition 3975, flashes 4034/4042, reduced-motion guard 4048), `!important` ×2 (4064/4066) |
| 4069–4105 | Settings tabbed panes (out-of-root) | §3 (reduced-motion reach) |
| 4106–4238 | In-note AI toolbar + action panel | §1 (shadows 4138/4174), §3 (spin 4187) |
| 4239–4369 | v2 inline decoration diff (CM6) | §1 (radius fallbacks 4270/4288), §1 (shadow 4317), hex block, §3 reduced-motion (4354 — the only guard reaching the four body-anchored `.mva-inai-` surfaces) |
| 4370–4660 | Orchestration Board | §2 (eyebrow 4473), §3 (board-pulse 4622), §4 (`.mva-board-placeholder`) |
| 4661–4764 | Task modal (reuses `.mva-pv` recipe) | §5 (chip+popover picker), §3 reduced-motion (4756 `.mva-board-dot`/`.mva-board-card` — the Board's guard closes the section) |
| 4765–4811 | Exo Cockpit | §4 (`.mva-ck-empty` 4808) |
| 4812–4837 | Learning loop | §3 (ll-pulse 4817), §3 reduced-motion (4820 `.mva-ll-icon.is-working svg`) |
| 4838–4918 | Automations modal | §4 (`.mva-auto-empty` 4862), §5 (chip+popover picker) |
| 4919–4962 | In-document Connections (mentions underline + popover) | §1 (radius 4942, shadow 4944), hex block |
| 4963–5140 | Proposal Kernel (banner 4963) + Foundry playbook editor (5029), then the Connections pane banner at 5070 | §2 (eyebrow 5016), §4 (`.mva-proposals-empty` 5061), §1 (radius fallback 5112), hex block (5136 `#3fb950`), §4 (`.mva-conn-empty` 5139) |
| 5141–5168 | Connections pane, continued (skill groups, MCP status dots) | §2 (eyebrow 5149), hex block (5168 `.mva-conn-dot.is-failed` — failed **or** needs-auth) |

### TypeScript surfaces checked

- `src/settings.ts` (1394 lines) — every `setName` / `setDesc` /
  `setButtonText` / `setPlaceholder`, all 11 `addDropdown` call sites, all
  toggles. One §5 FIX raised.
- `src/ui/` — all 22 files read or grepped for microcopy, pickers and buttons:
  `autocomplete.ts`, `automations-modal.ts`, `board-view.ts`,
  `capabilities.ts`, `cockpit-view.ts`, `composer.ts`, `connections-view.ts`,
  `dom.ts`, `dream-modal.ts`, `empty-state.ts`, `graph-view.ts`,
  `inline-edit.ts`, `keyed-reconcile.ts`, `note-diff.ts`, `popover.ts`,
  `prompt-vars.ts`, `proposals-modal.ts`, `recap.ts`, `related.ts`, `steps.ts`,
  `task-modal.ts`, `tools.ts`.
- Corroborating greps outside the audit scope but load-bearing for a §5/§2
  verdict: `src/providers/claude.ts`, `src/providers/codex.ts` (brand colours),
  `src/view.ts`, `src/editor/inline-ai.ts` (`.mva-btn` usage).

---

## §0 — audit-procedure sweep (kit step 1), every hit enumerated

The kit's procedure step 1: *"grep the plugin's stylesheet for raw `ms` / hex
values outside a `var(--cosmos-…, fallback)` or `var(--mv-…, fallback)`
pattern."* Commands as run, with complete hit lists so a reviewer can re-run
and diff rather than trust this doc.

### Raw hex — 50 occurrences, each judged individually

```sh
grep -nE '#[0-9a-fA-F]{3,8}\b' styles.css
```

The kit explicitly sanctions hex **inside** a `var(--token, #hex)` fallback
("pass-in-fallback"): that is the theme-independence pattern itself. 49 of the
50 are exactly that shape. Grouped by fallback target, with every line
accounted for:

| # | Occurrences | Lines | Verdict |
|---|---|---|---|
| 1 | `var(--color-green, #19c37d)` ×15 | 863, 948, 1955, 2097, 2270, 2344, 2345, 2351, 3056, 3568, 4225, 4255, 4256, 4297, 4298 | **pass, pass-in-fallback** — success/positive states. `#19c37d` is also Codex's brand green (`src/providers/codex.ts:289`), deliberately reused so the "done" green matches the provider mark when Obsidian defines no `--color-green`. |
| 2 | `var(--color-green, #3fb950)` ×2 | 1349, 5136 | **pass, pass-in-fallback** — permission dot + Connections status dot; a slightly brighter green chosen for a 6px disc. |
| 3 | `var(--color-green, #4caf50)` ×2 | 2872, 2873 | **pass, pass-in-fallback** — gallery "Done" status badge. Third green literal in the file; see the coherence note below. |
| 4 | `var(--color-orange, #e0a341)` ×14 | 1196, 1200, 1284, 1351, 2384, 2386, 2397, 2983, 2986, 3345, 3350, 3390, 3394, 4868 | **pass, pass-in-fallback** — caution/warning tier (permission chips, quota badge, revert hint, automation warning). |
| 5 | `var(--color-orange, #e0a458)` ×1 | 5168 | **pass, pass-in-fallback** — `.mva-conn-dot.is-failed`, the amber Connections status dot, which `src/ui/connections-view.ts:228` toggles for `status === "failed"` **or** `status === "needs-auth"` (one class, two states). Fourth-decimal drift from group 4 (`e0a341` vs `e0a458`); see the coherence note. |
| 6 | `var(--color-red, #e05b5b)` ×11 | 1197, 1202, 1283, 1352, 2989, 2992, 3061, 3322, 3323, 4301, 4302 | **pass, pass-in-fallback** — danger tier (danger chips/options, permission dot, reject hunk, error diff). |
| 7 | `var(--text-accent, #7c6cff)` ×1 | 4925 | **pass, pass-in-fallback** — mention underline colour. |
| 8 | `var(--background-primary, #fff)` ×1 | 4943 | **pass, pass-in-fallback** — mention popover surface. |
| 9 | `var(--text-muted, #888)` ×1 | 4949 | **pass, pass-in-fallback** — mention popover secondary text. |
| 10 | `var(--text-normal, #222)` ×1 | 4957 | **pass, pass-in-fallback** — mention popover body text. |
| 11 | bare `#fff` ×1 | 3776 (`.mva-artifact-frame iframe { background: #fff; }`) | **waived** — paper background for a sandboxed HTML artifact preview. The iframe renders third-party HTML authored against a white page; theming it to `--background-primary` puts a dark surface under black body text and makes artifacts unreadable. It is not a Cosmos surface and no kit token covers "document paper". Deliberate, not leakage. |

Total: 15+2+2+14+1+11+1+1+1+1+1 = **50**. ✔

Three notes that are *not* verdicts but belong on the record:

- **No provider brand literal lives in `styles.css`.** The file header claims
  "the only fixed colors are per-provider brand accents (Claude / Codex)" —
  true in spirit, but those two literals (`#d97757`,`#19c37d`) actually live in
  `src/providers/claude.ts:578` and `src/providers/codex.ts:289` and reach CSS
  at runtime through `--mva-brand`. So the "brand accent" waiver category the
  brief anticipated resolves to **zero rows** in the stylesheet: the accents are
  already tokenized. The one bare hex is the artifact-paper case above.
- **Three different green fallbacks and two different orange fallbacks** for
  the same semantic tier is an internal inconsistency, not a kit violation
  (the kit governs the *shape* `var(--token, literal)`, which all of them
  satisfy, not fallback-literal agreement across sites). Noted for a future
  palette pass; **not** proposed as a FIX here because collapsing them changes
  rendered colour on any theme that leaves `--color-green` undefined.
- **`color-mix()` hex uses** (2345, 2384, 2386, 3056, 3061, 3323, 3345, 3390,
  4225, 4256, 4298, 4302, 2872) are counted above inside their groups: the hex
  in each is still a `var()` fallback, wrapped by `color-mix`, so the shape
  holds.

### Raw milliseconds outside `var()` — 6 lines, each judged individually

```sh
grep -nE '[0-9.]+ms' styles.css   # 7 hits: 1689, 2925, 2928, 2937, 2938, 3669, 3671
```

**7 hits, 6 raw.** The command as printed returns seven lines; the table below
enumerates six. The excluded one is **2938**, `var(--cosmos-t-fast, 120ms)` —
a literal sitting in the fallback slot of a suite token, i.e. exactly the shape
the kit sanctions, so it is a compliant consumption site (audited in §3) and not
a raw value. Every other hit is raw and gets its own row. The count is stated
this way so a reviewer re-running the one-liner sees 7 and knows why the table
says 6, instead of hitting a phantom discrepancy.

| Line | Hit | Verdict |
|---|---|---|
| 1689 | `animation-delay: calc(var(--i, 0) * 70ms)` — empty-state stagger step | **waived** — a per-item *phase offset*, not a duration. The kit's tiers describe how long a change takes; no `--cosmos-t-` token expresses a 70ms stagger increment, and mapping it onto the smallest tier (140ms) would double the cascade length of the chat's signature entrance. Reduced motion neutralizes the *animation*: the element is inside `.mva-root`, so the blanket at **3660** forces `animation-duration: 0.001ms !important` and the rise never plays. Stated precisely, because the blanket does not touch `animation-delay`: under reduced motion the items still *appear* on the 70ms cadence, they just do not move. Harmless, and noted rather than glossed. |
| 2925 | `220ms` inside a comment | **pass, not a declaration** — the comment documenting the line below. Counted because the grep matches it; it renders nothing. |
| 2928 | `transition: background 220ms cubic-bezier(0.16, 1, 0.3, 1)` — context-ring donut fill | **waived** — carries an explicit inline directive at 2925–2927: *"Sole sanctioned motion override… Do not tokenize this line."* A documented, deliberate pre-existing exception; overriding it is a design decision, not a coherence fix. Reduced motion reaches it twice — the blanket at 3660 (the ring is inside `.mva-root`) and a dedicated `transition: none` guard at **2951** naming `.mva-ctx-ring` and `.mva-ctx-ring::after` — so the kit's reduced-motion MUST is not endangered — only the tokenization MUST is knowingly traded away, once, with the reason written in the file. |
| 2937 | `140ms` / `120ms` inside a comment | **pass, not a declaration** — documents the tokenized line below (landed in `52efeb6`). |
| 3669 | `animation-duration: 0.001ms !important` | **pass** — this *is* the reduced-motion implementation, the standard near-zero-not-zero idiom (0 would suppress `animationend` events). Tokenizing it would be circular. |
| 3671 | `transition-duration: 0.001ms !important` | **pass** — same, for transitions. |

Line 2938 (`var(--cosmos-t-fast, 120ms)`) and line 533
(`var(--cosmos-t-base, 0.18s)`) are **not** in the raw list: both were
tokenized in `52efeb6` and now match the sanctioned shape.

**Second-unit durations** are outside the kit's literal grep (`ms`) but inside
its intent, so they are enumerated in §3 rather than dropped.
`grep -nE 'animation:[^;]*[0-9.]+s\b' styles.css` → **20** hits: 16 infinite
loops (`grep -c 'infinite'` → 16), 2 one-shot jump flashes (4034, 4042), the
staggered welcome entrance (1688), and the turn entrance (533, already
tokenized to `var(--cosmos-t-base, 0.18s)`). The three `animation-delay`
values (893 `0.18s`, 896 `0.36s`, 1689 `70ms`) are a separate property and are
judged on their own rows — they are phase offsets, not durations.

### `!important` — 6 occurrences, each judged individually

```sh
grep -n '!important' styles.css
```

The kit states no MUST about `!important`; each is judged on whether it is a
documented, necessary specificity override or a shortcut around the cascade.

| Line | Declaration | Verdict |
|---|---|---|
| 1466 | `.mva-doc-x:hover { opacity: 1 !important }` | **waived, justified** — the context-card × is revealed by `.mva-doc-card:hover .mva-doc-x { opacity: .7 }`, a *more specific* selector than `.mva-doc-x:hover`. Since the pointer is necessarily over the card while over the ×, the parent rule always co-matches and wins on specificity; `!important` is the only way the hover-over-the-× state reaches full opacity. Fixing by specificity would need `.mva-doc-card:hover .mva-doc-x:hover`, a selector rewrite for zero behavioural gain. |
| 3669 | `animation-duration: 0.001ms !important` | **pass, expected** — inside the `prefers-reduced-motion` block. Accessibility overrides are the canonical sanctioned use of `!important`; without it every animation shorthand declared later in the file would win. |
| 3670 | `animation-iteration-count: 1 !important` | **pass, expected** — same block, same reason: it caps the in-root share of the file's 16 `infinite` loops at one cycle. Precisely: 14 of the 16. The two out-of-root spinners (3083 `.mva-ie-spin`, 4187 `.mva-inai-spin`) are **not** reached by this declaration and are stopped instead by the dedicated `animation: none` at 3092–3094 and 4365–4367. |
| 3671 | `transition-duration: 0.001ms !important` | **pass, expected** — same block. |
| 4064 | `outline: 2px solid var(--interactive-accent) !important` | **waived, justified** — the "preserve a visible keyboard focus indicator" rule. Obsidian core and several themes ship `outline: none` on buttons/`.clickable-icon` at equal-or-higher specificity and later in load order; without `!important` Exo's keyboard focus ring silently disappears. This is an accessibility guarantee, same class as the reduced-motion block. |
| 4066 | `box-shadow: none !important` | **waived, justified** — companion to 4064: themes that replace the outline with a glow box-shadow would otherwise stack a second ring on top of Exo's. |

**Total: 6.** Zero proposed removals. Count is unchanged from `e0eb74d`, so a
`!important` ceiling of 6 is a safe ratchet value if a style contract is added
to this repo in a later step.

### Token-redefinition check (golden rule MUST NOT)

```sh
grep -nE '^\s*--(cosmos|mv)-[a-z0-9-]+\s*:' styles.css
```

**0 hits.** Exo defines only its own `--mva-` namespace. Per the brief, those
`:root` declarations are a plugin naming its own tokens — the MUST NOT targets
redefining *theme* tokens, so they are **not** flagged here.

### CSS-comment integrity check

```sh
grep -o '/[*]' styles.css | wc -l   # 217 comment openers
grep -o '[*][/]' styles.css | wc -l # 217 comment closers
```

(The bracket expressions are not cosmetic: writing the closing marker as a
bare two-character literal inside a file is the exact hazard the kit warns
about, so this doc never spells it out.)

Balanced, and zero occurrences of the token-glob-then-slash pair that
truncated a comment and silently dropped a rule in the Sonar wave. Nothing in
this audit doc reproduces that character pair either.

---

## Golden rule — theme-independent consumption

| Check | Desktop | Phone | Verdict |
|---|---|---|---|
| Every consumed `var(--cosmos-…)` / `var(--mv-…)` has a literal fallback | 11 consumption sites at HEAD (533, 964, 1065, 1244, 2938, 3995, 4138, 4174, 4317, 4942, 4944). 7 terminate in a literal: `0.18s` (533), `120ms` (2938), one radius `8px` (4942), and four `rgba()` shadow recipes (4138, 4174, 4317, 4944) | N/A as a platform split — a fallback either terminates in a literal or it does not, and the declaration is parsed identically by every renderer; Exo also has no phone surface for the split to bite on | **pass for 7, waived for 4** — see next row |
| The 4 sites whose fallback is a native token, not a literal: 964 `var(--shadow-s)`, 1065 / 1244 / 3995 `var(--shadow-l)` | pre-fix declaration at each was exactly `box-shadow: var(--shadow-s\|l)` | N/A — `--shadow-s` / `--shadow-l` are Obsidian core tokens, defined identically by the mobile app, so the fallback chain would resolve there too. Moot regardless: `isDesktopOnly: true`, the branch never runs on a phone | **waived** — terminating the chain in a literal means hand-copying Obsidian's native multi-layer shadow into Exo, where it drifts from the app on every Obsidian release, to guard a branch that only fires if Obsidian defines no `--shadow-` at all (no supported build does). The MUST's stated purpose ("the plugin still looks correct with Cosmos absent") is met byte-for-byte. The letter of the MUST is not; this row is the record of that trade, deliberately not a restatement of the rule as "literal-or-native-token". |
| MUST NOT: plugin redefines the theme's tokens at `:root` / `body` | 0 hits (command in §0) | N/A as a platform split — a `:root` redefinition leaks on every renderer alike, so the check is platform-independent. Zero hits, so nothing differs by column | **pass** |
| MUST NOT: token glob immediately followed by a slash inside a CSS comment | 0 hits; 217/217 comment markers balanced | N/A as a platform split — a truncated comment drops the following rule on every renderer alike. Platform-independent check, passes | **pass** |
| Exo's own `--mva-` namespace at `:root` (lines 10–14) | 5 declarations: three radii, one duration, one easing | N/A — owning a `--mva-` namespace is not a platform-scoped act, and there is no phone `:root` for it to collide with | **pass** — a plugin naming its own namespace, explicitly legitimate. Kept out of the MUST NOT. Its §1 obligations are a separate rule, below. |

---

## §1 Radius + surfaces

Radius histogram — the **139 `border-radius:` shorthand declarations** across all
5168 lines: 39 `var(--mva-r1)`, 21 `var(--mva-r2)`, 18 `50%`, 13 `999px`
(a 14th `999px` at 4701 is inside a comment and excluded), 11 `var(--radius-s)`,
7 `var(--mva-card-radius)`, 7 `3px`, 6 `var(--mva-r3)`, **3** `var(--radius-m)`,
3 `4px`, 9 `var(--mva-r…, fallback)`, 1 `var(--radius-m, 8px)` (4083),
1 `var(--cosmos-r-floating-surface, 8px)`.

Two consumption sites sit outside that shorthand histogram, stated here so the
file-wide totals reconcile with a plain `grep -o`:

- line **694** `border-bottom-right-radius: var(--mva-r1)` — a longhand, so
  `var(--mva-r1)` occurs **40** times file-wide, not 39 (46 counting the six
  `var(--mva-r1, …)` fallback forms).
- line **21** `--mva-card-radius: var(--mva-r2)` — a token alias, not a
  `border-radius` declaration, so `var(--mva-r2)` occurs **22** times file-wide,
  not 21 (25 counting the three `var(--mva-r2, 8px)` fallback forms).

Likewise `var(--radius-m)` is 3 as a bare consumption and 4 if the
`var(--radius-m, 8px)` at 4083 is counted with it; the histogram lists the two
forms separately.

| Surface | Desktop | Phone | Verdict |
|---|---|---|---|
| Chip / toolbar radius — `:root { --mva-r1: 6px }` (line 10), consumed at 46 sites file-wide — 40 as bare `var(--mva-r1)` (39 `border-radius` shorthands plus the longhand at 694) and 6 as `var(--mva-r1, …)` | a hand-picked pixel value that visually matches the kit's "chip / toolbar" entry, whose canonical token `--mv-r1` is *also* `6px` | N/A — desktop-only, but the kit lists this row as "Same" on phone anyway, so no phone-specific carve-out is being skipped | **FIX** — proposed change, `styles.css:10`: `--mva-r1: 6px;` → `--mva-r1: var(--mv-r1, 6px);`. Byte-identical rendering with Cosmos absent *and* present (both are 6px); one line; zero visual delta. Sibling precedent: `obsidian-sonar` landed exactly this (`.sonar-chip` 7px → `var(--mv-r1, 6px)`). This does not conflict with the "don't flag Exo's own tokens" instruction — that instruction concerns the MUST NOT about redefining theme tokens; this is §1's separate MUST about *consuming* the matching token. |
| Card radius — `--mva-r2: 9px` (line 11), consumed via `--mva-card-radius` (itself defined as `var(--mva-r2)` at line 21) at 7 card families + 21 direct `border-radius` sites | kit's card token is `--mv-r-card: 11px`; Exo's card radius is 9px | N/A — the kit lists card radius as the same value on both columns, so no phone-specific carve-out is being skipped. Exo has no phone surface either way | **waived, value mismatch** — `var(--mv-r-card, 9px)` would move every card 9px → 11px the moment Cosmos is present: a visual change on the single most repeated surface in the plugin, which this wave's contract forbids. Reconciling 9 vs 11 is a suite design decision (Exo's card grammar is denser than Masonry's), not a coherence substitution. Carried. |
| `--mva-r3: 13px` (line 12), 6 sites | no `--mv-r` or `--cosmos-r-` entry carries 13px | N/A — the kit's radius vocabulary has no 13px tier on either column, so there is nothing platform-specific to consume | **waived** — nothing to consume; the kit's radius vocabulary has no 13px tier. |
| Popover / floating-surface elevation — `.mva-ac` (964), `.mva-agents-list` (1065), `.mva-sel-pop` (1244), `.mva-outline-panel` (3995), `.mva-inai-bar` (4138), `.mva-inai-panel` (4174), `.mva-inai-streamchip` / `.mva-inai-actionbar` (4317), `.exo-mention-popover` (4944) | all 8 consume `var(--cosmos-pop-shadow, …)` at HEAD (landed `2c660fa`) | N/A — `--cosmos-pop-shadow` is a single value across columns, and Exo renders no floating surface on phone because it renders nothing on phone | **pass** — kit §1 MUST ("plugins never hardcode elevation shadows for floating surfaces") satisfied on every floating surface Exo renders. |
| `.exo-mention-popover` radius (4942) | `var(--cosmos-r-floating-surface, 8px)` at HEAD (landed `2c660fa`) | N/A — `--cosmos-r-floating-surface` is the same on both columns; the mention popover is a CM6 editor affordance in a desktop leaf | **pass** — concentric with every other floating surface under Cosmos, identical standalone. |
| `.mva-recap` shadow (307, `var(--shadow-s)`) | an inline layout column inside `.mva-root.is-wide`, not floating chrome | N/A — the Recap Rail only renders under `.mva-root.is-wide`, a width class a phone viewport never reaches even if Exo could load there | **waived** — the kit scopes `--cosmos-pop-shadow` to "menu / tooltip / popover / prompt". The Recap Rail is a docked column; giving it pop elevation would read as a detached panel. |
| `.mva-jump-pill` shadow (477, `var(--shadow-s)`) | a 30px round control, not a floating panel | N/A — the kit's phone column adds touch-target rules for controls, not elevation rules, so nothing phone-specific is skipped here | **waived** — same reasoning; a control's own drop shadow is not surface elevation. |
| `border-radius: 50%` × 18 (dots, rings, avatars, the breathing aura) | geometric circles on fixed tiny shapes | N/A — circles are geometry; the kit's radius table has no entry for them on either column | **waived** — the round-cap idiom; the kit's radius table has no entry for circles. Same waiver class as Sonar's badge-dot and Horizon's status-dot rows. |
| `border-radius: 999px` × 13 (pills, tracks, badges, removable context chips) | full-round on fixed-height shapes | N/A — `--cosmos-r-fusion-tab` is a Cosmos *flavour* token, not a phone-scoped one, so the waiver reads the same on both columns | **waived** — `--cosmos-r-fusion-tab: 999px` is semantically "fusion-flavour tab bar", not a generic 999px alias. Consistent with Sonar wave 1. |
| `border-radius: 3px` ×7 and `4px` ×3 (hairline bars, inline marks, glyph-scale buttons) | below the kit's smallest surface token (`--mv-r-chip: 5px`) | N/A — `--mv-r-chip` carries 5px on both columns, so the mismatch is not platform-dependent | **waived** — adopting the token would *change* the rendered value on glyph-scale shapes for no coherence gain. Same class as Horizon's checkbox-glyph waiver. |
| Radius fallback drift — 963 `var(--mva-r2, 8px)`, 3040 `var(--mva-r2, 8px)`, 3192 `var(--mva-r2, 8px)`, 4270 `var(--mva-r1, 5px)`, 4288 `var(--mva-r1, 4px)`, 5112 `var(--mva-r1, 8px)` | six fallbacks disagree with their own `:root` definitions (`--mva-r1` is 6px, `--mva-r2` is 9px). Both tokens are always defined at `:root`, so the fallbacks are dead code that *documents the wrong number* | N/A — a dead fallback branch is unreachable on every platform; this is a documentation defect in the file, not a rendering one | **FIX** — proposed change: align each fallback to its token's real value — 963/3040/3192 → `var(--mva-r2, 9px)`; 4270/4288/5112 → `var(--mva-r1, 6px)`. Zero rendered change (the fallback branch is unreachable); it removes six wrong numbers from the file and makes the three already-correct sites (973, 2848, 2864) the rule instead of the exception. Low risk, mechanical. |

---

## §2 Type sizes, icon sizes, touch targets

| Rule | Desktop | Phone | Verdict |
|---|---|---|---|
| Icon sizing follows Obsidian's native `--icon-size` scale | **56 rule blocks** name `.svg-icon` (the 57th `grep -n '[.]svg-icon'` hit is 1945, a continuation selector line of the 1945–1946 pair `.mva-tool-status .svg-icon, .mva-tool-icon .svg-icon`, not a block of its own). **53** declare an explicit px width — 11px ×2, 12px ×14, 13px ×13, 14px ×14, 15px ×2, 16px ×6, 40px ×1, 42px ×1 — and **3 declare none**, inheriting from the sized parent rule they modify: `.mva-todo.is-in_progress .mva-todo-box .svg-icon` (868, sets only `animation`), `.mva-agents-icon.is-idle .svg-icon` (946, sets `animation: none` + colour), `.mva-sel-card .mva-doc-thumb.is-icon .svg-icon` (1486, sets only colour). Zero `var(--icon-` uses. There is **no 18px and no 22px `.svg-icon` anywhere**: the four `width: 22px` lines are boxes, not icons — 1618 `.mva-input-expand`, 3695 `.mva-gal-del`, 3978 `.mva-outline-tick.is-active`, 4643 `.mva-board-col-add` (the first, second and fourth are button boxes that *contain* a smaller sized glyph — 1626 `.mva-input-expand svg` 13px, 3712 `.mva-gal-del .svg-icon` 12px, 4656 `.mva-board-col-add .svg-icon` 14px; the third is a 2px-tall tick bar) — and `width: 18px` appears twice, neither on `.svg-icon`: 4768 `.mva-ck-mark svg` and 2920, the donut progress ring box | N/A — the kit records no phone-specific icon scale either (both columns defer to Obsidian's `--icon-size`), and no icon of Exo's ever paints on a phone | **pass** — the kit's own §2 row records that "Cosmos defines no separate icon-size scale", so there is no suite token to consume; sizing an SVG in px at the call site is what Sonar wave 1 and Horizon wave 5 both passed on. |
| Micro-label type scale — 16 uppercase eyebrows (lines 323, 331, 651, 832, 990, 1330, 1778, 2224, 2852, 2868, 3009, 3422, 3450, 4473, 5016, 5149) | 15 use hand-picked sizes (9.5 / 10 / 10.5 / 11 / 12px) with weight 600–650 and letter-spacing 0.02–0.06em; only `.mva-proposals-kind` (5016) uses `var(--font-ui-smaller)` | N/A — the kit's phone MUST NOT ("a plugin ships a bespoke micro-label font size **on phone**") cannot be violated by a plugin with no phone surface | **waived on desktop, N/A on phone** — converging the 15 on the kit's verbatim recipe means raising every eyebrow to 12px (`--font-ui-smaller`) and dropping weight 600/650 → `--font-medium`: a visible enlargement and de-emphasis of every section label in the chat, the gallery, the board and the Connections pane simultaneously. That is mass normalization with real regression risk, explicitly outside this wave's non-goals — and it is a *desktop* judgement call, since the phone MUST NOT that would force it is unreachable. Flagged as a genuine open gap for a dedicated typography wave where the size change is the intent, not a side effect. Cheapest partial — swapping in `--font-ui-smaller` only where the literal is already 12px — applies to exactly one site, and it is a real zero-delta fix rather than a no-op: `.mva-board-col-title` (block 4469–4475; the eyebrow marker is the `text-transform: uppercase` at 4473, the declaration to change is `font-size: 12px` at 4470) declares a literal size, so `font-size: var(--font-ui-smaller)` renders identically today and follows the token if Obsidian ever retunes it. (`.mva-proposals-kind` at 5016 already uses the token and is not a literal-12px site, so it is not part of that swap.) Offered as FIX #6 below, deliberately separated from the broader normalization of the remaining 14 that this row waives. |
| `--cosmos-touch-min` (44px) on every tappable target | kit itself: "N/A (no minimum enforced)" on desktop — nothing to check | N/A — `isDesktopOnly: true`; no tap target ever renders. `styles.css` has zero `pointer: coarse` / `.is-mobile` / `.is-phone` blocks to host such a rule | **waived, N/A (desktop-only)** — adding a phone-scoped rule to a plugin that cannot load on phone would be dead CSS asserting a false capability. |
| `--cosmos-press-scale` (0.98) on active/press | kit itself: "N/A (no press-scale defined for pointer/desktop)" | N/A — same reason as above | **waived, N/A (desktop-only)** — Horizon and TabX added press-scale because they render on iPhone; Exo cannot. |
| Connections refresh control rendered as the text glyph `↻` (`src/ui/connections-view.ts:74`) | a bare glyph where sibling controls use `setIcon` | N/A — no rule on either column governs glyph-versus-icon; the Connections pane is a desktop leaf view | **waived, no kit rule backs it** — §2 says only "icons follow Obsidian's native icon-size tokens"; there is no glyph→icon MUST in the kit. It was landed and then deliberately reverted (`7af553f`) because `setIcon` injects an `<svg>` child, i.e. a DOM change, which this wave forbids outright. If pursued later it needs a companion `.mva-conn-refresh .svg-icon` sizing rule — that class currently sets only `margin-left: auto`, so an injected icon would render at Obsidian's default size while its `.mva-icon-btn` siblings declare 16px. |

---

## §3 Motion

| Site | Desktop | Phone | Verdict |
|---|---|---|---|
| `.mva-turn` entrance (533) | `mva-pop var(--cosmos-t-base, 0.18s) ease-out` at HEAD (landed `52efeb6`) | N/A — the phone entrance recipes are audited in their own row below; this row is the duration tier, which is one value across columns | **pass** — 0.18s is exactly the kit's `--cosmos-t-base` tier, so the fallback is byte-identical and the entrance now zeroes at token level under Cosmos + reduced motion. |
| `.mva-ctx-ring::after` hover wash (2938) | `background-color var(--cosmos-t-fast, 120ms) ease` at HEAD (landed `52efeb6`) | N/A — hover is a pointer-only state, so the phone column has no equivalent to check | **pass** — micro-feedback tier; 120ms standalone, 140ms under Cosmos. |
| `--mva-t` (line 13, `0.14s ease`) — the file's dominant transition token, ~50 sites | Exo's own duration token, a raw literal not bridged to any suite token | N/A — `--mv-t` carries one value on both columns, so the proposed FIX is platform-neutral | **FIX** — proposed change, `styles.css:13`: `--mva-t: 0.14s ease;` → `--mva-t: var(--mv-t, var(--cosmos-t-fast, 0.14s)) ease;`. `--mv-t` is defined by the kit as exactly the bridge alias "consumed by exo (`--mva-t`)" — this is the one token the kit names Exo in — and its canonical value is `--cosmos-t-fast`. Fallback keeps 0.14s, so Cosmos-absent rendering is byte-identical; under Cosmos the ~50 transitions gain reduced-motion zeroing at token level for free. Highest-leverage single line in the file. |
| `.mva-settings-tab` transitions (4090) | routed through `var(--mva-t)` at HEAD | N/A — Obsidian's settings modal does exist on phone, but Exo is never listed in it (`isDesktopOnly: true`), so the strip never renders there | **pass** — consolidated onto Exo's own duration token in `52efeb6`; inherits whatever the FIX above gives `--mva-t`. |
| `prefers-reduced-motion: reduce` — **13** blocks (`grep -n 'prefers-reduced-motion' styles.css` → 459, 491, 625, 1758, 2589, 2681, 2951, 3091, **3660**, 4048, 4354, 4756, 4820) | one blanket (3660) plus twelve per-surface guards; full enumeration with each block's role in the sub-table immediately below this table | **applies on every platform per the kit — audited as live, not waived; this is the one row where the phone column is not N/A** | **pass, on the enumeration below** — the argument is that these 13 blocks *collectively* cover in-root and out-of-root, not that any one of them does. Two blocks (3091, 4354) are load-bearing: they are the only guards reaching an out-of-root surface. Ten are redundant-but-stronger restatements of what 3660 already zeroes. Two (491, 2589) do **not** zero motion at all — see the sub-table. |
| `.mva-ctx-ring` donut fill (2928, `220ms cubic-bezier(0.16, 1, 0.3, 1)`) | raw ms + raw bezier, with an inline "do not tokenize this line" directive at 2925 | N/A — desktop-only; the kit's motion MUSTs that differ by platform are the press-scale and entrance rows below, not this one | **waived** — documented deliberate exception predating this wave (see §0). Reduced motion reaches it twice: the blanket at 3660 (the ring is inside `.mva-root`) *and* a dedicated `transition: none` guard at 2951 that names `.mva-ctx-ring` and `.mva-ctx-ring::after` explicitly. So the 220ms literal is a tokenization trade only; the reduced-motion MUST is doubly satisfied here. |
| `.mva-empty > *` entrance (1687–1689): `mva-rise 0.5s var(--mva-ease-out)` + `calc(var(--i, 0) * 70ms)` stagger | easing already tokenized to Exo's own `--mva-ease-out` (= the kit's `--mv-lift` value, `cubic-bezier(0.22, 1, 0.36, 1)`); duration and stagger are raw | N/A — the kit's phone entrance MUST is handled in the dedicated row below; here there is no phone surface for the stagger to play on | **waived** — the nearest tier (`--cosmos-t-panel`, 300ms) cuts the chat's signature welcome entrance nearly in half, and no token expresses a 70ms stagger step. A value change is not a coherence fix. Sub-note: `--mva-ease-out` and `--mv-lift` are the *same bezier*, so a future `--mva-ease-out: var(--mv-lift, cubic-bezier(0.22, 1, 0.36, 1))` is byte-identical and would be free — grouped with the `--mva-t` FIX above if the next step wants both. |
| `.mva-thinking-dot` phase offsets (893 `0.18s`, 896 `0.36s`) | offsets into a 1.1s infinite loop (dot 2 at ⅓, dot 3 at ⅔) | N/A — no tier on either column expresses a stagger step, so the waiver does not change by platform | **waived** — phase offsets, not durations. `0.36s` has no tier at all, so tokenizing only `0.18s` would break the stagger the instant `--cosmos-t-base` changed: a "coherence fix" that makes the surface less coherent. |
| Infinite loop animations — `mva-spin` (253, 869, 928, 1952, 3083, 4187), `mva-pulse` (172, 437, 890, 2047), `mva-ll-pulse` (4817), `mva-working-pulse` (3847), `mva-board-pulse` (4622), `mva-breathe` (1719), `mva-blink` (1566), `mva-shimmer` (2171) — **16** sites, 0.8s–4.5s (`grep -c 'infinite' styles.css` → 16) | loop cadences, not transitions | N/A — desktop-only; the kit sets no phone-specific loop rule, and none of these surfaces has a phone counterpart to diverge from | **waived** — every Cosmos duration tier tops out at 300ms; mapping a 4.5s breathing aura or a 1.6s working pulse onto one destroys the effect. All 16 are enumerated here, not sampled. **Reduced-motion attribution is not uniform and the earlier "all capped at 3670" claim was wrong:** 4187 (`.mva-inai-spin`) is body-anchored and is closed by `animation: none` at **4365–4367** inside the 4354 block, never by 3670; 3083 (`.mva-ie-spin`) is in `.modal-container` and is closed at **3092–3094** inside the 3091 block; the remaining 14 are declared under in-root selectors and are capped at one iteration by 3670 — except 4817 (`.mva-ll-icon`), whose section is dormant at HEAD and which carries its own `animation: none` at 4820 regardless. Four of the 14 (1719 → 1758, 4622 → 4756, 4817 → 4820, plus the caret 1566 → 3673, which lives inside the blanket block itself) additionally hard-stopped by a dedicated `animation: none`. |
| One-shot attention flashes — `mva-outline-flash 1s` (4034), `mva-flash 1s` (4042) | one-shot, so the loop waiver above does not cover them | N/A — the jump-flash is bound to the desktop chat-outline affordance, which has no phone counterpart in the kit or in Exo | **waived, value mismatch** — 1s is 3.3× the slowest Cosmos tier; tokenizing means the "where did I jump to?" highlight fades before the eye lands on it. Deliberate long-decay cue. Both inside `.mva-root` (created via `root.createDiv`, `src/view.ts:4321-4322`, and `el.addClass("mva-flash")` at `src/view.ts:4506`), so 3660 zeroes them — and the dedicated block at 4048 hard-stops both with `animation: none` on top. |
| `--cosmos-spring` (overshoot) usage | never used anywhere | N/A — `--cosmos-spring` is reserved for confirmation micro-moments on both columns; unused here either way | **pass** — the kit reserves it for confirmation micro-moments only, never hover/reveal. Exo's press feedback (`.mva-send:active`, 1660) is a plain scale with `--mva-t`, correctly not reaching for overshoot. |
| Composited-properties MUST — `.mva-outline-tick` (the selector pair spans **3968–3980**: base block 3968–3976, `.is-active` block 3977–3980; the offending declaration is at 3975, `transition: width var(--mva-t), background-color var(--mva-t)`) | animates `width` 16px → 22px on `.is-active`; the strip is `align-items: flex-end`, so the box is right-anchored | N/A — the composited-properties MUST is platform-independent, so it is genuinely unmet on the only platform Exo has. Not waived on the phone column, simply unreachable there | **FIX** — proposed change: on `.mva-outline-tick` (3968) set `width: 22px`, add `transform-origin: right; transform: scaleX(0.727);` and change 3975 to `transition: transform var(--mva-t), background-color var(--mva-t)`; in `.mva-outline-tick.is-active` (selector at 3977) replace the `width: 22px` declaration at **3978** with `transform: none`. Right-anchored layout makes the rendered result pixel-identical while moving the animation off the layout path, satisfying the kit MUST literally. Low risk: a 2px-tall bar with no text content, one selector pair. The existing reduced-motion block at 4048 already lists `.mva-outline-tick` with `transition: none`, so the new transform transition inherits that guard for free. |
| Composited-properties MUST — `.mva-inputwrap.is-anim .mva-input` (1636, `transition: height var(--mva-t)`) | animates `height` on the composer textarea, gated behind an `.is-anim` class the expand toggle adds and removes | N/A — same platform-independent MUST; a phone composer would inherit the identical defect if Exo ever dropped `isDesktopOnly` | **waived** — the kit MUST is real and unmet here, but the fix is not available in CSS: a textarea's height is content-driven and `transform: scaleY()` would distort the glyphs and the caret. Honouring it means restructuring the composer's grow behaviour (JS-coordinated, `autoGrow` caps mirrored in CSS at 1630) — a layout/behaviour change, a hard non-goal. Mitigations already in place: the transition fires only on a deliberate user toggle (never on keystroke growth, per the comment at 1633) and reduced motion zeroes it. Carried, named, not silently dropped. |
| Animated properties, everything else | entrances use `transform`/`opacity`; hover/press use `background-color`/`color`/`border-color`/`opacity`/`box-shadow` | N/A — the allowed-property list is identical on both columns of the kit | **pass** — no other layout-triggering property is animated in the file. |
| Phone entrance recipes — `cosmos-pop-in`, `cosmos-sheet-rise`, `cosmos-fade-in` | kit itself: "N/A — no entrance-animation requirement" on desktop | N/A — `isDesktopOnly: true`. Exo has 8 floating surfaces that *would* be in scope on phone (autocomplete, agents list, selector popover, outline panel, in-note toolbar/panel/actionbar, mention popover), and none has an entrance animation | **waived, N/A (desktop-only)** — recorded explicitly rather than passed over, because this is the row where Horizon had a genuine unmet MUST: Horizon renders on phone, Exo cannot, so the same missing entrance animation is a violation there and structurally out of reach here. If Exo ever drops `isDesktopOnly`, these 8 surfaces become the first phone MUST to close. |


### The 13 `prefers-reduced-motion` blocks, enumerated

Command, run against the working tree at HEAD:

```sh
grep -n 'prefers-reduced-motion' styles.css   # 13 hits
```

| # | `@media` line | Surfaces it names | In / out of `.mva-root` | Role |
|---|---|---|---|---|
| 1 | 459 | `.mva-recap-row`, `.mva-recap-more` | in | `transition: none` — redundant with 3660, but stronger (kills the transition outright instead of shortening it to 0.001ms) |
| 2 | 491 | `.mva-jump-pill` | in | **does not zero motion** — it *narrows* the transition list to `transition: opacity var(--mva-t)`, dropping the translate. See the note below. |
| 3 | 625 | `.mva-recall-header`, `.mva-recall-caret` | in | `transition: none` — redundant-but-stronger |
| 4 | 1758 | `.mva-empty-star::before` | in | `animation: none` + frozen `opacity`/`transform` — hard-stops the 4.5s breathing aura (1719), which 3670 would otherwise only cap at one 4.5s cycle |
| 5 | 2589 | `.mva-ask-opt` | in | **does not zero motion** — narrows to `transition: border-color var(--mva-t)`. See the note below. |
| 6 | 2681 | `.mva-plan-card .mva-reason-chevron` | in | `transition: none` — redundant-but-stronger |
| 7 | 2951 | `.mva-ctx-ring`, `.mva-ctx-ring::after` | in | `transition: none` — the dedicated guard for the 220ms donut override at 2928 |
| 8 | 3091 | `.mva-ie-spin` | **out** (`.modal-container`) | **load-bearing** — the inline-edit modal spinner (3083) is outside `.mva-root`; the block carries an inline comment saying exactly that |
| 9 | **3660** | `.mva-root *`, `::before`, `::after`, `.mva-settings-tab`, `.exo-mention-popover`; then `.mva-caret` and the two gradient text shimmers | in + 2 out | the blanket. Carries the three `!important` declarations (3669–3671). Extended to the two out-of-root surfaces in `52efeb6` |
| 10 | 4048 | `.mva-outline-strip`, `.mva-outline-tick`, `.mva-outline-panel`, `.mva-user.is-flash`, `.mva-flash` | in (all created via `root.createDiv`, `src/view.ts:4321-4322`) | `transition: none` / `animation: none` — redundant-but-stronger; also pre-covers the §3 `scaleX` FIX below |
| 11 | 4354 | `.mva-inai-bar`, `.mva-inai-panel`, `.mva-inai-streamchip`, `.mva-inai-actionbar`, `.mva-inai-hunk-ctl`, `.mva-inai-spin` | **out** (`document.body`) | **load-bearing** — the only guard reaching the in-note AI surfaces; also resets `translate: 0 0` so the 4px rise never plays |
| 12 | 4756 | `.mva-board-dot`, `.mva-board-card` | in (`src/ui/board-view.ts:132` adds `mva-root`) | `animation: none` — hard-stops the 1.4s board pulse (4622) |
| 13 | 4820 | `.mva-ll-icon.is-working svg` | n/a at HEAD | `animation: none` for the learning-loop spinner (4817). Recorded for completeness: no file under `src/` emits an `.mva-ll-` class at HEAD, so this section is currently unreferenced CSS — the guard is correct, its subject is dormant |

**Verdict on blocks 2 and 5 (491 `.mva-jump-pill`, 2589 `.mva-ask-opt`): pass,
but only because 3660 seals them.** Both replace a two-property transition with
a one-property transition rather than removing it, so on their own they would
leave a 0.14s animated property running under `prefers-reduced-motion`. Both
elements are descendants of `.mva-root`, and 3660's
`transition-duration: 0.001ms !important` (line 3671) is `!important` and later
in source order, so the surviving property's duration is forced to near-zero
anyway. Net behaviour is correct. Recorded as an explicit verdict rather than
left invisible, because the pattern is fragile: if either element ever moves
out of `.mva-root`, its narrowing block becomes a silent reduced-motion leak.
Not proposed as a FIX (no behaviour is wrong at HEAD); noted in the
carried-forward list.

### Out-of-root render targets, enumerated

The blanket at 3660 only reaches `.mva-root` descendants plus the two selectors
it names. Every Exo surface that renders elsewhere, and the block that covers
it:

| Surface | Where it is attached | Covered by |
|---|---|---|
| `.mva-settings-tab` strip | Obsidian's settings modal | 3660 (named explicitly) |
| `.exo-mention-popover` | body-anchored | 3660 (named explicitly) |
| `.mva-ie-spin` (inline-edit modal spinner) | `.modal-container` — `src/ui/inline-edit.ts:25`, `dream-modal.ts:34`, `note-diff.ts:21`, `prompt-vars.ts:37` all add `.mva-ie-modal` | 3091 |
| `.mva-inai-bar` | `document.body` — `src/editor/inline-ai.ts:145` | 4354 |
| `.mva-inai-actionbar` | `document.body` — `src/editor/inline-ai.ts:323` | 4354 |
| `.mva-inai-panel` | `document.body` — `src/editor/inline-ai.ts:359` | 4354 |
| `.mva-inai-streamchip` | `document.body` — `src/editor/inline-ai.ts:376` | 4354 |
| `.mva-ck` (Exo Cockpit view) | `contentEl.addClass("mva-ck")` — `src/ui/cockpit-view.ts:75`, **not** `mva-root` | **no block, and none needed** — `styles.css` carries **38 `.mva-ck` rules: 37 inside the Cockpit section (4765–4811) plus one at 5063** (`.mva-ck-att.is-proposal .mva-ck-att-icon`, which lives in the Proposal Kernel section because that is where the proposal-attachment tint is defined, outside both the stated range and the Cockpit banner). Zero of the 38 declare `transition` or `animation`. Verified, not assumed: `grep -n '[.]mva-ck' styles.css` piped through a `transition|animation` filter returns 0 across all 38. |

The Orchestration Board (`src/ui/board-view.ts:132`) and the Connections pane
(`src/ui/connections-view.ts:63`) both add `mva-root` to their own container, so
they are inside the blanket despite being separate leaf views. The four modal
families (`.mva-ie-modal`, `.mva-auto-modal`, `.mva-task-modal-window`,
`.mva-proposals-window`) declare no `animation:` at all; their only animated
child is `.mva-ie-spin`, covered above.

**Conclusion, restated on the real enumeration:** all 20 second-unit
`animation:` shorthands and every transitioned surface are reached — 14 loops
plus every in-root transition by 3660 (with 4817 belt-and-braced at 4820), `.mva-ie-spin` by 3091, the four
`.mva-inai-` surfaces by 4354, `.mva-ck` by having nothing to guard. No
uncovered animated surface. The previous revision of this doc reached the same
conclusion from a three-block enumeration that was simply wrong; the verdict
survives, the evidence has been replaced.

---

## §4 Empty-state pattern

Kit whisper recipe: `color: var(--text-faint); font-size: var(--font-ui-smaller)`.
Kit micro-label recipe is audited in §2 (all 16 eyebrows).

| Surface | Desktop | Phone | Verdict |
|---|---|---|---|
| `.mva-recap-empty` (336) | `var(--font-ui-smaller, 12px)` + `--text-faint` | N/A — the whisper recipe is one recipe across columns, and the Recap Rail is `is-wide` desktop chrome | **pass** — matches the whisper recipe verbatim. |
| `.mva-ck-empty` (4808, Cockpit) | `var(--text-faint)` + `var(--font-ui-smaller)` | N/A — same single recipe; the Cockpit is a desktop leaf view (`src/ui/cockpit-view.ts`) | **pass** — verbatim. |
| `.mva-auto-empty` (4862, automations) | `var(--font-ui-smaller)` + `--text-faint` | N/A — same single recipe; the automations modal cannot open on a phone | **pass** — verbatim. |
| `.mva-proposals-empty` (5061) | `var(--text-faint)` + `var(--font-ui-smaller, 12px)`, split from the shared `.mva-proposals-loading` block at 5051 so only the empty half whispers | N/A — same single recipe; Proposal Kernel and the Foundry editor are desktop-only panes | **pass** — and the split is correct: a loading state is not an empty state and keeps body weight. |
| `.mva-conn-empty` (5139, "No MCP servers found." / "No external skills to import.") | `var(--text-faint)` + `var(--font-ui-smaller, 12px)` | N/A — same single recipe; the Connections pane enumerates MCP servers spawned as Node child processes, structurally impossible on mobile | **pass** — was `--text-muted` at 13px before this wave; corrected in `2c660fa`. |
| `.mva-board-placeholder` (4416–4438, flag-off explainer: icon + `<h3>` "Orchestration is off" + a `<p>` at 13px `--text-muted`) | reads as a titled block, not a whisper | N/A — the MUST NOT reads the same on both columns; the Orchestration Board is behind a desktop feature flag | **waived** — the kit's MUST NOT targets *empty* states reading as titles. This is a feature-off explainer whose paragraph carries the only affordance telling the user how to enable the pane ("Turn on the Orchestration Board in Exo settings…"). Demoting it to faint 12px hides an actionable instruction. Same verdict class as Horizon's card-content waiver. |
| `.mva-empty` (1673–1828, chat welcome hero: star, greeting, starter chips) | an onboarding hero with a breathing aura and staggered entrance | N/A — a welcome hero is outside the rule on both columns, and it only ever paints on desktop | **pass, different pattern** — not an empty state; the kit has no rule for a welcome hero, and treating one as a whisper would delete the plugin's front door. |
| `.mva-ie-loading` (3073, inline-edit spinner) | a loading state, not an empty state | N/A — §4 carries no phone-specific clause about loading states, and none renders on phone anyway | **waived, not in scope** — §4 governs "no X found" messages; a spinner is neither. |

---

## §5 Microcopy voice

| Rule | Desktop | Phone | Verdict |
|---|---|---|---|
| MUST NOT: native `<select>` — chip + popover only | zero `createEl("select")` and zero `<select>` literals in `src/`; the three occurrences the grep finds are *comments documenting the ban* (`automations-modal.ts:6`, `task-modal.ts:15`, `task-modal.ts:122`). The chip + `.mva-sel-pop` pattern is implemented in `composer.ts`, `task-modal.ts`, `automations-modal.ts` | N/A — the chip-and-popover MUST NOT reads identically on both columns; Exo's custom forms only ever render on desktop | **pass** — Exo is the plugin that authored this convention and follows it in every custom form. |
| MUST NOT: native `<select>`, settings-tab exception | `src/settings.ts` uses Obsidian's `Setting.addDropdown()` at **11 sites** (378, 410, 422, 498, 625, 692, 709, 815, 847, 926, 1300 — the last being the MCP-server transport picker in the add-server form) — `addDropdown` renders a native `<select>` | N/A — Obsidian's settings tab exists on phone, but Exo never appears in it, so the 11 native selects are unreachable from a phone. The waiver is a scope decision, not a platform one | **waived, out of program scope** — the letter of the MUST is unmet, and it is worth saying plainly rather than passing it as "native API therefore fine". Two reasons it is not a FIX here: (a) the program design doc puts settings screens explicitly out of scope ("Fuori scope per scelta: Home/ingresso, **settings screens** (in coda, non persi)"); (b) Sonar wave 1 and Horizon wave 5 both passed on the identical pattern, so fixing it in Exo alone would break suite consistency in the opposite direction. Replacing 11 dropdowns with `.mva-sel` chips is a settings-screen rework, not a coherence substitution. Carried, named. |
| MUST NOT: any button carries `mod-cta` | zero hits in `src/` and in `styles.css` | N/A — the `mod-cta` ban is platform-neutral; zero hits on either column | **pass** |
| `.mva-btn` button convention | used in 10 files (`view.ts`, `automations-modal.ts`, `inline-edit.ts`, `note-diff.ts`, `dream-modal.ts`, `proposals-modal.ts`, `prompt-vars.ts`, `connections-view.ts`, `task-modal.ts`, `editor/inline-ai.ts`); base rule at 2687 | N/A — the button convention does not vary by platform; all 10 call sites are desktop-only code paths | **pass** — Exo defines the convention and applies it. |
| `.mva-pv` / `.mva-pv-input` label + input convention | used in `prompt-vars.ts`, `task-modal.ts`, `automations-modal.ts`, `proposals-modal.ts`; canonical recipe at 3097, reused verbatim by the task modal (4661) and the automations modal (4838) | N/A — the same form recipe on both columns; the four modals never open on a phone | **pass** |
| Labels are sentence case, never Title Case or ALL CAPS | swept every quoted UI string in `src/ui/` and `src/settings.ts`. One ALL-CAPS hit (`"MCP"`, `connections-view.ts:72`) — an acronym, not a shouted label. Two Title-Case hits (`"Exo Cockpit"`, `"Daily Pulse"`) — proper feature names, one of them a stored automation identifier (`core/daily-pulse.ts:11`). Uppercase eyebrows are CSS-driven (`text-transform`), which is the kit's own sanctioned exception | N/A — sentence case is platform-neutral, and these are the same strings on any platform | **pass** |
| Product-surface copy is English | `src/ui/` is English end to end after `0be8ea7` / `d6bb132`; `src/core/cockpit.ts`, `src/main.ts`, `src/queue.ts` swept in the same commits | N/A — copy language does not vary by platform | **pass for `src/ui/`** |
| Product-surface copy is English — settings | `src/settings.ts:1002` label `"Exo Queue — Exo in tasca"` and `:1004` description, fully Italian: *"Il desktop evade le note-richiesta scritte (dal telefono, via Obsidian Sync) nella cartella coda: esegue il corpo della nota headless e READ-ONLY e appende la risposta nella stessa nota, che sincronizza indietro. Poll ogni 60s."* Also the two doc-comments at `:159–162` | N/A — worth stating because it reads backwards: the Italian string *describes* the phone workflow (notes written on the phone, drained by the desktop over Sync) yet renders only in the desktop settings tab, which is the sole surface Exo has | **FIX** — this is the last Italian product surface in the plugin, and it is the one the previous sweep missed (its heuristic word list ran with a 140-character bound; this string is 224 characters, so it fell through). Proposed change: `.setName("Exo Queue")` and `.setDesc("The desktop drains request notes written from your phone (via Obsidian Sync) in the queue folder: it runs the note body headless and READ-ONLY, then appends the answer to the same note, which syncs back. Polls every 60s.")`. Note the deliberate loss of "Exo in tasca" from the label — it is Italian branding, not a PM term, so the "PM jargon stays untranslated" carve-out does not cover it; the phrase survives in the Italian doc-comment at `:159`, which is code, not product surface. |
| PM jargon left untranslated | "automation run", "drain", "inbox", "loop", "recall", "sandbox", "playbook" all kept as-is in English copy | N/A — the jargon policy is platform-neutral | **pass** |
| Vault-note content and model-input strings | `src/queue.ts` request-note protocol headings, the Italian Morning Digest prompt template (`main.ts:134`), the bilingual BM25 stopword lists (`core/memory-store.ts`, `mentions/tokenizer.ts`) | N/A — these are vault content and model input, not chrome, on any platform | **waived** — none is plugin chrome. The queue headings are matched against notes Exo has already answered (changing them orphans existing answers) and are pinned by `tests/queue-retry.test.ts`; the digest template is model input; the stopword lists are language data whose translation breaks Italian recall. |

---

## Proposed FIX list for the next step (6 items, ordered by leverage)

| # | File / line | Change | Risk |
|---|---|---|---|
| 1 | `styles.css:13` | `--mva-t: 0.14s ease;` → `--mva-t: var(--mv-t, var(--cosmos-t-fast, 0.14s)) ease;` | low — identical standalone; ~50 transitions gain token-level reduced-motion under Cosmos |
| 2 | `src/settings.ts:1002–1005` | Italian label + description → English (exact copy in §5) | low — string only; check no test pins the label |
| 3 | `styles.css:10` | `--mva-r1: 6px;` → `--mva-r1: var(--mv-r1, 6px);` | none — both values are 6px |
| 4 | `styles.css` 963, 3040, 3192 → `var(--mva-r2, 9px)`; 4270, 4288, 5112 → `var(--mva-r1, 6px)` | align six dead fallbacks to their real token values | none — unreachable branch |
| 5 | `styles.css:3968–3980` | `.mva-outline-tick` width-animation → `transform: scaleX()` (exact recipe in §3; the two declarations that change are 3975 and 3978) | low — 2px bar, right-anchored, pixel-identical |
| 6 | `styles.css:4470` — the `font-size` declaration in the `.mva-board-col-title` block (4469–4475), whose `text-transform: uppercase` is the eyebrow marker at 4473 | `font-size: 12px;` → `font-size: var(--font-ui-smaller);` (the only literal-12px eyebrow; see §2) | none — `--font-ui-smaller` is 12px, so zero rendered delta |

Optional companion to #1, same class and free: `styles.css:14`
`--mva-ease-out: cubic-bezier(0.22, 1, 0.36, 1);` →
`--mva-ease-out: var(--mv-lift, cubic-bezier(0.22, 1, 0.36, 1));` — the kit
records these as the same bezier.

## Carried forward (open kit MUSTs, deliberately not closed)

Each has a waiver row above with its reason; listed together so a later wave
inherits a to-do list rather than an archaeology task.

1. **`--mva-r2: 9px` vs `--mv-r-card: 11px`** (§1) — needs a suite design call
   on which number wins before it can become a token consumption.
2. **Micro-label typography** (§2) — 14 eyebrows once FIX #6 lands (15 at HEAD) at 9.5–11px / weight 600–650
   vs the kit's `--font-ui-smaller` / `--font-medium` recipe. Needs a wave whose
   stated intent is the size change.
3. **`.mva-inputwrap.is-anim .mva-input` height animation** (§3) — composited-
   properties MUST, unfixable in CSS alone; needs composer grow-behaviour work.
4. **11 native `addDropdown` selects in `src/settings.ts`** (§5) — blocked by
   the program's own "settings screens out of scope" decision, and by suite
   consistency with the Sonar/Horizon precedent.
5. **Palette fallback drift** (§0) — three green literals and two orange
   literals for the same semantic tiers. Not a kit violation; a palette pass.
6. **Reduced motion — closed on coverage, one fragility noted.** Listed here so
   the next wave inherits the real shape of the file: there are **13**
   `prefers-reduced-motion` blocks, at 459, 491, 625, 1758, 2589, 2681, 2951,
   3091, 3660, 4048, 4354, 4756, 4820 (full roles in the §3 sub-table). Two are
   load-bearing (3091 for the inline-edit modal spinner, 4354 for the four
   body-anchored `.mva-inai-` surfaces); the blanket is 3660, **not** 3659,
   which is its comment line. Coverage is complete — no uncovered animated
   surface. The one thing left open: blocks 491 (`.mva-jump-pill`) and 2589
   (`.mva-ask-opt`) *narrow* their transition list instead of removing it, and
   are only made safe by 3660's `!important` at 3671. If either element is ever
   moved out of `.mva-root`, that becomes a silent leak. Not a FIX (nothing
   misbehaves at HEAD), but the next wave should not treat those two blocks as
   self-sufficient.

## Not touched (explicit non-goals, confirmed)

- No CSS or TS was modified in this step. It is documentation-only.
- No layout or DOM change is proposed anywhere; every FIX above is a value or
  token substitution on an already-existing declaration, plus one string.
- The provider brand literals in `src/providers/` — runtime brand accents, not
  a stylesheet surface.
- `styles.css:3776` bare `#fff` — artifact-iframe paper, waived with reason.

## Verification of this step

- `docs/2026-07-mv-kit-audit.md` is the only file this commit stages; `styles.css`,
  `src/ui/` and `src/settings.ts` are byte-identical to the previous commit
  (not to `e0eb74d` — see "State of the tree").
- Every grep quoted above was re-executed against the working tree at HEAD for
  this revision, and every stated count re-derived rather than carried over.
  Hit counts stated: 5168 lines; 50 hex; 7 `ms` hits of which 6 raw;
  6 `!important`; 0 theme-token redefinitions; 217/217 balanced comment
  markers; 11 token consumption sites; 16 uppercase micro-labels; 20 second-unit
  `animation:` shorthands; **16** `infinite` loops; **13**
  `prefers-reduced-motion` blocks (459, 491, 625, 1758, 2589, 2681, 2951, 3091,
  3660, 4048, 4354, 4756, 4820); 11 `addDropdown` call sites; **56 rule blocks
  naming `.svg-icon`, of which 53 declare a px width** (11/12/13/14/15/16/40/42px
  — no 18px, no 22px) and 3 inherit; 22 files in `src/ui/`; 59 coverage ranges.
- **Corrections applied in this revision** (rev 3), recorded so the delta is
  auditable:
  1. §2 icon inventory said "explicit px on `.svg-icon` at 57 sites
     (12/13/14/16/18/22px)". Wrong three ways: 56 blocks name `.svg-icon` (the
     57th grep hit is the continuation selector at 1945), only 53 declare a
     width, and the real set is 11/12/13/14/15/16/40/42px — **there is no 18px
     and no 22px `.svg-icon` in the file**. The four `width: 22px` lines are
     boxes; the single 18px `svg` is 4768 `.mva-ck-mark svg`. Row and
     Verification bullet both rewritten, and the three width-less rules named.
  2. `.mva-ck` said "the 38 rules in 4765–4811" — that range holds 37; the 38th
     is at 5063, outside both the range and the Cockpit section. The
     zero-`transition`/`animation` verdict is unchanged and still holds for all
     38; the range/count pairing is now stated correctly.
  3. Golden-rule fallback itemization double-counted: the 7 literal-terminating
     sites are `0.18s` (533), `120ms` (2938), one radius `8px` (4942) and
     **four** `rgba()` recipes (4138, 4174, 4317, 4944) — the previous text
     listed "three `rgba()` … one radius" *and* `8px`, counting 4942 twice.
  4. The premise section's own verification was self-falsifying: it printed the
     command with bare pipes and claimed 0, while the command's own text made
     the count 1. Restated in the non-self-matching bracket form already used
     for the comment-terminator check, and this bullet uses the same form so it
     does not reintroduce the hit.
  5. §2's micro-label tail dismissed the free swap as "already complies". The
     one literal-12px eyebrow is `.mva-board-col-title` (4470) and it does *not*
     use the token — it is a genuine zero-delta fix, now promoted to **FIX #6**.
     `.mva-proposals-kind` (5016) already uses the token and is not a
     literal-12px site.
  6. Radius histogram corrected and its unit of count made explicit: it counts
     the 139 `border-radius:` shorthands, so `var(--radius-m)` is **3** (not 4;
     the 4th is the `var(--radius-m, 8px)` at 4083, now listed separately).
     Longhand 694 and the alias at line 21 are called out so file-wide `grep -o`
     totals (40 `var(--mva-r1)`, 22 `var(--mva-r2)`) reconcile with the table.
  7. `.mva-outline-tick` line numbers reconciled: the pair spans 3968–3980 in
     both §3 and the FIX list, and the `width: 22px` to replace is at 3978
     (3977 is its selector).
  8. Hex group 5 / coverage row 5141–5168: the class is `.mva-conn-dot.is-failed`,
     which `connections-view.ts:228` toggles for `failed` **or** `needs-auth`.
     Coverage row 4963–5140 now also flags the 5136 hex, matching its siblings.
  9. The provenance claim that `bc530e2` / `1aa6a9c` came from prior sessions is
     withdrawn and replaced with the true account in "State of the tree".

  **Corrections carried from rev 2**, still standing:
  the reduced-motion enumeration was previously stated as 3 blocks (it is 13);
  the blanket block's `@media` line was stated as 3659 (it is 3660 — 3659 is its
  comment); the infinite-loop count was stated as 15 (it is 16), and the claim
  that 3670 caps all of them was wrong for the two out-of-root spinners; the
  out-of-root enumeration omitted the four body-anchored `.mva-inai-` surfaces
  and the Cockpit's `.mva-ck` container; nine coverage rows did not name the
  reduced-motion block inside their range; `.mva-conn-empty` (5139) was
  attributed to the 5141–5168 row instead of 4963–5140; the raw-`ms` command
  printed 7 hits against a 6-row table without saying so; and §1 / §4 / §5 phone
  cells carried a bare "N/A" with no reason. All are fixed above. The hex,
  `!important` and token-consumption accounting was re-verified unchanged.
- No line of this document contains the comment-terminating character pair
  the kit warns about; token families are written as "the --cosmos- and --mv-
  tokens" throughout.
- Phone verification: **N/A** — `isDesktopOnly: true`. `EmulateMobile` was not
  enabled (it kills Node-dependent plugins, Exo included).
- Live-vault visual check: not applicable to a documentation-only step.

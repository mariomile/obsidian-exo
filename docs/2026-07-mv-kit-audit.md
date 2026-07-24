# mv-kit audit — Exo (coherence wave)

Audit of `styles.css` (5168 lines) + `src/` against
`obsidian-cosmos-theme/docs/mv-kit.md`. Scope: coherence-only fixes
(radius / typography / icons / motion tokens / empty states / microcopy).
No layout redesign, no DOM restructure, no bulk normalization of the
stylesheet.

> **Provenance note — read this before trusting the verdicts.**
> The B1 audit file was not present in this repo when this wave started
> (siblings — sonar, portal, masonry, tabx, … — all carry one; exo did not:
> `git log --all -- docs/2026-07-mv-kit-audit.md` returns only the commit that
> created this file). The audit below was therefore performed **by the same
> agent that applied the fixes**, walking the kit's 5 sections plus the golden
> rule, and each item carries its post-fix verdict directly.
>
> **The verdict list is post-hoc and is therefore not an independent check.**
> A doc written after the fixes cannot prove "no fix was silently dropped" —
> it can only make the enumeration *checkable*. That is what the
> "§0 — audit-procedure sweep" section below is for: it lists every hit of the
> kit's own step-1 grep, with the exact commands, so a reviewer can re-run them
> and diff the hit list against the table rather than take this doc's word.

Per-rule verdict: **pass** (already compliant) / **fixed** (this wave) /
**waived** (rule doesn't apply here, or fixing it would exceed the
coherence-only boundary — reason given).

**Exo is `isDesktopOnly: true`** (`manifest.json`). Every phone-column rule
in the kit (§2 touch targets, §3 phone entrance recipes) is therefore
structurally N/A and marked waived once, here, rather than repeated per row.

---

## §0 — audit-procedure sweep (kit step 1), verbatim commands

The kit's own procedure step 1 is: *"grep the plugin's stylesheet for raw `ms` /
hex values outside a `var(--cosmos-*, fallback)` or `var(--mv-*, fallback)`
pattern."* Commands actually run, and their full hit lists, so completeness is
reproducible:

**Durations** — `grep -nE '(animation|transition)[^;]*[^-a-z(]([0-9.]+m?s)' styles.css | grep -vE 'var\(--(cosmos|mva)-'`
→ 24 hits. Every one appears in a §3 row below:

| Line(s) | Hit | Row |
|---|---|---|
| 172, 437, 890, 2047, 4817 | `mva-pulse` / `mva-ll-pulse` 1.1s–1.2s `infinite` | ambient loops — waived |
| 253, 869, 928, 1952, 3083, 4187 | `mva-spin` 0.8s–1.1s `infinite` | ambient loops — waived |
| 1566 | `mva-blink 1s … infinite` | ambient loops — waived |
| 1719 | `mva-breathe 4.5s … infinite` | ambient loops — waived |
| 2171 | `mva-shimmer 2s … infinite` | ambient loops — waived |
| 3847 | `mva-working-pulse 1.6s … infinite` | ambient loops — waived |
| 4622 | `mva-board-pulse 1.4s … infinite` | ambient loops — waived |
| 893, 896 | `animation-delay: 0.18s` / `0.36s` | loop phase offsets — waived |
| 1689 | `animation-delay: calc(var(--i, 0) * 70ms)` | entrance stagger — waived |
| 2928 | donut fill `220ms cubic-bezier(…)` | explicit inline "do not tokenize" — waived |
| 4034, 4042 | `mva-outline-flash 1s` / `mva-flash 1s` (one-shot) | attention flashes — waived |
| 3669, 3671 | `0.001ms !important` inside `@media (prefers-reduced-motion)` | this *is* the reduced-motion implementation — pass |

Two former hits are gone because they were fixed: `styles.css:533`
(`.mva-turn`, now `var(--cosmos-t-base, 0.18s)`) and `styles.css:2938`
(`.mva-ctx-ring::after`, now `var(--cosmos-t-fast, 120ms)`).
`.mva-empty > *` (line 1688) is not in the grep's hit list because its easing
is already `var(--mva-ease-out)`; its 0.5s duration is covered by a §3 row
anyway.

**Hex** — `grep -nE '#[0-9a-fA-F]{3,8}\b' styles.css | grep -vE 'var\(--[a-z0-9-]+, *#' | grep -vE 'color-mix'`
→ **1 hit**: `styles.css:3776`. Every other hex in the file already sits inside
a `var(--color-…, #hex)` fallback (the kit-sanctioned shape).

| Line | Hit | Verdict |
|---|---|---|
| 3776 | `.mva-artifact-frame iframe { background: #fff; }` | **waived** — paper background for a sandboxed HTML artifact preview. The iframe renders third-party HTML authored against a white page; theming it to `--background-primary` would put dark-theme paper under black body text and make artifacts unreadable. Not a Cosmos surface, and no kit token covers "document paper". |

**Token definitions (MUST NOT)** —
`grep -nE '^\s*--(cosmos|mv)-[a-z0-9-]+\s*:' styles.css` → **0 hits**.
(The earlier revision of this doc recorded this check with `\|` inside an `-E`
pattern, where the backslash-pipe is a *literal* pipe and can never match. That
command proved nothing; the ERE above is the one that actually runs.)

**Italian product-surface copy (§5)** — a sweep of every quoted string in
`src/**/*.ts` filtered through an Italian-marker word list. The full command is
printed in §5 (it contains alternation pipes, so it lives in a fenced block, not
a table cell), together with its complete hit list and a verdict per hit.

---

## Golden rule — theme-independent consumption

Exo owns the `--mva-*` namespace; before this wave it consumed **zero** Cosmos
tokens directly. That architecture is preserved — the fixes below only add
**consumption with fallbacks**, so Exo renders identically with Cosmos absent.

**Correction to the previous revision of this doc.** It claimed Exo's `:root`
`--mva-*` declarations "are the bridge Cosmos overrides". That is false and was
the load-bearing premise under two §1 rows.
`grep -rn -- "--mva-" /path/to/obsidian-cosmos-theme --include='*.css'` returns
**only comments** (`cosmos-tokens.css:87-94`, `theme.css:3403-3410`, e.g.
`--mv-r1: 6px;` followed by a comment reading "= exo --mva-r1 · chip/toolbar").
Cosmos never *assigns* an
`--mva-*` property anywhere. The relationship is documentary parity, not a
runtime override. Rows corrected below.

| Check | Verdict |
|---|---|
| Kit MUST, verbatim: *"every `var(--cosmos-*)` / `var(--mv-*)` consumed by a plugin has a **literal fallback value** in the same declaration"* | **fixed for 6 of 10 new sites, waived for 4** — see the next row. |
| The 4 sites whose fallback is a native token, not a literal: `styles.css:964` (`var(--shadow-s)`), `:1065`, `:1244`, `:3995` (`var(--shadow-l)`) | **waived** — the pre-fix declaration at each of these four *was* exactly `box-shadow: var(--shadow-s/l)`. Terminating the chain in a literal would mean hand-copying Obsidian's native 3-layer shadow values into Exo, where they would silently drift from the app on every Obsidian release, for a branch that can only ever be taken if Obsidian defines no `--shadow-*` at all — which no supported build does. The MUST's stated purpose ("the plugin still looks correct with Cosmos absent") is met: with Cosmos absent these render byte-identically to before this wave. The letter of the MUST is not met, and this row is the record of that, deliberately **not** a restatement of the rule as "literal (or native-token) fallback". |
| The other 6 sites (`:4138`, `:4174`, `:4317`, `:4942`, `:4944`, and `.mva-turn` at `:533`) | **pass** — each terminates in a literal (`0 4px 14px rgba(0, 0, 0, 0.18)`, `8px`, `0.18s`, …) that is the pre-fix visual value. |
| MUST NOT: plugin stylesheet defines `--mv-…` / `--cosmos-…` at `:root` / `body` | **pass** — 0 hits. The runnable command is in §0 (it contains an alternation pipe, which cannot survive a markdown table cell without being mangled into the unrunnable form this doc was previously rejected for). Exo only ever defines `--mva-*`. |
| Exo's `:root { --mva-* }` block untouched | **pass** — the 5 declarations (`--mva-r1/r2/r3`, `--mva-t`, `--mva-ease-out`) are byte-identical to before this wave, and outside every hunk of this wave's diff. This is a **constraint imposed by the wave's brief**, not a claim that Cosmos overrides them. See the §1 `--mva-r1` row. |
| MUST NOT: token glob immediately followed by a slash inside a CSS comment | **pass** — zero hits in `styles.css` and in every touched `.ts` file. |

---

## §1 Radius + surfaces

| Surface | Verdict |
|---|---|
| Chip / toolbar radius — `:root { --mva-r1: 6px }` (`styles.css:10`) | **waived, with a real kit MUST left open.** Corrected verdict: `6px` is a hand-picked pixel value that visually matches the kit's "chip/toolbar" entry, so kit §1's MUST ("consumes the matching `--mv-r*` token … not a hand-picked pixel value") *does* apply. The sibling precedent landed exactly this (`obsidian-sonar`: `.sonar-chip` 7px → `var(--mv-r1, 6px)`). The byte-identical fix here is `--mva-r1: var(--mv-r1, 6px)`. It is **not** landed because this wave's brief pins the `:root { --mva-* }` block as untouchable ("Keep Exo's existing `:root { --mva-* }` block exactly as is"). That is the whole reason — not, as the previous revision claimed, that "Cosmos overrides `--mva-r1` directly" (it does not; see the golden-rule correction). **Carry to the next wave**, where the `--mva-*` block is in scope: one line, zero visual change. |
| Card radius — `--mva-r2: 9px` (`:root`), consumed via `--mva-card-radius` | **waived, value mismatch.** The kit's card token is `--mv-r-card: 11px`; Exo's card radius is 9px. Consuming `var(--mv-r-card, 9px)` would move every card 9px → 11px under Cosmos — a visual change, which this wave's contract forbids. Reconciling 9 vs 11 is a design decision for the suite, not a coherence fix. (The previous revision justified this row with the same non-existent bridge; this is the true reason.) |
| `--mva-r3: 13px` | **waived, value mismatch.** No `--mv-r*` / `--cosmos-r-*` entry carries 13px. Same reasoning as above. |
| `.mva-ac` (autocomplete popover) elevation, `:964` | **fixed** — `box-shadow: var(--cosmos-pop-shadow, var(--shadow-s))`. |
| `.mva-agents-list` (agents popover) elevation, `:1065` | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-l))`. |
| `.mva-sel-pop` (picker popover) elevation, `:1244` | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-l))`. |
| `.mva-outline-panel` (floating outline) elevation, `:3995` | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-l))`. |
| `.mva-inai-bar` (selection toolbar pill) elevation, `:4138` | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-s, 0 4px 14px rgba(0, 0, 0, 0.18)))`. |
| `.mva-inai-panel` (selection action panel) elevation, `:4174` | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-s, 0 6px 20px rgba(0, 0, 0, 0.2)))`. |
| `.mva-inai-streamchip` / `.mva-inai-actionbar` elevation, `:4317` | **fixed** — same recipe. |
| `.exo-mention-popover` elevation, `:4944` | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-s, 0 2px 8px rgba(0, 0, 0, 0.12)))`. |
| `.exo-mention-popover` radius, `:4942` (was a raw `8px`, the one popover not on `--mva-r2`) | **fixed** — `var(--cosmos-r-floating-surface, 8px)`. Identical standalone, concentric with every other floating surface under Cosmos. |
| `.mva-recap` panel shadow (`:307`, `var(--shadow-s)`) | **waived** — inline layout column (`.mva-root.is-wide .mva-recap`), not a floating surface; the kit scopes `--cosmos-pop-shadow` to menu/tooltip/popover/prompt. |
| `.mva-jump-pill` shadow (`:477`, `var(--shadow-s)`) | **waived** — a 30px round *control*, not a floating panel. Same reasoning. |
| `border-radius: 50%` (18 sites: dots, rings, avatars, auras) | **waived** — geometric circles, not a pill/card/chip surface. The kit's radius vocabulary has no entry for them. |
| `border-radius: 999px` (12 sites: pills, tracks, badges) | **waived** — round-cap idiom on fixed-height shapes. `--cosmos-r-fusion-tab: 999px` is semantically "fusion-flavour tab bar", not a generic 999px alias — same precedent as the Sonar wave. |
| `border-radius: 3px` / `4px` (9 sites: hairline bars, inline marks, tiny buttons) | **waived** — below the kit's smallest surface token (`--mv-r-chip: 5px`); adopting it would *change* the visual value. |

## §2 Type sizes, icon sizes, touch targets

| Surface | Verdict |
|---|---|
| Icon sizing | **pass** — Exo sets explicit px on `.svg-icon`; the kit records that Cosmos defines no separate icon-size scale, so there is no token to consume. |
| Connections refresh control rendered as the text glyph `↻` (`src/ui/connections-view.ts:74`) | **waived — DOM change, out of scope for a coherence-only wave.** This was briefly landed as `setIcon(refresh, "refresh-cw")` and has been **reverted**. Two reasons: (a) `setIcon` injects an `<svg>` child, i.e. a DOM change, which this wave's non-goals forbid outright; (b) no kit rule backs it — §2 only says "icons follow Obsidian's native icon-size tokens", there is no glyph→icon MUST in `mv-kit.md`. It was a self-granted audit item spent on the one explicitly forbidden category. If it is worth doing, it belongs in a wave that sanctions DOM edits, together with a `.mva-conn-refresh .svg-icon` sizing rule (the class currently sets only `margin-left: auto`, so an icon would render at Obsidian's default `--icon-size` while its `.mva-icon-btn` siblings declare 16px). |
| `--cosmos-touch-min` (44px) on tappable targets | **waived, N/A** — `isDesktopOnly: true`; Exo never renders on phone. |
| `--cosmos-press-scale` on tap targets | **waived, N/A** — same reason (phone-only MUST). |
| Micro-label type scale (~14 eyebrows at 9.5 / 10 / 10.5 / 11px, letter-spacing 0.04–0.06em, weight 600/650) | **waived** — converging them on the kit's verbatim recipe means changing ~14 font sizes to `--font-ui-smaller` (12px), i.e. visibly enlarging every eyebrow in the chat, plus a weight change. That is mass normalization with real visual regression risk — explicitly outside this wave's non-goals. Flagged for a dedicated typography wave where the size change is the *intent*, not a side effect. |

## §3 Motion

| Site | Before | After | Verdict |
|---|---|---|---|
| `.mva-turn` entrance, `:533` | `mva-pop 0.18s ease-out` | `mva-pop var(--cosmos-t-base, 0.18s) ease-out` | **fixed** — one-shot entrance on every turn; 0.18s is exactly the kit's `--cosmos-t-base` tier, so the fallback is byte-identical and it now zeroes with Cosmos under reduced motion. |
| `.mva-ctx-ring::after` hover wash, `:2938` | `background-color 120ms ease` | `background-color var(--cosmos-t-fast, 120ms) ease` | **fixed** — micro-feedback tier: 120ms standalone, 140ms under Cosmos. |
| `.mva-settings-tab` transition, `:4090` | `background 0.14s ease, color 0.14s ease, border-color 0.14s ease` | `background var(--mva-t), color var(--mva-t), border-color var(--mva-t)` | **fixed — DRY consolidation onto Exo's own duration token, nothing more.** `--mva-t` *is* `0.14s ease` (`styles.css:13`), so the value is byte-identical, and three raw literals collapse onto the token the other ~50 transitions in the file already use. **Correction to the previous revision**, which claimed it "rides the token Cosmos bridges to `--mv-t` and inherits reduced-motion zeroing": both halves were false. `--mva-t` is a hardcoded literal bridged by nothing (Cosmos assigns no `--mva-*`), and `.mva-settings-tab` renders in Obsidian's settings modal, outside `.mva-root` — see the reduced-motion row for how that gap was actually closed. |
| `prefers-reduced-motion: reduce` scope, `:3660` | blanket scoped `.mva-root *, ::before, ::after` only | `.mva-settings-tab` and `.exo-mention-popover` added to the same selector list | **fixed** — the blanket could not reach Exo's two out-of-root surfaces (settings-tab strip in the settings modal; body-anchored mention popover), so the kit's reduced-motion MUST was genuinely unmet there. Adding two selectors to an existing block closes it. This also repairs the previous revision's overclaim that "Exo satisfies the guarantee directly": it now does, on every surface Exo renders. |
| `.mva-ctx-ring` donut fill, `:2928` (`220ms cubic-bezier(0.16, 1, 0.3, 1)`) | — | unchanged | **waived** — carries an explicit inline directive at `:2927` ("… Do not tokenize this line"). A documented, deliberate exception predating this wave; overriding it would be a design decision, not a coherence fix. |
| `.mva-empty > *` entrance, `:1688` (`mva-rise 0.5s var(--mva-ease-out)`) + `:1689` stagger (`calc(var(--i, 0) * 70ms)`) | — | unchanged | **waived** — easing already tokenized. The nearest duration tier (`--cosmos-t-panel`, 300ms) would cut the signature entrance nearly in half, and no token matches a 70ms stagger step. Value change ≠ coherence fix. |
| `.mva-thinking-dot` stagger, `:893` (`animation-delay: 0.18s`) and `:896` (`0.36s`) | — | unchanged | **waived** — these are *phase offsets* into a 1.1s `infinite` loop (dot 2 at ⅓, dot 3 at ⅔ of the cycle), not transition durations; the kit's duration tiers describe how long a change takes, not where a loop starts. `0.36s` has no tier at all, so tokenizing only `0.18s` would break the stagger the moment `--cosmos-t-base` changed — a coherence fix that makes the surface *less* coherent. |
| Ambient loop animations — `mva-spin` (`:253`, `:869`, `:928`, `:1952`, `:3083`, `:4187`), `mva-pulse` (`:172`, `:437`, `:890`, `:2047`), `mva-ll-pulse` (`:4817`), `mva-working-pulse` (`:3847`), `mva-board-pulse` (`:4622`), `mva-breathe` (`:1719`), `mva-blink` (`:1566`), `mva-shimmer` (`:2171`) — 0.8s–4.5s, all `infinite` | — | unchanged | **waived** — loop cadences, not transitions. Every Cosmos duration tier tops out at 300ms; mapping a 4.5s breathing aura or a 1.6s working pulse onto one would destroy the effect. (This row now enumerates *every* loop keyframe in the file, not a sample — the previous revision named five and left `mva-working-pulse`, `mva-board-pulse` and `mva-ll-pulse` uncovered.) Reduced-motion is handled independently by the block above. |
| One-shot attention flashes — `mva-outline-flash 1s` (`:4034`), `mva-flash 1s` (`:4042`) | — | unchanged | **waived, value mismatch.** These are one-shot, so the loop waiver above does not cover them; they need their own row. But 1s is 3.3× the slowest Cosmos tier (`--cosmos-t-panel`, 300ms): tokenizing means the "where did I jump to?" highlight fades before the eye lands on it. A deliberate long-decay cue; changing it is a design call. Both are inside `.mva-root`, so reduced motion already zeroes them. |
| Animated properties | — | unchanged | **pass** on entrances (`transform`/`opacity` only). Two pre-existing layout-property transitions (`styles.css:1636` `height`, `:3975` `width`) violate the kit's composited-properties MUST: **waived, pre-existing and out of scope** — neither is on a line this diff touches, and converting them means a DOM/layout change, a hard non-goal here. Carry to a layout wave. |

## §4 Empty-state pattern

Kit whisper recipe: `color: var(--text-faint); font-size: var(--font-ui-smaller)`.

| Surface | Verdict |
|---|---|
| `.mva-recap-empty` | **fixed** — `font-size: 12px` → `var(--font-ui-smaller, 12px)`. Same 12px at default settings, now scaling with the user's font-size modifier. Colour was already `--text-faint`. |
| `.mva-conn-empty` ("No MCP servers found.", "No external skills to import.") | **fixed** — was `--text-muted` at `13px` (bigger than body copy, reading as a statement); now `--text-faint` at `var(--font-ui-smaller, 12px)`. This one *is* a deliberate visual change: it is the kit §4 MUST, and the "preserve the visual value" clause of the wave scopes to token-consumption sites, not to conformance fixes. |
| `.mva-proposals-empty` | **fixed** — the shared `.mva-proposals-empty, .mva-proposals-loading` block (`:5046`) stays as-is; a one-line rule after it gives *only* the empty half the whisper treatment. The loading half keeps body weight — it isn't an empty state. |
| `.mva-ck-empty`, `.mva-auto-empty` | **pass** — already `color: var(--text-faint); font-size: var(--font-ui-smaller)` verbatim. |
| `.mva-board-placeholder` (icon + `<h3>` "Orchestration is off" + instructions) | **waived** — a feature-off explainer with an actionable instruction ("Turn on the Orchestration Board in Exo settings…"), not a "no results" whisper. Demoting the heading to `--text-faint`/12px would hide the only affordance telling the user how to enable the pane. The kit's MUST NOT targets *empty* states reading as titles; a disabled-feature pane legitimately has one. |
| `.mva-empty` (chat welcome hero: star, greeting, starter chips) | **pass, different pattern** — an onboarding hero, not an empty state; the kit has no rule for it. |

## §5 Microcopy voice

**Correction to the previous revision.** It recorded §5 as `fixed` on the claim
that the Connections pane "was entirely Italian and was the only such surface in
the plugin". The first half was true; **the second half was false** — Italian
product-surface copy also shipped in `core/cockpit.ts`, `main.ts` and
`queue.ts`. The sweep below is the full hit list, every entry with a verdict.

Sweep command (run from the repo root):

```sh
grep -rnoE '"[^"]{5,140}"|`[^`]{5,140}`' src --include="*.ts" \
  | grep -iE '(^|[^a-zà-ù])(aspetta|un tuo|nessun|nessuna|scrivi|processare|rivedere|lavorando|bloccato|pronto|pronta|fallito|fallita|risposta|richiesta|tentativo|è|già|più|perché|della|dello|nella|nello|questo|questa|sono|viene|verrà|puoi|devi)([^a-zà-ù]|$)'
```

| Hit | Verdict |
|---|---|
| `src/ui/connections-view.ts` — 17 strings: section headers (`Connessi/Importabili/Ereditati` → `Connected/Importable/Inherited`), row states (`attivo`, `nel vault`, `già in Exo` → `active`, `in vault`, `already in Exo`), buttons (`Connetti/Importa/Rimuovi`), the have-summary line, both empty states, the overwrite `confirm()`, all 6 `Notice` strings | **fixed** — translated; 3 code comments quoting those strings updated to match. |
| `src/core/cockpit.ts:50` — `"${title}" aspetta un tuo OK` | **fixed** → `"${title}" is waiting for your OK` |
| `src/core/cockpit.ts:63` — `1 automation run da rivedere` / `${n} automation run da rivedere` | **fixed** → `1 automation run to review` / `${n} automation runs to review` (also fixes the missing plural). `tests/cockpit.test.ts:166,174` updated to match. |
| `src/core/cockpit.ts:67` — `"${title}" sta lavorando` | **fixed** → `"${title}" is working` |
| `src/core/cockpit.ts:70` — `Risposta pronta: ${name}` | **fixed** → `Answer ready: ${name}` |
| `src/core/cockpit.ts:165` — `Inbox da processare` | **fixed** → `Inbox to triage` |
| `src/main.ts:1971-1972` — scheduled-run OS `Notification`: title `"${name}" pronto/fallito`, both bodies | **fixed** → `ready` / `failed`, "The report is in the vault — click to open it." / "The run failed — the report has the error." |
| `src/main.ts:2013` — `Scrivi la richiesta nel corpo della nota — Exo risponde al prossimo drain.` | **fixed** → `Write the request in the note body — Exo answers on the next drain.` |
| `src/queue.ts:152-154` — the three drain `Notice` toasts (ready / retry / final failure) | **fixed** → `answer ready` / `attempt N failed — retrying later.` / `failed after N attempts.` |
| `src/core/cockpit.ts:86` — `Chiudiamo questo loop: ${title}` | **waived** — this is `action.arg`, the text seeded into the **chat composer**, not a UI label. It is Mario talking to Exo, and the vault's language rule is Italian for conversation, English for product surfaces. The label on the same row is English; the message it sends is not chrome. |
| `src/queue.ts:14,135` — `## Risposta (Exo · read-only)`; `:136` — `## Errore (Exo · tentativo N/M)`; `:138` — `*(risposta vuota)*`; `:139` — `errore sconosciuto`; `src/main.ts:2010` — the `Richiesta <date>` note filename | **waived** — these are **vault-note content under a documented protocol**, not plugin chrome. The heading is (a) matched against notes Exo has *already* answered, so changing it orphans existing answers, (b) part of the request-note contract documented in `queue.ts`'s header block, and (c) pinned by `tests/queue-retry.test.ts:26`. Exo Queue is a Mario-personal head; its notes are Italian by intent. |
| `src/main.ts:134` — `"N note in inbox da processare"` | **waived** — a line *inside the Italian Morning Digest prompt template*, i.e. model input, not user-facing copy. |
| `src/main.ts:452`, `src/view.ts:4623`, `src/view.ts:5405`, `src/ui/tools.ts:140`, `src/queue.ts:1-22` — `"Exo si è bloccato"`, `"sta lavorando"`, the queue architecture header | **waived** — **code comments** quoting Mario's own bug reports and feature names. Not product surface; §5 governs copy the user reads. |
| `src/core/memory-store.ts:215-224`, `src/core/learning-loop.ts:109`, `src/mentions/tokenizer.ts:28`, `src/mentions/mentions-core.ts:5` | **waived** — Italian **stopword / language data** for the bilingual BM25 recall tokenizer. Deleting or translating it breaks Italian recall. Not copy. |
| Sentence-case labels | **pass** — post-translation every label is sentence case; no Title Case, no ALL CAPS in source strings (uppercase eyebrows are CSS-driven, per §4). |
| No native `<select>` | **pass** — zero hits in `src/`; the codebase documents the chip+`.mva-sel-pop` convention in `automations-modal.ts` and `task-modal.ts`. |
| No `mod-cta` | **pass** — zero hits in `src/` and `styles.css`. |
| `.mva-pv` / `.mva-pv-input` / `.mva-sel` / `.mva-btn` form conventions | **pass** — Exo is the plugin that *defines* these conventions; the Connections pane already used `.mva-btn` / `.mva-pill`. |
| PM jargon untranslated | **pass** — "automation run", "drain", "inbox", "loop" all kept as-is. |

**Re-running the sweep on the post-fix tree returns 24 hits, every one of them
a `waived` row above** (queue protocol strings, the digest prompt template, code
comments, and the stopword lists) — no `fixed` row's string survives, and no hit
is unaccounted for. Two known limits of the command, stated so the next reviewer
doesn't have to discover them: the `{5,140}` length bound skips one long template
literal (`src/main.ts:2010`, the `Richiesta <date>` filename — listed and waived
above anyway), and the word list is a heuristic, not a language detector, so it
would miss Italian copy built entirely from words outside it. It is a sweep, not
a proof.

---

## Carried forward (open kit MUSTs, deliberately not closed here)

Not "silently dropped" — each has a waiver row above with its reason. Listed
together so the next wave inherits a to-do list, not an archaeology task:

1. **`--mva-r1: 6px` → `var(--mv-r1, 6px)`** (§1). A real MUST, byte-identical
   fix, blocked only by this wave's "don't touch the `:root { --mva-* }` block"
   constraint. Highest-value carry.
2. **`--mva-r2: 9px` vs `--mv-r-card: 11px`** (§1) — needs a suite design call
   on which number wins before it can be a token consumption.
3. **Micro-label typography** (§2) — ~14 eyebrows at 9.5–11px vs
   `--font-ui-smaller`; needs a wave whose stated intent is the size change.
4. **Layout-property transitions** `styles.css:1636` (`height`), `:3975`
   (`width`) (§3) — composited-properties MUST; needs DOM/layout work.
5. **Connections refresh glyph → icon** (§2, self-granted, not a kit MUST) —
   only in a wave that sanctions DOM edits, and with a `.svg-icon` sizing rule.

## Not touched (explicit non-goals, confirmed)

- No layout or DOM change anywhere. Every CSS fix is a value/token substitution
  on an existing declaration, plus one added one-line rule
  (`.mva-proposals-empty`) and two selectors added to the existing
  reduced-motion block.
- The `:root { --mva-* }` block — outside every hunk of this wave's diff.
- Pre-existing design-hook finding at `styles.css:753` (side-tab accent border)
  — not on a line this diff touches, requires layout work.

## Verification (real output, re-run on the committed state)

- `npx tsc -noEmit -skipLibCheck` — **0 errors**
- `pnpm lint` (`eslint src tests`) — **0 errors**
- `pnpm test` (vitest) — **98 test files, 1218 tests passed** (same totals as
  the pre-wave baseline; the two `tests/cockpit.test.ts` expectations pinning
  the runs label were updated in the same commit as the string)
- `pnpm build` — **success** (tsc + esbuild production, deployed to the vault
  plugin dir)
- `grep -nE '^\s*--(cosmos|mv)-[a-z0-9-]+\s*:' styles.css` — **0 hits**
- CSS comment balance — **217 comment-open markers, 217 comment-close markers**;
  zero token-glob-followed-by-slash pairs in `styles.css` or in any touched
  `.ts` file
- Live-vault visual check: **not performed this wave.** Fixes are verified by
  reading the resulting CSS against the kit; every Cosmos consumption carries
  the pre-fix value as its fallback, so the Cosmos-absent rendering is provably
  unchanged (the one intentional exception, `.mva-conn-empty`, is called out in
  §4).
- Phone verification: **N/A** — `isDesktopOnly: true`. `EmulateMobile` was not
  enabled (it kills Node-dependent plugins, Exo included).

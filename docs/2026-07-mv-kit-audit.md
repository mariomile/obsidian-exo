# mv-kit audit — Exo (coherence wave)

Audit of `styles.css` (5157 lines) + `src/ui/*` against
`obsidian-cosmos-theme/docs/mv-kit.md`. Scope: coherence-only fixes
(radius / typography / icons / motion tokens / empty states / microcopy).
No layout redesign, no DOM restructure, no bulk normalization of the
stylesheet.

> **Provenance note.** The B1 audit file was not present in this repo when
> this wave started (siblings — sonar, portal, masonry, tabx, … — all carry
> one; exo did not). The audit below was therefore performed here, walking
> the kit's 5 sections plus the golden rule, and each item carries its
> post-fix verdict directly.

Per-rule verdict: **pass** (already compliant) / **fixed** (this wave) /
**waived** (rule doesn't apply here, or fixing it would exceed the
coherence-only boundary — reason given).

**Exo is `isDesktopOnly: true`** (`manifest.json`). Every phone-column rule
in the kit (§2 touch targets, §3 phone entrance recipes) is therefore
structurally N/A and marked waived once, here, rather than repeated per row.

---

## Golden rule — theme-independent consumption

Exo's architecture is the *inverse* of the other plugins: it owns the
`--mva-*` namespace and Cosmos overrides those tokens from the theme side.
Before this wave Exo consumed zero Cosmos tokens directly. That architecture
is preserved — the fixes below only add **consumption with literal
fallbacks**, so Exo renders byte-identically with Cosmos absent.

| Check | Verdict |
|---|---|
| Every `var(--cosmos-…)` Exo consumes has a literal (or native-token) fallback | **fixed** — 10 new consumption sites, all with the current visual value as fallback (see §1/§3). |
| No plugin stylesheet defines `--mv-…` / `--cosmos-…` at `:root` / `body` | **pass** — verified post-fix: `grep -E '^\s*--(cosmos\|mv)-[a-z0-9-]+\s*:' styles.css` → zero hits. Exo only ever defines `--mva-*`. |
| Exo's `:root { --mva-* }` block untouched | **pass** — the 5 declarations (`--mva-r1/r2/r3`, `--mva-t`, `--mva-ease-out`) are byte-identical to before this wave. They are the bridge Cosmos overrides; retokenizing them would break that contract. |
| No token glob followed by a slash inside a CSS comment | **pass** — verified post-fix, zero hits in `styles.css` and in the touched TS file. |

---

## §1 Radius + surfaces

| Surface | Verdict |
|---|---|
| Chip / toolbar radius (`--mva-r1: 6px`) | **pass** — numerically identical to the kit's `--mv-r1: 6px`, and Cosmos overrides `--mva-r1` directly. The bridge already satisfies the rule. |
| Card radius (`--mva-card-radius: var(--mva-r2)`) | **pass** — same bridge; Cosmos owns the value. |
| `.mva-ac` (autocomplete popover) elevation | **fixed** — `box-shadow: var(--cosmos-pop-shadow, var(--shadow-l))`. |
| `.mva-agents-list` (agents popover) elevation | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-s))`. |
| `.mva-sel-pop` (picker popover) elevation | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-l))`. |
| `.mva-outline-panel` (floating outline) elevation | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-l))`. |
| `.mva-inai-bar` (selection toolbar pill) elevation | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-s, 0 4px 14px rgba(0, 0, 0, 0.18)))`. |
| `.mva-inai-panel` (selection action panel) elevation | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-s, 0 6px 20px rgba(0, 0, 0, 0.2)))`. |
| `.mva-inai-streamchip` / `.mva-inai-actionbar` elevation | **fixed** — same recipe as above. |
| `.exo-mention-popover` elevation | **fixed** — `var(--cosmos-pop-shadow, var(--shadow-s, 0 2px 8px rgba(0, 0, 0, 0.12)))`. |
| `.exo-mention-popover` radius (was a raw `8px`, the one popover not on `--mva-r2`) | **fixed** — `var(--cosmos-r-floating-surface, 8px)`. Identical standalone, concentric with every other floating surface under Cosmos. |
| `.mva-recap` panel shadow (`--shadow-s`) | **waived** — inline layout column, not a floating surface; the kit's `--cosmos-pop-shadow` rule scopes to menu/tooltip/popover/prompt. |
| Scroll-to-bottom circle button shadow (`--shadow-s`) | **waived** — a 30px round *control*, not a floating panel. Same reasoning as the `.mva-recap` row. |
| `border-radius: 50%` (18 sites: dots, rings, avatars, auras) | **waived** — geometric circles, not a pill/card/chip surface. Kit's radius vocabulary has no entry for them. |
| `border-radius: 999px` (12 sites: pills, tracks, badges) | **waived** — round-cap idiom on fixed-height shapes (full roundness regardless of box size). `--cosmos-r-fusion-tab: 999px` is semantically "fusion-flavour tab bar", not a generic 999px alias — same precedent as the Sonar wave. |
| `border-radius: 3px` / `4px` (9 sites: hairline bars, inline marks, tiny buttons) | **waived** — below the kit's smallest surface token (`--mv-r-chip: 5px`); adopting a token here would *change* the visual value, which this wave's contract forbids. |

## §2 Type sizes, icon sizes, touch targets

| Surface | Verdict |
|---|---|
| Icon sizing | **pass** — Exo sets explicit px on `.svg-icon`; the kit records that Cosmos defines no separate icon-size scale, so there is no token to consume. |
| Connections refresh control rendered as the text glyph `↻` | **fixed** — `src/ui/connections-view.ts` now calls `setIcon(refresh, "refresh-cw")`, the same mark the sibling Cockpit header uses. It was the only text-glyph "icon" in the plugin; every other `.mva-icon-btn` was already `setIcon`-driven. |
| `--cosmos-touch-min` (44px) on tappable targets | **waived, N/A** — `isDesktopOnly: true`; Exo never renders on phone. |
| `--cosmos-press-scale` on tap targets | **waived, N/A** — same reason (phone-only MUST). |
| Micro-label type scale (~14 eyebrows at 9.5 / 10 / 10.5 / 11px, letter-spacing 0.04–0.06em, weight 600/650) | **waived** — converging them on the kit's verbatim recipe means changing ~14 font sizes to `--font-ui-smaller` (12px), i.e. visibly enlarging every eyebrow in the chat, plus a weight change. That is mass normalization with real visual regression risk — explicitly outside this wave's non-goals. Flagged for a dedicated typography wave where the size change is the *intent*, not a side effect. |

## §3 Motion

| Site | Before | After | Verdict |
|---|---|---|---|
| `.mva-settings-tab` transition | `background 0.14s ease, color 0.14s ease, border-color 0.14s ease` | `background var(--mva-t), color var(--mva-t), border-color var(--mva-t)` | **fixed** — `--mva-t` *is* `0.14s ease`, so the value is byte-identical; it now rides the token Cosmos bridges to `--mv-t` and inherits reduced-motion zeroing. |
| `.mva-ctx-ring::after` hover wash | `background-color 120ms ease` | `background-color var(--cosmos-t-fast, 120ms) ease` | **fixed** — micro-feedback tier: 120ms standalone, 140ms under Cosmos. |
| `.mva-ctx-ring` donut fill (`220ms cubic-bezier(0.16, 1, 0.3, 1)`) | — | unchanged | **waived** — carries an explicit inline directive ("Sole sanctioned motion override … Do not tokenize this line"). A documented, deliberate exception predating this wave; overriding it would be a design decision, not a coherence fix. |
| `.mva-empty > *` entrance (`mva-rise 0.5s var(--mva-ease-out)`, `70ms` stagger) | — | unchanged | **waived** — easing already tokenized. The nearest duration tier (`--cosmos-t-panel`, 300ms) would cut the signature entrance nearly in half, and no token matches a 70ms stagger step. Value change ≠ coherence fix. |
| Ambient loop animations (`mva-spin`, `mva-pulse`, `mva-breathe`, `mva-blink`, `mva-shimmer`: 0.8s–4.5s, `infinite`) | — | unchanged | **waived** — loop cadences, not transitions. Every Cosmos duration tier tops out at 300ms; mapping a 4.5s breathing aura onto one would destroy the effect. Reduced-motion is already handled independently (see next row). |
| `prefers-reduced-motion: reduce` | — | unchanged | **pass** — Exo ships a blanket `.mva-root *` override zeroing `animation-duration` / `transition-duration` and forcing `animation-iteration-count: 1`, plus three targeted blocks. The raw-`ms` audit grep exists as a proxy for this guarantee; Exo satisfies the guarantee directly, which is why the loop waivers above are safe. |
| Animated properties | — | unchanged | **pass** on entrances (`transform`/`opacity` only). Two pre-existing width/height transitions (`styles.css:1636`, `:3970`) were flagged by the design hook: **waived, pre-existing and out of scope** — untouched by this diff, and converting them means a DOM/layout change, which is a hard non-goal here. |

## §4 Empty-state pattern

Kit whisper recipe: `color: var(--text-faint); font-size: var(--font-ui-smaller)`.

| Surface | Verdict |
|---|---|
| `.mva-recap-empty` | **fixed** — `font-size: 12px` → `var(--font-ui-smaller, 12px)`. Same 12px at default settings, now scaling with the user's font-size modifier. Colour was already `--text-faint`. |
| `.mva-conn-empty` ("No MCP servers found.", "No external skills to import.") | **fixed** — was `--text-muted` at `13px` (bigger than body copy, reading as a statement); now `--text-faint` at `var(--font-ui-smaller, 12px)`. |
| `.mva-proposals-empty` | **fixed** — the shared `.mva-proposals-empty, .mva-proposals-loading` block stays as-is; a one-line rule after it gives *only* the empty half the whisper treatment (`--text-faint` + `--font-ui-smaller`). The loading half keeps body weight — it isn't an empty state. |
| `.mva-ck-empty`, `.mva-auto-empty` | **pass** — already `color: var(--text-faint); font-size: var(--font-ui-smaller)` verbatim. |
| `.mva-board-placeholder` (icon + `<h3>` "Orchestration is off" + instructions) | **waived** — this is a feature-off explainer with an actionable instruction ("Turn on the Orchestration Board in Exo settings…"), not a "no results" whisper. Demoting the heading to `--text-faint`/12px would hide the only affordance telling the user how to enable the pane. The kit's MUST NOT targets *empty* states reading as titles; a disabled-feature pane legitimately has one. |
| `.mva-empty` (chat welcome hero: star, greeting, starter chips) | **pass, different pattern** — an onboarding hero, not an empty state; the kit has no rule for it. |

## §5 Microcopy voice

| Rule | Verdict |
|---|---|
| Product-surface copy is English | **fixed** — the Connections pane (`src/ui/connections-view.ts`, shipped in 0.27.0) was entirely Italian and was the only such surface in the plugin. 17 strings translated: section headers (`Connessi/Importabili/Ereditati` → `Connected/Importable/Inherited`), row states (`attivo`, `nel vault`, `già in Exo` → `active`, `in vault`, `already in Exo`), buttons (`Connetti/Importa/Rimuovi` → `Connect/Import/Remove`), the have-summary line, both empty states, the overwrite `confirm()`, and all 6 `Notice` strings (success + failure). Three code comments quoting those strings were updated to match. |
| Sentence-case labels | **pass** — post-translation every label is sentence case; no Title Case, no ALL CAPS in source strings (uppercase eyebrows are CSS-driven, per §4). |
| No native `<select>` | **pass** — zero hits in `src/`; the codebase documents the chip+`.mva-sel-pop` convention in `automations-modal.ts` and `task-modal.ts`. |
| No `mod-cta` | **pass** — zero hits in `src/` and `styles.css`. |
| `.mva-pv` / `.mva-pv-input` / `.mva-sel` / `.mva-btn` form conventions | **pass** — Exo is the plugin that *defines* these conventions; the Connections pane already used `.mva-btn` / `.mva-pill`. |
| PM jargon untranslated | **pass** — n/a after the English pass. |

---

## Not touched (explicit non-goals, confirmed)

- No layout or DOM change anywhere. Every CSS fix is a value/token
  substitution on an already-existing declaration, plus two one-line rules
  (`.mva-proposals-empty`, and a clarifying comment pair).
- Micro-label typography normalization (§2) — deferred to a wave whose
  stated intent is the size change.
- The `:root { --mva-* }` block — Exo's namespace, Cosmos's override target.
- Pre-existing design-hook findings at `styles.css:753` (side-tab accent
  border), `:1636` and `:3970` (width/height transitions) — none are on a
  line this diff touches, and all three require layout/DOM work.

## Verification (real output, this wave)

- `npx tsc -noEmit -skipLibCheck` — **0 errors**
- `pnpm lint` (`eslint src tests`) — **0 errors**
- `pnpm test` (vitest) — **98 test files, 1218 tests passed** (identical to
  the pre-fix baseline: no test asserts on the translated strings)
- `pnpm build` — **success** (tsc + esbuild production, deployed to the vault
  plugin dir)
- Live-vault visual check: **not performed this wave.** Fixes are verified by
  reading the resulting CSS values against the kit; every Cosmos consumption
  carries the pre-fix value as its fallback, so the Cosmos-absent rendering
  is provably unchanged.
- Phone verification: **N/A** — `isDesktopOnly: true`. `EmulateMobile` was not
  enabled (it kills Node-dependent plugins, Exo included).

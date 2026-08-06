# Research armed — the charged field

**Date:** 2026-08-06
**Status:** approved by Mario (this session)
**Supersedes nothing.** Extends the composer surface of
[Research Mode v2](2026-07-21-research-mode-v2-design.md).

## Problem

Arming Research Mode is visually mute. The toggle built in v2 is icon-only by
design, so the entire feedback for entering a mode that mobilises a multi-agent
`deep-research` workflow is a 14px binoculars glyph changing colour.

Mario's verdict: clicking Research must show an effect that conveys we are doing
something powerful.

## Decisions (with Mario)

1. **The ceremony is at the click, not during the run.** The live workflow
   roster (`summarizeWorkflowRun`) stays as it is. This spec covers the arming
   moment only.
2. **The surface is the whole composer**, not the chip alone and not the whole
   pane. Weight of gesture matches weight of surface.
3. **Direction C — charged field.** A live energy ring on the composer border.
   Chosen over the "focus ring" and "briefing strip" alternatives.
4. **The charge lives on the border ring only, never on the fill.** The text
   surface stays inert: nothing moves under the caret.

## Design

### 1. The visual object

```
  disarmed                armed — ignition (once)             armed — steady
┌────────────────┐        ╭─▰▰▰▰▰▰▰──────────╮               ╭──────▰▰▰────────╮
│ Ask anything…  │        │                  │  bright dot   │                 │  dot drifts
│                │   →    │ Cosa devo        │  makes one    │ Cosa devo       │  slowly,
│ (o)  @  /  [>] │        │ investigare?     │  fast lap     │ investigare?    │  8s period
└────────────────┘        │ (o)  @  /   [>]  │               │ (o)  @  /  [>]  │
   neutral border         ╰──────────────────╯               ╰─────────────────╯
```

| Parameter | Value | Rationale |
|---|---|---|
| Geometry | 1.5px ring on the perimeter, radius `--mva-r3` | energy sits at the boundary of the surface, not inside it |
| Steady period | 8s per revolution | below the attention threshold: visible when looked at, not pulling the eye while typing |
| Amplitude | one bright dot over a base ring at 18% accent | a charge circulating on an already-lit filament, not a rotating rainbow |
| Ignition | one fast lap at full intensity, then decay to steady | the click gets its beat; what remains is discreet |
| Disarm | ring fades out, neutral border returns | |

Colour derives from `--mva-brand` with `--interactive-accent` fallback, via
`color-mix`. No new hex: Cosmos and product palettes keep control of the hue.

### 2. Motion technique

The gradient is **not** animated by moving `background-position` (repaint every
frame). It is a pseudo-element carrying a fixed `conic-gradient`, masked to a
ring, rotated with `transform: rotate()`. Transforms are composite-only, so a
permanently armed composer costs approximately nothing.

No JavaScript drives the animation. In Obsidian a `rAF` loop would be the worst
available choice — it starves when the pane goes idle — and it is unnecessary
here.

`prefers-reduced-motion`: the ring goes static. Same geometry, same colour, no
rotation. The state stays legible; only the motion is dropped.

### 3. State model — the ignition trap

`refreshResearch()` has five call sites, and only some are user gestures:

| Call site | Kind |
|---|---|
| `view.ts:2529` — `toggleResearchMode()` | gesture |
| `view.ts:6130` / `view.ts:6138` — `/research` start and exit | gesture |
| `view.ts:711`, `view.ts:1749` | conversation switch / restore — **not** a gesture |

Binding ignition to the armed *state* would replay the fast lap on every tab
switch into an already-armed conversation — the repeated firework this design
exists to avoid, fired without the user pressing anything.

So state splits in two:

```
   user gesture                              restore / tab switch
        │                                             │
        ▼                                             ▼
 refreshResearch({ ignite: true })          refreshResearch()
        │                                             │
        ├─ box.classList.add("is-research")           └─ box.classList.add("is-research")
        └─ box.classList.add("is-igniting")
                 │
                 │ animationend → remove
                 ▼
            steady state
```

`is-research` mirrors persisted state. `is-igniting` is ephemeral: it lives in a
DOM class and dies on `animationend`. Nothing new is persisted —
`researchMode.enabled` already exists, is already per-conversation, and is
already normalised on load.

### 4. Components

| File | Change |
|---|---|
| `src/ui/composer.ts` | keep a ref to the `.mva-inputbox` created at line 314; `refreshResearch(opts?: { ignite?: boolean })` applies the classes; `animationend` listener clears `is-igniting` |
| `src/view.ts` | the two gesture call sites pass `{ ignite: true }`; the restore call sites are untouched |
| `styles.css` | `.mva-inputbox.is-research` ring pseudo-element; `.is-igniting` lap; `prefers-reduced-motion` block |

`.mva-inputbox` is deliberately pinned to `--background-primary` in every state
("the composer must never repaint on hover or focus") because some themes tint
generic containers. The Research ring is not a violation of that rule: it is an
explicit mode class that out-specifies the pins on purpose. Win by specificity
and source order — never `!important`.

### 5. Design tokens

`src/style-contract.test.ts` fails the build when a raw `ms` value or hex
appears outside a `var()` fallback — a guard born from a real outage. The three
durations therefore become tokens, which doubles as the control panel for "how
charged is it":

- `--mva-research-ignite: 900ms` — the fast lap
- `--mva-research-spin: 8s` — the steady period
- `--mva-research-fade: 200ms` — the disarm fade

These are the starting values, defined once at the token declaration; every
rule below references them through `var()`.

### 6. Verification

1. **Unit** — pure logic: `ignite` reaches the composer only from the two
   gesture call sites. Asserted on the handler, not on the DOM.
2. **Contract** — `vitest run src/style-contract.test.ts` and `tsc`. The new
   tokens must survive the raw-value scan.
3. **Visual probe in Obsidian** — build into the vault, `loadIfDeferred()` on
   the Exo leaf, then **sample the pixels** on the border before and after the
   toggle. The style contract cannot see a ring rendered invisible by a theme
   override; the vault memory carries a precedent of dead CSS behind a green
   build.

## Out of scope

- Any change to how the running workflow is displayed. The live roster stays.
- Any change to the `<research-mode>` outbound contract or the workflow itself.
- Mobile: Exo is `isDesktopOnly`.

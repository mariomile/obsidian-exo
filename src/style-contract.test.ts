import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * mv-kit style contract (obsidian-cosmos-theme/docs/mv-kit.md).
 *
 * Ported from obsidian-sonar's src/style-contract.test.ts — same four
 * assertions, same scan regexes, same names. Encodes only the state landed by
 * the 2026-07 mv-kit audit wave for Exo — not aspirational rules the audit
 * didn't actually fix. See the audit note at docs/2026-07-mv-kit-audit.md for
 * the full per-value verdict; every waiver below cites its row there.
 */

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

/** Strip comments so `/* 80ms *\/`-style prose in doc comments doesn't
 * trip the raw-value scan below. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('mv-kit style contract', () => {
  // Regression guard for a real outage (2026-07-24): a comment written as
  // `--cosmos-*` immediately followed by a slash terminates the comment early.
  // Everything after it parses as garbage and the browser DROPS the enclosing
  // rule — which silently cost `.sonar-modal` its `width: 880px`, collapsing
  // the modal to Obsidian's 560px default. Invisible to eslint/tsc/vitest and
  // to the raw-value scan below, so it gets its own assertion.
  it('no CSS comment terminates early (token glob followed by a slash)', () => {
    const offenders = css
      .split('\n')
      .map((line, idx) => ({ line: line.trim(), n: idx + 1 }))
      .filter(({ line }) => /--[\w-]*\*\//.test(line));

    expect(offenders).toEqual([]);
  });

  it('stripping comments leaves no orphaned prose (structural parse check)', () => {
    // If a comment closed early, its remaining lines survive the strip as
    // stray ` * ...` prose sitting in declaration position.
    const orphans = stripComments(css)
      .split('\n')
      .map((line, idx) => ({ line: line.trim(), n: idx + 1 }))
      .filter(({ line }) => /^\*\s|^\*$/.test(line));

    expect(orphans).toEqual([]);
  });

  it('raw ms/hex/cubic-bezier values appear only as var() fallbacks', () => {
    const code = stripComments(css);
    const lines = code.split('\n');

    // A raw ms/hex/cubic-bezier is allowed ONLY when it sits inside a
    // `var(--cosmos-*, <fallback>)` or `var(--mv-*, <fallback>)` expression —
    // i.e. the line contains `var(--cosmos-` or `var(--mv-` before the raw
    // value. This is a line-level heuristic (matches the audit procedure in
    // mv-kit.md §"Audit procedure": grep for raw values outside a var()
    // fallback), not a full CSS parse.
    const rawMsPattern = /\b\d+ms\b/g;
    const rawHexPattern = /#[0-9a-fA-F]{3,8}\b/g;
    const rawCubicBezierPattern = /cubic-bezier\([^)]*\)/g;

    // ---- Sanctioned raw values -------------------------------------------
    // The scan regexes above are Sonar's, unmodified. Exo, unlike Sonar, still
    // carries raw values the 2026-07 audit examined one by one and knowingly
    // kept. Rather than loosen the scan, each survivor is enumerated here by
    // EXACT trimmed line content plus the EXACT matched value, with its
    // motivation and the audit verdict that sanctions it. A new raw value
    // anywhere else — or a change to one of these lines — fails the test.
    //
    // Source line numbers are given as `styles.css:N`; the numbers the failure
    // message prints are lower, because the scan runs on comment-stripped CSS.
    const SANCTIONED_RAW_VALUES: ReadonlyArray<{ line: string; value: string; why: string }> = [
      {
        // styles.css:14 — the easing token's own definition. A token has to
        // hold a literal somewhere; this is the one place a bezier is allowed
        // to be raw, and ~all motion in the file routes through it.
        // Audit verdict: "waived" — `--mva-ease-out` is the same bezier as the
        // kit's `--mv-lift`; docs/2026-07-mv-kit-audit.md §"Motion" row
        // `.mva-empty > *` entrance, and the proposed FIX at lines 535-536
        // (wrapping it in `var(--mv-lift, …)`) is explicitly byte-identical,
        // i.e. optional polish rather than a contract breach.
        line: '--mva-ease-out: cubic-bezier(0.22, 1, 0.36, 1);',
        value: 'cubic-bezier(0.22, 1, 0.36, 1)',
        why: 'token definition for --mva-ease-out; audit: waived (= --mv-lift value)',
      },
      {
        // styles.css:2928 — context-ring donut fill. Carries an inline
        // directive at 2925-2927: "Sole sanctioned motion override … Do not
        // tokenize this line." Audit verdict: "waived — a documented,
        // deliberate pre-existing exception". Reduced motion still reaches it
        // twice (blanket at 3660 + dedicated `transition: none` at 2951), so
        // only the tokenization MUST is traded, never the accessibility one.
        line: 'transition: background 220ms cubic-bezier(0.16, 1, 0.3, 1);',
        value: '220ms',
        why: 'context-ring donut fill; audit: waived, inline "do not tokenize this line" directive',
      },
      {
        // styles.css:2928, same declaration, bezier half of the same waiver.
        line: 'transition: background 220ms cubic-bezier(0.16, 1, 0.3, 1);',
        value: 'cubic-bezier(0.16, 1, 0.3, 1)',
        why: 'context-ring donut fill; audit: waived, same line as the 220ms above',
      },
      {
        // styles.css:3669 — inside the blanket `prefers-reduced-motion` block.
        // `0.001ms` IS the reduced-motion implementation: the standard
        // near-zero-not-zero idiom (a true 0 suppresses `animationend`).
        // Audit verdict: "pass — tokenizing it would be circular."
        // (The scan matches `001ms` because `\b\d+ms\b` starts after the dot.)
        line: 'animation-duration: 0.001ms !important;',
        value: '001ms',
        why: 'prefers-reduced-motion near-zero idiom; audit: pass, tokenizing would be circular',
      },
      {
        // styles.css:3671 — same block, transitions instead of animations.
        // Audit verdict: "pass — same, for transitions."
        line: 'transition-duration: 0.001ms !important;',
        value: '001ms',
        why: 'prefers-reduced-motion near-zero idiom (transitions); audit: pass',
      },
      {
        // styles.css:3776 — `.mva-artifact-frame iframe { background: #fff; }`.
        // Paper background for a sandboxed HTML artifact preview: the iframe
        // renders third-party HTML authored against a white page, so theming
        // it to --background-primary puts a dark surface under black body text
        // and makes artifacts unreadable. Audit verdict: "waived — it is not a
        // Cosmos surface and no kit token covers 'document paper'. Deliberate,
        // not leakage." (docs/2026-07-mv-kit-audit.md, hex group 11.)
        line: 'background: #fff;',
        value: '#fff',
        why: 'artifact-iframe paper background; audit: waived, no kit token covers "document paper"',
      },
    ];

    const isSanctioned = (line: string, value: string): boolean =>
      SANCTIONED_RAW_VALUES.some((entry) => entry.line === line && entry.value === value);

    const violations: string[] = [];

    lines.forEach((line, idx) => {
      // A raw value is allowed when it sits as the fallback inside ANY
      // var(--token, <fallback>) expression (native Obsidian tokens like
      // --color-base-00 included) — the contract's requirement is "never a
      // bare value", not "only --cosmos-*/--mv-* tokens may have fallbacks".
      const hasVarFallback = /var\(\s*--[\w-]+\s*,/.test(line);

      for (const pattern of [rawMsPattern, rawHexPattern, rawCubicBezierPattern]) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          if (!hasVarFallback && !isSanctioned(line.trim(), match[0])) {
            violations.push(`line ${idx + 1}: "${match[0]}" in "${line.trim()}"`);
          }
        }
      }
    });

    expect(violations).toEqual([]);
  });

  it('caps !important declarations at the post-mv-kit-audit count (ratchet down only)', () => {
    const importantCount = (css.match(/!important;/g) ?? []).length;
    // Ceiling set EXACTLY at the post-audit count in styles.css
    // (`grep -c '!important' styles.css` → 6 at the time of writing).
    // RATCHET DOWN ONLY: any edit that adds an `!important` without removing
    // one fails this test. Removing one and lowering this number is always
    // welcome; raising it requires a new audit verdict, not a bump.
    //
    // Each of the 6 survivors, with the docs/2026-07-mv-kit-audit.md verdict:
    //  - styles.css:1466 `opacity: 1 !important` (.mva-doc-x:hover) — waived,
    //    justified. `.mva-doc-card:hover .mva-doc-x { opacity: .7 }` is a more
    //    specific selector that always co-matches (the pointer is necessarily
    //    over the card while over the ×), so `!important` is the only way the
    //    hover-over-the-× state reaches full opacity without a selector rewrite
    //    for zero behavioural gain.
    //  - styles.css:3669 `animation-duration: 0.001ms !important` — pass,
    //    expected. Inside the blanket `prefers-reduced-motion` block;
    //    accessibility overrides are the canonical sanctioned use, and without
    //    it every animation shorthand declared later in the file would win.
    //  - styles.css:3670 `animation-iteration-count: 1 !important` — pass,
    //    expected. Same block; caps the in-root share of the file's 16
    //    `infinite` loops (14 of them) at a single cycle.
    //  - styles.css:3671 `transition-duration: 0.001ms !important` — pass,
    //    expected. Same block, transitions instead of animations.
    //  - styles.css:4064 `outline: 2px solid var(--interactive-accent)
    //    !important` — waived, justified. Obsidian core and several themes ship
    //    `outline: none` on buttons/`.clickable-icon` at equal-or-higher
    //    specificity and later in load order; without `!important` Exo's
    //    keyboard focus ring silently disappears. Same accessibility class as
    //    the reduced-motion block.
    //  - styles.css:4066 `box-shadow: none !important` — waived, justified.
    //    Companion to 4064: themes that replace the outline with a glow
    //    box-shadow would otherwise stack a second ring on top of Exo's.
    expect(importantCount).toBeLessThanOrEqual(6);
  });
});

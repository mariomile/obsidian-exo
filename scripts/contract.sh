#!/usr/bin/env bash
# Static design-contract preflight for Exo's stylesheet.
# Ported from obsidian-cosmos-theme/contract.sh (2026-08-11, the Cosmos Bridge
# wave) and cut down to the two metrics that matter for a plugin: raw colour
# hexes and `!important`. Both are ratchets: they may only go DOWN.
#
# Why a script and not another vitest assertion: this runs BEFORE the compiler
# on every `pnpm build`, so a stylesheet that quietly grows a hard-coded colour
# never reaches a bundle. The per-value verdicts stay in
# src/style-contract.test.ts; this file only holds the line.
#
# Run standalone (`bash scripts/contract.sh`) or via `pnpm contract`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - <<'PY'
import json, re, sys

contract = json.load(open('design-contract.json'))
target = contract['file']
css = open(target).read()


def strip_comments(source):
    return re.sub(r'/\*.*?\*/', '', source, flags=re.S)


code = strip_comments(css)
failures = []

hexes = len(re.findall(r'#[0-9a-fA-F]{3,8}\b', code))
if hexes > contract['raw_hex_max']:
    failures.append(
        f"{target}: raw hex x{hexes} > ceiling {contract['raw_hex_max']}: "
        f"a new hard-coded colour landed. Use a theme var or color-mix "
        f"(docs/design.md laws 1 & 4), or record a verdict in "
        f"docs/2026-07-mv-kit-audit.md and lower nothing."
    )

important = code.count('!important')
if important > contract['important_max']:
    failures.append(
        f"{target}: !important x{important} > ceiling {contract['important_max']}: "
        f"a new override landed. Win with specificity, or document the fight "
        f"the way the six survivors are documented in src/style-contract.test.ts."
    )

if failures:
    print('DESIGN CONTRACT VIOLATIONS:')
    for f in failures:
        print(f'  x {f}')
    sys.exit(1)

# A ratchet that never tightens is a ceiling nobody notices. Say the slack out
# loud so lowering the numbers is the obvious next move.
print(
    f'design contract OK ({target}: hex {hexes}/{contract["raw_hex_max"]}, '
    f'!important {important}/{contract["important_max"]})'
)
PY

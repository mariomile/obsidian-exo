#!/usr/bin/env node
// Static design-contract preflight for Exo's stylesheet.
// Ported from obsidian-cosmos-theme/contract.sh (2026-08-11, the Cosmos Bridge
// wave) and cut down to the two metrics that matter for a plugin: raw colour
// hexes and `!important`. Both are ratchets: they may only go DOWN.
//
// Why a script and not another vitest assertion: this runs BEFORE the compiler
// on every `pnpm build`, so a stylesheet that quietly grows a hard-coded colour
// never reaches a bundle. The per-value verdicts stay in
// src/style-contract.test.ts; this file only holds the line.
//
// Node, not python: Obsidian's review bot runs `pnpm build` in a clean
// environment without python3 (2026-09 review of 0.37.0).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(readFileSync(join(root, "design-contract.json"), "utf8"));
const target = contract.file;
const code = readFileSync(join(root, target), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const failures = [];

const hexes = (code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length;
if (hexes > contract.raw_hex_max) {
  failures.push(
    `${target}: raw hex x${hexes} > ceiling ${contract.raw_hex_max}: ` +
      "a new hard-coded colour landed. Use a theme var or color-mix " +
      "(docs/design.md laws 1 & 4), or record a verdict in " +
      "docs/2026-07-mv-kit-audit.md and lower nothing.",
  );
}

const important = code.split("!important").length - 1;
if (important > contract.important_max) {
  failures.push(
    `${target}: !important x${important} > ceiling ${contract.important_max}: ` +
      "a new override landed. Win with specificity (see the `#mva-never` " +
      "pattern in styles.css) instead.",
  );
}

if (failures.length) {
  console.log("DESIGN CONTRACT VIOLATIONS:");
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}

// A ratchet that never tightens is a ceiling nobody notices. Say the slack out
// loud so lowering the numbers is the obvious next move.
console.log(
  `design contract OK (${target}: hex ${hexes}/${contract.raw_hex_max}, ` +
    `!important ${important}/${contract.important_max})`,
);

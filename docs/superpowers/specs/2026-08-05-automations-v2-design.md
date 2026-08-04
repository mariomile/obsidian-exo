# Automations v2 — unified file-based automations

Approved by Mario 2026-08-05 (design Q&A in session).

## Problem

Automations today are two stitched-together systems with two UIs:

1. **Scheduled playbooks** — `settings.automations` (`AutomationConfig[]` in plugin `data.json`), edited only via chips in the hub tab. The prompt lives in `settings.customPrompts`, invisible from the tab.
2. **Agent contracts** — `_system/agents/<slug>.md` frontmatter (`autonomy: act`, `triggers: vault-event create _inbox/**`, `cooldown: 15m`, `read/write` globs). Schema-first, unreadable without knowing the schema; icons and menus are derived from these fields and look random; opening the md tells the user nothing.

Result: "what runs without me, when, and how do I change it?" has no single answer. Mario wants a Claude Code / Codex-grade system: readable definitions, a real editor, per-automation run history.

## Decisions (approved)

- **One unified model** — playbook automations and agent-trigger automations converge into one Automation concept. No backward-compat layers: old paths are migrated once and removed.
- **Editor lives in the hub** — md files are source of truth but never need hand-editing.
- **Per-automation run history** — timeline with outcome, report, diffs, restore.

## Data model

One file per automation: `_system/automations/<slug>.md`.

```markdown
---
name: Inbox Triager
description: Smista le note di _inbox verso la loro destinazione Object-OS
icon: inbox                     # lucide id, chosen in the editor from a curated set
when: "on create in _inbox/"    # or "daily 07:00" | "weekly mon 07:00" | "hourly"
mode: act                       # report (read-only) | propose | act (write, checkpointed)
scope: [_inbox, Atlas, Active]  # write scope folders; only meaningful for propose/act
agent: inbox-triager            # optional — delegate to a .claude/agents brain
enabled: true
---
Body = the full prompt/playbook, in prose. When `agent:` is set the body is
optional extra instruction layered on the brain; otherwise the body IS the prompt.
```

`when` grammar (parsed by pure core, round-trips through the editor):
- `hourly`
- `daily HH:MM` (minutes accepted, slot logic keeps hour granularity → `HH:00` normalized)
- `weekly <day> HH:MM` (English/Italian day names, as today)
- `on create|modify|rename in <path>` (vault-event trigger)
- `on tag #<tag>`

Multiple `when` lines allowed (frontmatter list) — same as multiple triggers today. `note-mention` is not an automation and stays out of this model (it remains agent invocation).

Cooldown: kept as optional `cooldown: 15m` frontmatter for event automations (default 15m), absent for schedules.

### What replaces what

| Today | v2 |
|---|---|
| `settings.automations` + `settings.customPrompts` pairing | Automation file, body = prompt |
| `_system/agents/<slug>.md` contract (triggers/autonomy/output/scope) | Automation file with `agent: <slug>` |
| `settings.scheduledRuns` legacy raw field | removed (already migrated once) |
| Global "Recent write runs" list | per-automation run timeline |

Agent **brains** (`.claude/agents/`) are untouched — still CLI-native, read-only. The contract sidecar concept disappears: `_system/agents/*.md` files are migrated into `_system/automations/` and then no longer read. Agents *without* unattended triggers keep working as invocable agents; they simply have no automation file.

`output` (report/journal/silent) collapses into `mode`: `report` mode → report note; `propose`/`act` → journal line + ledger (the current `journal` behavior). `silent` is dropped (YAGNI — nothing in the vault uses it deliberately).

### Migration (one-shot, on load)

1. For each `settings.automations` entry: create `_system/automations/<slugified-name>.md` with the matched custom prompt as body, `when` from cadence, `mode: act|report` from `write`. Daily Pulse keeps `system: daily-pulse` frontmatter key (built-in executor).
2. For each `_system/agents/<slug>.md` with unattended triggers: create automation file with `agent: <slug>`, mapped `when`/`mode`/`scope`/`icon`/`cooldown`. Move the old file to `.archive/` (never delete — vault rule).
3. Clear `settings.automations` and `settings.customPrompts` entries that were migrated; migration flag in settings prevents re-run.
4. Run records: re-key existing `automation-runs.json` entries by slug where derivable; otherwise keep them under a `legacy` key visible in the global fallback list.

## UI

### Automations tab = card list

Each automation is a card: icon, name, description, and a **sentence** ("Gira ogni giorno alle 07:00 · read-only · ultimo run 16h fa ✓" / "Gira quando crei una nota in _inbox · può modificare note"). Right side: Run now, enabled toggle. Click card → editor panel. No schema chips in the list. Off cards render dimmed.

### Editor panel (in-hub, replaces the row-of-chips editing)

Form fields, canonical `.mva-*` form language (`.mva-pv`, `.mva-sel-pop`, `.mva-btn` — never native selects):
- **Nome** + **Descrizione**
- **Icona** — curated lucide picker (grid popover)
- **Quando** — sentence builder: segmented "On a schedule / When something happens" → schedule (hourly/daily/weekly + time, day) or event (create/modify/rename + folder picker, tag). Live preview sentence.
- **Permessi** — 3 explained tiers: *Report* ("legge e scrive solo un report"), *Propose* ("propone modifiche, inerti finché non le accetti"), *Act* ("modifica direttamente, ogni run è ripristinabile"). Scope folder chips appear for propose/act.
- **Agente** (optional) — bind to a brain; shows brain description.
- **Prompt** — textarea editing the file body (+ "Open note" affordance).
- Delete (two-step) → archives the file.

Save writes the md file; the store watches `_system/automations/` so external edits (mobile, other harnesses) round-trip.

### Run history

Card footer "ultimo run …" → expands per-automation timeline (most recent first): outcome icon, started/duration, report link, touched files with NoteDiffModal, two-step Restore, mark-reviewed. Reuses existing checkpoint/restore machinery. Global "Recent write runs" section is removed; unreviewed-run attention pool (Cockpit) keys off the same records.

## Architecture

- `src/core/automation-model.ts` (new, pure): Automation type, `when` grammar parse/format, frontmatter (de)serialization, validation, sentence rendering (IT/EN per existing copy conventions in `agent-copy.ts`, which it largely absorbs).
- `src/core/automations.ts`: keeps slot/due logic (unchanged, tested); loses `AutomationConfig` in favor of the new model.
- `src/obsidian/automation-store.ts` (new, impure): scans `_system/automations/`, watches changes, writes files, owns migration.
- `src/main.ts`: executor swaps `settings.automations` iteration for store iteration; event triggers route through the same dispatcher agents use today; run records keyed by slug.
- `src/ui/hub/tab-automations.ts`: rewritten (card list + editor + history). Agent rows section disappears (unified).
- Settings tab: "Manage…" deep-link stays; customPrompts textarea removed.

## Error handling

- Unparseable automation file → card rendered in error state with the parse problem in plain words + "Open note"; never silently dropped, never crashes the tab.
- Invalid `when` on save → inline validation, save blocked.
- Migration failures per-item → notice + item left in place; migration flag only set when all items convert.

## Testing

- Pure core: `when` grammar round-trip, frontmatter round-trip, migration mapping (playbook→file, contract→file), due logic regression (existing tests keep passing).
- Manual gate in the live vault: Inbox Triager, Constitution Guard, Daily Pulse survive migration and fire; editor round-trips a file byte-stable modulo edited fields.

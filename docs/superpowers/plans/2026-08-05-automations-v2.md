# Automations v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two stitched automation systems (settings playbooks + agent contract sidecars) with one unified, file-based Automation model (`_system/automations/<slug>.md`), a real in-hub editor, and per-automation run history.

**Architecture:** A pure core module (`automation-model.ts`) owns the Automation type, the `when` grammar, and frontmatter round-trip. An impure store (`automation-store.ts`) scans/watches/writes the files and owns the one-shot migration. `main.ts` executor iterates the store instead of settings. The hub tab is rewritten as card list + editor panel + per-automation run timeline.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest. Spec: `docs/superpowers/specs/2026-08-05-automations-v2-design.md`.

## Global Constraints

- No backward-compat layers: migrated sources are archived/cleared, old code paths removed.
- Form language: `.mva-pv`, `.mva-sel-pop` popovers, `.mva-btn` — never native `<select>`, never `mod-cta` (memory: exo-plugin-form-language).
- Icons: lucide ids via `setIcon`, never emoji.
- Never delete vault files — move to `.archive/`.
- Pure core modules must not import `obsidian`.
- Existing slot/due logic in `core/automations.ts` (`currentSlotStart`, `isDue`, `nextDueAt`) is kept as-is.
- All copy in English (product surface).
- Run `npm test` (vitest) after every task; build deploys to vault via existing `npm run build` (.obsidian-plugin-dir).

---

### Task 1: Pure automation model + `when` grammar

**Files:**
- Create: `src/core/automation-model.ts`
- Test: `src/core/automation-model.test.ts`

**Interfaces:**
- Consumes: `Cadence`, `parseCadenceInput`, `cadenceLabel` from `src/core/automations.ts`; `frontmatterBlock`, `stripFrontmatter`, `fmScalar`, `fmList`, `parseDuration`, `formatDuration`, `slugifyAgent` from `src/core/agents.ts`.
- Produces:

```ts
export type AutomationMode = "report" | "propose" | "act";
export type AutomationWhen =
  | { on: "schedule"; cadence: Cadence }
  | { on: "vault-event"; event: "create" | "modify" | "rename"; path: string }
  | { on: "tag"; tag: string };

export interface Automation {
  slug: string;
  name: string;
  description: string;
  icon: string;                 // lucide id, default "zap"
  when: AutomationWhen[];
  mode: AutomationMode;         // default "report"
  scope: string[];              // write-scope folders, only for propose/act
  agent?: string;               // brain slug
  system?: "daily-pulse";       // built-in executor passthrough
  cooldownMs: number;           // event automations; default 15 * 60_000
  enabled: boolean;
  prompt: string;               // md body
}

export function parseWhen(line: string): AutomationWhen | null;
export function formatWhen(w: AutomationWhen): string;        // round-trips parseWhen
export function whenSentence(w: AutomationWhen): string;      // "Runs daily at 07:00" / "Runs when a note is created in _inbox/"
export function modeSentence(mode: AutomationMode): string;   // "read-only" / "proposes changes" / "can edit notes"
export function parseAutomationFile(slug: string, raw: string): { automation: Automation; warnings: string[] };
export function serializeAutomation(a: Automation): string;   // full md file content
export const DEFAULT_AUTOMATION_COOLDOWN_MS = 15 * 60_000;
```

- [ ] **Step 1: Write failing tests** — `src/core/automation-model.test.ts` covering:

```ts
import { describe, expect, it } from "vitest";
import { parseWhen, formatWhen, parseAutomationFile, serializeAutomation } from "./automation-model";

describe("when grammar", () => {
  it("parses schedules", () => {
    expect(parseWhen("hourly")).toEqual({ on: "schedule", cadence: { kind: "hourly" } });
    expect(parseWhen("daily 07:00")).toEqual({ on: "schedule", cadence: { kind: "daily", hour: 7 } });
    expect(parseWhen("daily 7")).toEqual({ on: "schedule", cadence: { kind: "daily", hour: 7 } });
    expect(parseWhen("weekly mon 07:00")).toEqual({ on: "schedule", cadence: { kind: "weekly", day: 1, hour: 7 } });
    expect(parseWhen("weekly lunedì 8")).toEqual({ on: "schedule", cadence: { kind: "weekly", day: 1, hour: 8 } });
  });
  it("parses events and tags", () => {
    expect(parseWhen("on create in _inbox/")).toEqual({ on: "vault-event", event: "create", path: "_inbox/**" });
    expect(parseWhen("on modify in Journal/Daily")).toEqual({ on: "vault-event", event: "modify", path: "Journal/Daily/**" });
    expect(parseWhen("on tag #todo")).toEqual({ on: "tag", tag: "todo" });
  });
  it("rejects garbage", () => {
    expect(parseWhen("daily 25:00")).toBeNull();
    expect(parseWhen("whenever")).toBeNull();
  });
  it("round-trips through formatWhen", () => {
    for (const s of ["hourly", "daily 07:00", "weekly mon 07:00", "on create in _inbox/**", "on tag #todo"]) {
      const w = parseWhen(s);
      expect(w).not.toBeNull();
      expect(parseWhen(formatWhen(w!))).toEqual(w);
    }
  });
});

describe("file round-trip", () => {
  it("parses and re-serializes stably", () => {
    const raw = [
      "---", "name: Inbox Triager", "description: Files _inbox notes", "icon: inbox",
      "when:", '  - "on create in _inbox/**"', "mode: act", "scope: [_inbox, Atlas]",
      "agent: inbox-triager", "cooldown: 15m", "enabled: true", "---", "", "Triage the inbox.", "",
    ].join("\n");
    const { automation, warnings } = parseAutomationFile("inbox-triager", raw);
    expect(warnings).toEqual([]);
    expect(automation.mode).toBe("act");
    expect(automation.when).toEqual([{ on: "vault-event", event: "create", path: "_inbox/**" }]);
    expect(automation.prompt).toBe("Triage the inbox.");
    const again = parseAutomationFile("inbox-triager", serializeAutomation(automation));
    expect(again.automation).toEqual(automation);
  });
  it("degrades unparseable when-lines to warnings, never drops the automation", () => {
    const raw = "---\nname: X\nwhen:\n  - nonsense\nenabled: true\n---\nBody";
    const { automation, warnings } = parseAutomationFile("x", raw);
    expect(automation.when).toEqual([]);
    expect(warnings.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/core/automation-model.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement `automation-model.ts`.** `parseWhen`: lowercase/trim; `hourly` literal; `daily HH[:MM]` via regex `^daily\s+(\d{1,2})(?::\d{2})?$` reusing `parseCadenceInput("daily", h)`; `weekly <day> HH[:MM]` reusing `parseCadenceInput("weekly", h, dayName)`; `on (create|modify|rename) in <path>` normalizing path to trailing `/**` (append `**` if path ends `/`, append `/**` if bare folder, keep as-is if already glob); `on tag #<tag>`. `formatWhen` emits the canonical forms used in tests. Sentences: plain English via `cadenceLabel` for schedules. `parseAutomationFile`: use `frontmatterBlock`/`fmScalar`/`fmList`; mode validated against the union with warning fallback to `report`; missing name falls back to slug. `serializeAutomation`: frontmatter keys in fixed order (name, description, icon, when, mode, scope, agent, system, cooldown, enabled), omit empty optionals, quote `when` entries, then blank line + prompt body.
- [ ] **Step 4: Run tests** — expect PASS. Also `npx vitest run` full suite green.
- [ ] **Step 5: Commit** `feat(core): automation model with human-readable when grammar`.

---

### Task 2: Migration mapping (pure)

**Files:**
- Modify: `src/core/automation-model.ts`
- Test: `src/core/automation-model.test.ts`

**Interfaces:**
- Consumes: `AutomationConfig` from `core/automations.ts`; `AgentDef`/`AgentContract` from `core/agents.ts`; Task 1 types.
- Produces:

```ts
export function automationFromPlaybook(cfg: AutomationConfig, prompt: string): Automation;
export function automationFromAgent(def: AgentDef): Automation | null; // null when no unattended triggers
```

- [ ] **Step 1: Failing tests** — playbook with `write: true` maps to `mode: "act"` and body = prompt; playbook with `system: "daily-pulse"` keeps `system`; agent contract with `autonomy: "act"`, one `vault-event` trigger and one `note-mention` maps to a single `when` entry, `agent: slug`, `scope` = contract `scope.write`, icon and cooldown carried over; agent with only `note-mention` returns null.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** `automationFromPlaybook`: slug via `slugifyAgent(cfg.name)`, `when: [{on:"schedule", cadence: cfg.cadence}]`, `mode: cfg.write ? "act" : "report"`. `automationFromAgent`: filter `triggers` to non-`note-mention`; map `autonomy` → `mode` directly (`notify` → `report`); description from brain description.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(core): pure migration mapping playbooks/contracts → automations`.

---

### Task 3: Automation store (impure) + one-shot migration

**Files:**
- Create: `src/obsidian/automation-store.ts`
- Modify: `src/main.ts` (instantiate store on load, run migration), `src/settings.ts` (add `automationsMigrated: boolean` default false)

**Interfaces:**
- Consumes: Task 1–2 exports; `AgentStore` (`plugin.agentStore.list()`); Obsidian `Vault` adapter read/write/list APIs following the pattern in `src/obsidian/agent-store.ts`.
- Produces:

```ts
export class AutomationStore {
  constructor(vault: Vault, dir: string /* "_system/automations" */);
  async refresh(): Promise<void>;                 // scan dir, parse all files
  list(): Automation[];                            // parse-error files included with error flag
  errors(): { slug: string; problem: string }[];
  get(slug: string): Automation | null;
  async save(a: Automation): Promise<void>;        // serialize + write (create dir if missing)
  async archive(slug: string): Promise<void>;      // move file to .archive/automations/
  onChange(cb: () => void): void;                  // vault watcher on the dir
}
export async function migrateToAutomationFiles(plugin: ExoPlugin, store: AutomationStore): Promise<string[]> // notices
```

Migration (runs on load when `!settings.automationsMigrated`): (1) each `settings.automations` entry → file, body = matched `customPrompts` prompt (case-insensitive by name; unmatched → skip with notice); (2) each agent with unattended triggers → file via `automationFromAgent`, then move `_system/agents/<slug>.md` to `.archive/agents/`; (3) on full success clear `settings.automations`, remove migrated `customPrompts`, set flag, save settings; partial failure leaves flag unset and reports per-item notices.

- [ ] **Step 1:** Implement store class mirroring `agent-store.ts` conventions (adapter IO, in-memory map keyed by slug, `registerEvent` watcher wired from main).
- [ ] **Step 2:** Implement migration function; wire both into `main.ts` `onload` after `agentStore` init.
- [ ] **Step 3:** `npm test` green; `npm run build` clean.
- [ ] **Step 4:** Manual gate: reload plugin in live vault → `_system/automations/` contains inbox-triager, constitution-guard, daily-pulse (+ scheduled playbooks); old agent sidecars in `.archive/agents/`; a Notice summarizes the migration.
- [ ] **Step 5: Commit** `feat(store): automation file store + one-shot migration`.

---

### Task 4: Executor on the store

**Files:**
- Modify: `src/main.ts` (scheduler heartbeat ~line 2854, event dispatch, run records), `src/core/automations.ts` (delete `AutomationConfig`, `migrateScheduledRuns`; re-key helpers by slug)

**Interfaces:**
- Consumes: `AutomationStore.list()`, slot logic (`isDue`, `currentSlotStart`), Task 1 model.
- Produces: run records (`AutomationRunRecord`) gain `slug: string`; last-run map `settings.automationLastRun: Record<string, number>` keyed by slug (replaces `automationLastRunKey` name-keying — migrate keys by slugifying once inside the migration of Task 3).

- [ ] **Step 1:** Replace the 30-min heartbeat loop: iterate `store.list().filter(a => a.enabled)`; for each schedule `when`, fire when `isDue(cadence, lastRun[slug], now)`. Prompt = `a.prompt`, or brain prompt composition when `a.agent` set (reuse the existing agent-run path: resolve brain via `agentStore`, run with automation's mode/scope). `mode` maps to the existing run options: `report` → read-only report run, `act` → write run with checkpoint, `propose` → existing Proposal Kernel path used by agent autonomy `propose`.
- [ ] **Step 2:** Route vault-event/tag `when` entries through the same dispatcher agents' triggers use today (search `vault-event` handling in `main.ts`), honoring `cooldownMs`.
- [ ] **Step 3:** Delete dead paths: `settings.customPrompts` scheduling pairing, agent-trigger dispatch reading contracts, `AutomationConfig` imports. `npm test` + typecheck must be green — update `daily-pulse` seeding to create/expect an automation *file* instead of a settings entry.
- [ ] **Step 4:** Manual gate: force a due automation ("Run now" via existing command or temporary hour change) — read-only run produces a report; Inbox Triager fires on creating a note in `_inbox/`.
- [ ] **Step 5: Commit** `refactor(exec): executor runs from automation files; settings-based paths removed`.

---

### Task 5: Hub tab rewrite — card list

**Files:**
- Modify: `src/ui/hub/tab-automations.ts` (rewrite), `styles.css` (new `.mva-auto2-*` block), `src/ui/hub/tab-playbooks.ts` (drop schedule label usage if broken by Task 4)

**Interfaces:**
- Consumes: `AutomationStore`, `whenSentence`, `modeSentence`, `formatAge`, `nextDueAt`.
- Produces: `renderAutomationsTab(host, ctx)` unchanged signature; card click calls `openAutomationEditor(ctx, slug)` (Task 6).

- [ ] **Step 1:** Render: intro line, then one card per automation — `setIcon` icon, name, description, sentence line (`whenSentence` joined with " · " + `modeSentence` + "last run Xh ago ✓/✗" from run records), right-aligned Run now button + enabled toggle. Disabled cards get `.is-off` dimming. Parse-error entries render an error card with the problem text + "Open note". Empty state + "New automation" button opening the editor with defaults.
- [ ] **Step 2:** Delete old sections (chips rows, Agents section, global runs list).
- [ ] **Step 3:** CSS: card layout consistent with suite tokens (`--mv-*` fallbacks inline per plugin-suite-theme-independent), no `!important`.
- [ ] **Step 4:** Manual gate in live vault: cards readable, icons correct, toggle + Run now work.
- [ ] **Step 5: Commit** `feat(ui): automations tab as readable card list`.

---

### Task 6: Editor panel

**Files:**
- Create: `src/ui/hub/automation-editor.ts`
- Modify: `src/ui/hub/tab-automations.ts` (wire open/close), `styles.css`

**Interfaces:**
- Consumes: store `get/save/archive`, Task 1 grammar, `openablePopover`, curated icon list (new const `AUTOMATION_ICONS: string[]` ~24 lucide ids in `automation-editor.ts`), `agentStore.list()` for the agent binder.
- Produces: `export function openAutomationEditor(ctx: HubTabContext, slug: string | null): void` — `null` = create flow with defaults (`mode: report`, `daily 07:00`, icon "zap").

- [ ] **Step 1:** Build the form with the canonical recipe: Name (text), Description (text), Icon (grid popover of `AUTOMATION_ICONS`), When (segmented "Schedule / Event": schedule → kind popover + hour field + day popover; event → event popover + folder text with datalist of top-level folders, or tag text), Permissions (three `.mva-pv` radio-cards with the explained tiers from the spec; scope folder chips shown for propose/act), Agent (optional popover listing brains + "None"), Prompt (auto-growing textarea bound to body + "Open note" button via `workspace.openLinkText`).
- [ ] **Step 2:** Save: validate (name non-empty, ≥1 valid when), build `Automation`, slugify name for new files, `store.save`, close, rerender tab. Live sentence preview under the When section updates on every change.
- [ ] **Step 3:** Delete (two-step confirm) → `store.archive(slug)`.
- [ ] **Step 4:** Manual gate: create → file appears well-formed; edit existing → only touched fields change; external file edit while hub open refreshes list (watcher).
- [ ] **Step 5: Commit** `feat(ui): in-hub automation editor`.

---

### Task 7: Per-automation run history

**Files:**
- Modify: `src/ui/hub/tab-automations.ts`, `src/main.ts` (record `slug` on run records), `src/core/automations.ts` (`runsForSlug(records, slug)` helper + test)

**Interfaces:**
- Consumes: `AutomationRunRecord` (now with `slug`), `NoteDiffModal`, existing restore machinery (`restoreAutomationRun` path in main.ts), `unreviewedWriteRuns`.
- Produces: card footer expands an inline timeline; Cockpit attention pool unchanged (still `unreviewedWriteRuns` over all records).

- [ ] **Step 1:** Pure helper + test: `runsForSlug` filters and sorts desc by `startedAt`; legacy records without slug fall under a synthetic "legacy" bucket rendered in a collapsed "Older runs" section at tab bottom.
- [ ] **Step 2:** UI: clicking the "last run" text toggles the timeline (outcome icon ✓/✗, time via `formatAge`, report link opening the note, touched-file rows opening `NoteDiffModal`, two-step Restore, Mark reviewed). Reuse existing restore/review handlers from the old runs section before deleting it.
- [ ] **Step 3:** Manual gate: run a write automation, verify timeline, diff, restore round-trip.
- [ ] **Step 4:** Full `npm test` + `npm run build`; live-vault smoke of all three migrated automations.
- [ ] **Step 5: Commit** `feat(ui): per-automation run timeline with restore`.

---

### Task 8: Cleanup + release

**Files:**
- Modify: `src/settings.ts` (remove customPrompts textarea UI + `scheduledRuns` field), `src/core/agent-copy.ts` (remove now-unused automation copy), `manifest.json`/`versions.json`/`package.json` (version bump)

- [ ] **Step 1:** Grep for dead exports (`describeAgentAutomation`, `unattendedTriggerEntries`, `setPrimaryTrigger`, etc.) — delete unused, keep what agent invocation UI still needs.
- [ ] **Step 2:** `npm test`, typecheck, `npm run build`; live-vault final smoke.
- [ ] **Step 3:** Update `_system` docs touchpoints in the vault (CLAUDE.md automations pointer, `_system/agents-guide.md` note) — vault commit with explicit paths only (never `-A`).
- [ ] **Step 4:** Version bump + commit on main; tag per release process when Mario wants it shipped.

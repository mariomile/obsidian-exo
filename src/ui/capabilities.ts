import { App } from "obsidian";
import { homedir } from "os";
import type { MVASettings } from "../settings";
import { clickable } from "./dom";
import { monthFileName } from "../core/memory-store";
import { exoPaths } from "../core/paths";
import {
  BUILTIN_TOOLS,
  FILE_BUILTINS,
  NATIVE_READ,
  NATIVE_WRITE,
  NATIVE_MEMORY,
  gatherFromScopes,
  gatherFromVault,
  gatherHooks,
  gatherMcpServers,
  gatherStoreEntries,
  gatherLoops,
  mergeByName,
  type HookSummary,
} from "../core/capability-scan";
import {
  memoryStats,
  memoryActions,
  systemStatuses,
  autonomyStatuses,
  autonomyActions,
} from "../core/actions-hub";

/* ----------------------------- rendering ------------------------------ */

interface Ctx {
  provider: string;
  model: string;
  onOpenNote: (path: string) => void;
  /** Live capability snapshot from the session's system/init (CLI ≥2.1.199):
   *  the REAL skills/commands/agents/MCP — global + plugins + vault. When
   *  present it supersedes the filesystem scans below (which only ever see a
   *  couple of scopes). Null on older CLIs or before the first session spawns. */
  caps?: {
    skills: string[];
    commands: string[];
    agents: string[];
    tools: string[];
    mcpServers: { name: string; status: string }[];
  } | null;
  /** Insert text into the composer (used by clickable skill/command/agent chips). */
  onInsert?: (text: string) => void;
  /** Actions hub (W2-UX): run an existing command by id (e.g. dream pass / undo). */
  runCommand?: (id: string) => void;
  /** Actions hub: open Exo settings (deep-link target for the System card rows). */
  openSettings?: () => void;
  /** Actions hub: whether a dream snapshot exists (gates the Undo action). */
  dreamSnapshotPresent?: () => Promise<boolean>;
  /** Actions hub: epoch ms of the last `exo: auto-commit` (async, git-log parse). */
  lastAutoCommitEpoch?: () => Promise<number | null>;
  /** Autonomy card: pending Exo Queue requests (async folder scan). */
  queuePending?: () => Promise<number>;
}

export async function renderCapabilitiesPanel(
  container: HTMLElement,
  app: App,
  s: MVASettings,
  ctx: Ctx
): Promise<void> {
  container.empty();
  const paths = exoPaths(s.memoryRoot);
  // Immediate feedback while the (sometimes async) capability scan runs; removed
  // once the panel is fully built. On the live-caps path this is synchronous and
  // never paints.
  const loading = container.createDiv({ cls: "mva-faint", text: "Loading capabilities…" });
  container.createDiv({ cls: "mva-gallery-title", text: "Capabilities" });
  const grid = container.createDiv({ cls: "mva-caps" });

  const claude = ctx.provider === "claude";
  const agentic = s.toolsEnabled;
  const nativeOn = s.obsidianToolsEnabled && agentic && claude;

  const card = (title: string, sub?: string): HTMLElement => {
    const c = grid.createDiv({ cls: "mva-caps-card" });
    const h = c.createDiv({ cls: "mva-caps-head" });
    h.createSpan({ cls: "mva-caps-title", text: title });
    if (sub) h.createSpan({ cls: "mva-caps-sub", text: sub });
    return c.createDiv({ cls: "mva-caps-body" });
  };
  const chip = (parent: HTMLElement, label: string, active: boolean, desc?: string, onClick?: () => void): HTMLElement => {
    const el = parent.createSpan({ cls: `mva-caps-chip ${active ? "is-on" : "is-off"}` });
    el.createSpan({ cls: "mva-caps-dot" });
    el.createSpan({ cls: "mva-caps-label", text: label });
    if (desc) el.setAttr("aria-label", desc), el.setAttr("title", desc);
    if (onClick) {
      el.addClass("is-clickable");
      clickable(el, onClick);
    }
    return el;
  };
  const empty = (parent: HTMLElement, text: string) => parent.createDiv({ cls: "mva-faint", text });
  const tier = (label: string, caption?: string) => {
    const t = grid.createDiv({ cls: "mva-caps-tier" });
    const l = t.createSpan({ text: label });
    l.style.fontSize = "10.5px";
    l.style.textTransform = "uppercase";
    l.style.letterSpacing = "0.06em";
    l.style.color = "var(--text-muted)";
    l.style.fontWeight = "600";
    if (caption) t.createSpan({ cls: "mva-caps-tier-caption", text: `  ·  ${caption}` });
    t.style.marginTop = "6px";
  };
  /** A one-shot action row (Memory card): distinct from a status chip — a
   *  leading glyph instead of a dot, since it means "click to run/open" rather
   *  than "this is on/off". Disabled actions (e.g. undo with no snapshot)
   *  reuse the same muted `is-off` look as status chips, just without a click
   *  handler wired. */
  const actionChip = (
    parent: HTMLElement,
    a: { label: string; enabled: boolean; badge?: string; hint?: string },
    onClick?: () => void
  ): HTMLElement => {
    const el = parent.createSpan({ cls: `mva-caps-chip is-action ${a.enabled ? "is-on" : "is-off"}` });
    el.createSpan({ cls: "mva-caps-glyph", text: "▸" });
    el.createSpan({ text: a.badge ? `${a.label} · ${a.badge}` : a.label });
    if (a.hint) el.createSpan({ cls: "mva-caps-chip-hint", text: a.hint });
    el.setAttr("title", a.enabled ? (a.hint ?? "Run") : "Unavailable");
    if (a.enabled && onClick) {
      el.addClass("is-clickable");
      clickable(el, onClick);
    }
    return el;
  };
  /** A status chip (System card) that deep-links to settings: keeps the dot
   *  (it reports an on/off state) but adds a trailing gear glyph so it reads
   *  as "click to configure", distinct from an action's "click to run". */
  const configChip = (parent: HTMLElement, label: string, active: boolean, onClick: () => void): HTMLElement => {
    const el = chip(parent, label, active, "Open Exo settings", onClick);
    el.createSpan({ cls: "mva-caps-glyph is-gear", text: "⚙" });
    return el;
  };

  // Session
  tier("Session");
  {
    const b = card("Session");
    chip(b, `Provider: ${ctx.provider}`, true);
    chip(b, `Model: ${ctx.model || "default"}`, true);
    chip(b, `Effort: ${s.effort}`, true);
    chip(b, `Permissions: ${s.permissionMode}`, true);
    chip(b, "Agentic tools", agentic);
    chip(b, "Fast startup", s.fastStartup);
    chip(b, "Native-first", s.nativeFirst);
  }

  // Actions hub (W2-UX): Wave 1-2 machinery — one place to see state + act.
  tier("Actions", "▸ run now  ·  ⚙ open settings");
  {
    const now = Date.now();
    const [storeEntries, loops, reviewExists, snapshotPresent, queuePending] = await Promise.all([
      gatherStoreEntries(app, paths.store),
      gatherLoops(app, paths.openLoops),
      app.vault.adapter.exists(paths.review).catch(() => false),
      ctx.dreamSnapshotPresent?.() ?? Promise.resolve(false),
      ctx.queuePending?.().catch(() => null) ?? Promise.resolve(null),
    ]);

    // Memory card — live stats + one-click actions.
    {
      const b = card("Memory", "dream · loops · store · budget");
      for (const stat of memoryStats({
        storeEntries,
        loops,
        ledger: s.backgroundBudgetLedger,
        dailyBudget: s.backgroundDailyTokenBudget,
        lastDreamPass: s.lastDreamPass,
        now,
      })) {
        chip(b, `${stat.label}: ${stat.value}`, true);
      }
      const openMain = (p: string) => () => ctx.onOpenNote(p);
      const run = (id: string) => () => ctx.runCommand?.(id);
      const handler: Record<string, () => void> = {
        "dream-run": run("exo:memory-dream-pass"),
        "dream-undo": run("exo:memory-dream-undo"),
        "open-store": openMain(`${paths.store}/${monthFileName(now)}`),
        "open-loops": openMain(paths.openLoops),
        "open-review": openMain(paths.review),
      };
      for (const a of memoryActions({ snapshotPresent, reviewExists, loops, now, dreamLlmEnabled: s.dreamLlmEnabled })) {
        actionChip(b, a, a.enabled ? handler[a.id] : undefined);
      }
    }

    // Autonomy card — the machinery that acts WITHOUT a chat turn (queue,
    // scheduled playbooks): live status + the three verbs that drive it.
    {
      const b = card("Autonomy", "queue · schedules");
      const input = {
        exoQueueEnabled: s.exoQueueEnabled,
        queuePending,
        automations: s.automations ?? [],
        scheduledLastRun: s.scheduledLastRun ?? {},
        hasPlaybooks: (s.customPrompts ?? []).length > 0,
        now,
      };
      for (const st of autonomyStatuses(input)) {
        configChip(b, `${st.label}: ${st.value}`, st.enabled, () => ctx.openSettings?.());
      }
      const run = (id: string) => () => ctx.runCommand?.(id);
      const handler: Record<string, () => void> = {
        "queue-drain": run("exo:queue-drain"),
        "queue-new": run("exo:queue-new-request"),
        "run-playbook": run("exo:run-playbook"),
        automations: run("exo:automations"),
      };
      for (const a of autonomyActions(input)) {
        actionChip(b, a, a.enabled ? handler[a.id] : undefined);
      }
    }

    // System card — read-only status + deep-link to settings (no toggles here).
    {
      const b = card("System", "auto-commit · observer");
      const sysInput = {
        vaultAutoCommit: s.vaultAutoCommit,
        lastAutoCommitEpoch: null as number | null,
        selfWritingMemory: s.selfWritingMemory,
        observerCadence: s.observerCadence,
        observerStepInterval: s.observerStepInterval,
        now,
      };
      const chips = new Map<string, HTMLElement>();
      for (const st of systemStatuses(sysInput)) {
        chips.set(st.id, configChip(b, `${st.label}: ${st.value}`, st.enabled, () => ctx.openSettings?.()));
      }
      // Async-fill the last auto-commit time (git log) without blocking render.
      void (ctx.lastAutoCommitEpoch?.() ?? Promise.resolve(null)).then((epoch) => {
        const el = chips.get("autocommit");
        if (!el) return;
        const st = systemStatuses({ ...sysInput, lastAutoCommitEpoch: epoch }).find((x) => x.id === "autocommit");
        const textSpan = el.querySelector(".mva-caps-label");
        if (st && textSpan instanceof HTMLElement) textSpan.setText(`${st.label}: ${st.value}`);
      });
    }
  }

  // Knowledge
  tier("Knowledge");
  // Memory
  {
    const b = card("Vault memory", `${paths.root}/`);
    chip(b, "Read at boot", s.memoryReadEnabled && claude);
    chip(b, "Write (gated)", s.memoryWriteEnabled && claude);
    const open = (p: string) => () => ctx.onOpenNote(p);
    chip(b, "vault-context.md", true, "open", open(paths.vaultContext));
    chip(b, "preferences.md", true, "open", open(paths.preferences));
    chip(b, "session-log.md", true, "open", open(paths.sessionLog));
  }

  // Playbooks
  tier("Playbooks");
  // Playbooks (custom prompts; " >>> " = multi-step workflow)
  {
    const b = card("Playbooks", "custom prompts + workflows");
    const prompts = s.customPrompts ?? [];
    const scheduled = new Set(
      (s.scheduledRuns ?? "")
        .split("\n")
        .map((l) => l.slice(0, l.lastIndexOf("|")).trim().toLowerCase())
        .filter(Boolean)
    );
    if (!prompts.length) empty(b, "No playbooks yet — add custom prompts in settings.");
    for (const p of prompts) {
      const isWorkflow = p.prompt.includes(" >>> ");
      const isSched = scheduled.has(p.name.toLowerCase());
      const steps = isWorkflow ? p.prompt.split(/\s+>>>\s+/).filter(Boolean).length : 0;
      const label = isSched ? `${p.name} ⏱` : p.name;
      const desc = isWorkflow ? `workflow · ${steps} steps` : "prompt";
      chip(b, label, true, isSched ? `${desc} · scheduled` : desc);
    }
  }

  // Live-vs-scan: with a session snapshot, chips are the CLI's real inventory
  // (global + plugins + vault) and clicking one inserts it into the composer.
  // Long lists cap at 24 chips + a "+N" expander so 240 skills stay scannable.
  const MAX_CHIPS = 24;
  const chipList = (b: HTMLElement, names: string[], insertPrefix: string, insertSuffix = " ") => {
    const render = (n: string) =>
      chip(
        b,
        `${insertPrefix}${n}`,
        true,
        ctx.onInsert ? "Click to insert in the composer" : undefined,
        ctx.onInsert ? () => ctx.onInsert?.(`${insertPrefix}${n}${insertSuffix}`) : undefined
      );
    for (const n of names.slice(0, MAX_CHIPS)) render(n);
    const rest = names.slice(MAX_CHIPS);
    if (rest.length) {
      const more = chip(b, `+${rest.length} more`, false, "Show all", () => {
        more.remove();
        for (const n of rest) render(n);
      });
    }
  };

  // Commands
  {
    const live = ctx.caps?.commands;
    const b = card("Commands", live ? `${live.length} — available` : ".claude/commands");
    if (live?.length) chipList(b, live, "/");
    else {
      const cmds = mergeByName(await gatherFromVault(app, "commands"), await gatherFromScopes("commands"));
      if (!cmds.length) empty(b, "None found.");
      for (const cm of cmds) chip(b, `/${cm.name}`, true);
    }
  }

  // Sub-agents
  {
    const live = ctx.caps?.agents;
    const b = card("Sub-agents", live ? `${live.length} — available` : ".claude/agents");
    if (live?.length) chipList(b, live, "@");
    else {
      const agents = mergeByName(await gatherFromVault(app, "agents"), await gatherFromScopes("agents"));
      if (!agents.length) empty(b, "None found.");
      for (const a of agents) chip(b, a.name, true, a.desc);
    }
  }

  // Skills & Tools
  tier("Skills & Tools");
  // Skills
  {
    const live = ctx.caps?.skills;
    const b = card("Skills", live ? `${live.length} — available` : ".claude/skills");
    if (live?.length) chipList(b, live, "$");
    else {
      const skills = mergeByName(await gatherFromVault(app, "skills"), await gatherFromScopes("skills"));
      if (!skills.length) empty(b, "None found.");
      for (const sk of skills) chip(b, sk.name, true);
    }
  }

  // Hooks
  {
    const b = card("Hooks", ".claude/settings.json");
    if (!s.runHooks) chip(b, "Disabled in settings", false, "Turn on 'Run Claude Code hooks' in settings");
    const base = (app.vault.adapter as unknown as { getBasePath?(): string }).getBasePath?.();
    const vaultHooks = base ? await gatherHooks(`${base}/.claude/settings.json`) : [];
    const globalHooks = await gatherHooks(`${homedir()}/.claude/settings.json`);
    const addScope = (list: HookSummary[], scope: string) => {
      if (!list.length) return;
      b.createSpan({ cls: "mva-faint", text: scope });
      for (const h of list) chip(b, `${h.event} ×${h.count}`, s.runHooks, scope);
    };
    if (!vaultHooks.length && !globalHooks.length) {
      empty(
        b,
        "No hooks configured. Hooks in .claude/settings.json run automatically (PreToolUse guards, formatters, notifications)."
      );
    } else {
      addScope(vaultHooks, "vault");
      addScope(globalHooks, "global");
      b.createDiv({
        cls: "mva-faint",
        text: "Hooks run at session start and per tool call — they add latency if slow.",
      });
    }
  }

  // Tools
  {
    // Prefer the session's REAL tool inventory (Workflow, Task, ScheduleWakeup,
    // Cron*, Monitor, ToolSearch, Skill … — everything the old hardcoded
    // BUILTIN_TOOLS list silently missed as the CLI grew orchestration tools).
    // MCP tools (mcp__*) have their own cards (MCP servers + Obsidian-native
    // below), so drop them here. Fall back to BUILTIN_TOOLS on older CLIs or
    // before the first init snapshot arrives.
    const liveCore = ctx.caps?.tools?.filter((t) => !t.startsWith("mcp__"));
    const core = liveCore?.length ? [...liveCore].sort((a, b) => a.localeCompare(b)) : BUILTIN_TOOLS;
    const b = card("Tools", liveCore?.length ? `${core.length} — available` : "built-in + Obsidian-native");
    for (const t of core) {
      const active = agentic && !(s.nativeFirst && claude && FILE_BUILTINS.has(t));
      chip(b, t, active);
    }
    if (nativeOn) {
      for (const t of NATIVE_READ) chip(b, t, true);
      for (const t of NATIVE_WRITE) chip(b, t, true);
      for (const t of NATIVE_MEMORY) chip(b, t, s.memoryWriteEnabled, "memory write");
    }
  }

  // MCP
  {
    const live = ctx.caps?.mcpServers;
    const b = card("MCP servers", live ? `${live.length} — available` : undefined);
    if (live?.length) {
      // Real per-server status straight from the session's init snapshot.
      for (const srv of live) chip(b, srv.name, srv.status === "connected", srv.status);
    } else {
      chip(b, "obsidian (in-process)", nativeOn);
      const external = await gatherMcpServers(app);
      if (external.length) {
        for (const n of external) chip(b, n, !s.fastStartup, s.fastStartup ? "disabled by Fast startup" : "active");
      } else if (!nativeOn) {
        empty(b, "No MCP servers active.");
      }
      if (s.fastStartup && external.length) b.createDiv({ cls: "mva-faint", text: "External MCP is off while Fast startup is on." });
    }
  }

  loading.remove();
}

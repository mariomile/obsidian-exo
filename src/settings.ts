import { App, DropdownComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import { readFile } from "fs/promises";
import { homedir } from "os";
import type ExoPlugin from "./main";
import type { PermissionMode, ProviderId } from "./providers/types";
import { cliDiagnostics, updateClaudeCli } from "./cli";
import { compareSemver } from "./core/semver";
import { ADAPTERS } from "./providers/registry";
import { modelOptions } from "./core/model-options";
import type { AutomationConfig } from "./core/automations";
import {
  parseMcpJson,
  serializeMcpJson,
  upsertServer,
  removeServer,
  setServerEnabled,
  summarizeServer,
  buildServerConfig,
  type McpServerEntry,
  type ServerFormInput,
} from "./core/mcp-config";

export interface MVASettings {
  provider: ProviderId;
  claudeBin: string;
  codexBin: string;
  claudeModel: string;
  codexModel: string;
  /** Extra model ids (comma/newline separated) added to the model pickers. */
  claudeCustomModels: string;
  codexCustomModels: string;
  effort: string;
  systemPrompt: string;
  /** User-defined prompt templates surfaced in the "/" menu. */
  customPrompts: { name: string; prompt: string }[];
  /** Internal idempotency receipts for accepted playbook proposals. */
  proposalPlaybookReceipts: Record<string, string>;
  /** What sending a message during a running turn does: "queue" waits and starts
   *  it as the next turn; "steer" injects it into the live turn (Claude only). */
  steerMode: "queue" | "steer";
  /** Phase 1 default: false (pure chat). Phase 2 turns this on with gating. */
  toolsEnabled: boolean;
  permissionMode: PermissionMode;
  autoAllowRead: boolean;
  fastStartup: boolean;
  /** Start the CLI session in the background when Exo opens, so the first
   *  message skips the cold start. Claude only. */
  prewarmSession: boolean;
  /** Run Claude Code hooks (.claude/settings.json) — CC parity, on by default. */
  runHooks: boolean;
  /** Persistent allow rules — one per line: `Tool` or `Tool(argPrefix)`. */
  permAllowRules: string;
  /** Persistent deny rules — one per line; deny wins over allow. */
  permDenyRules: string;
  /** Persist "Always allow" card choices into permAllowRules across sessions. */
  rememberAlwaysAllow: boolean;
  /** Codex sandbox + approval policy. */
  codexSandbox: string;
  codexApproval: string;
  /** Auto-compact the conversation when context fills (token saver, Claude). */
  autoCompactEnabled: boolean;
  /** Load native tool defs on-demand instead of always in context (saves tokens). */
  contextSavingMode: boolean;
  // Obsidian-native (Claude). All optional/toggleable.
  obsidianToolsEnabled: boolean;
  nativeFirst: boolean;
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  /** Self-Writing Memory: after each healthy turn, a cheap background observer
   *  proposes durable memories and writes them to the store (with veto/undo).
   *  OFF by default — only runs when this AND memoryWriteEnabled are on. */
  selfWritingMemory: boolean;
  /** The Agent Is the Folder: hydrate boot from `_system/agent/` (persona/human/now)
   *  and enable the governed `rethink_memory` tool + observer now-proposals.
   *  DEFAULT OFF — with it off, boot is byte-identical and the folder is never read.
   *  Natural rollout: seed the folder → review → flip this on. */
  agentFolderEnabled: boolean;
  /** Observer cadence (W2-3): "session-end" is the original always-on
   *  end-of-turn capture (default, behavior-neutral). "every-n-steps" ALSO
   *  flushes a delta capture every `observerStepInterval` tool-call steps
   *  within a long turn — Letta-style sleep-time cadence, so context isn't
   *  lost waiting for a marathon agentic turn to finish. */
  observerCadence: "session-end" | "every-n-steps";
  /** Tool-call step interval for `observerCadence: "every-n-steps"`. */
  observerStepInterval: number;
  /** Proactive recall: before each user message is sent, run the store's BM25
   *  scorer and auto-inject the top relevant, not-yet-injected memories into the
   *  outbound turn (in `[recalled-memory]` blocks). ON by default — this is the
   *  point of the store. Kill-switch: OFF makes the send path identical to before
   *  the feature existed. Claude only (memory read must also be on). */
  proactiveRecall: boolean;
  /** Max memories proactive recall injects per turn (advanced). */
  proactiveRecallK: number;
  featureSurfacing: boolean;
  featureWikilinkify: boolean;
  /** Open notes the agent edits in a tab beside the chat, live. */
  revealEditedNotes: boolean;
  /** OS notifications when a turn finishes / waits / errors while Obsidian is backgrounded. */
  systemNotifications: boolean;
  /** Set once after seeding example custom prompts, so we never re-seed. */
  seededPrompts: boolean;
  /** Refine the first-message tab title with a Haiku-generated 3-6 word title. */
  aiTitles: boolean;
  /** In-note AI: floating toolbar over a selection (Edit / Continue / Ask Exo). */
  inlineAi: boolean;
  /** Show the current editor selection as a click-to-attach chip in the composer. */
  showSelectionChip: boolean;
  /** In-document Connections: underline OUTGOING unlinked mentions (other notes'
   *  titles this note cites in plain text) so they can be linked with one click. */
  connectionsInlineUnderline: boolean;
  /** Broaden mention matching with light IT/EN stemming (plurals/inflections). */
  connectionsStemming: boolean;
  // Tab bar runtime state (not user-facing settings).
  openTabIds: string[];
  /** Last session capability snapshot (runtime state, not user-facing) — persisted
   *  so the $/@// menus and the capabilities panel are rich immediately after an
   *  Obsidian restart, before the first session's init arrives. Refreshed on
   *  every init; slightly stale is fine (it's menu seeding, not authorization). */
  cachedSessionCaps: {
    skills: string[];
    commands: string[];
    agents: string[];
    mcpServers: { name: string; status: string }[];
  } | null;
  activeTabId: string;
  /** Memory dream pass automation: off | daily | weekly. */
  dreamPassSchedule: "off" | "daily" | "weekly";
  /** Timestamp of the last dream pass (scheduler bookkeeping). */
  lastDreamPass: number;
  /** Dream Pass v2 — LLM proposal stage. When ON, the dream pass runs an extra,
   *  transient tool-less LLM stage that PROPOSES typed consolidation changes
   *  (merge/supersede/rule_draft/import); a deterministic gate culls anything
   *  touching @user entries or matching known-false patterns before preview.
   *  OFF by default — zero behavior change when off. Claude only. */
  dreamLlmEnabled: boolean;
  /** Defrag threshold: when the store/ or learnings/ dir exceeds this many files,
   *  the dream LLM prompt asks for consolidation merges. */
  memoryFileBudget: number;
  /** claude-mem project filter for the import stage. NOT a path-slug — verified
   *  2026-07-05 against the real DB: claude-mem's `project` column stores the
   *  vault/repo's directory basename (e.g. "my-vault"), not the CWD-derived
   *  slug used elsewhere. */
  claudememProjects: string[];
  /** Canonical keys of dream proposals already applied — dedup across runs. */
  appliedProposalKeys: string[];
  /** W0 background-AI master toggle: gates every background LLM pass. */
  backgroundPassesEnabled: boolean;
  /** W0 shared daily token budget for all background passes (0 = unlimited). */
  backgroundDailyTokenBudget: number;
  /** W0 model for background passes (floor Sonnet — never Haiku). */
  backgroundModel: string;
  /** W0 persisted daily budget ledger. */
  backgroundBudgetLedger: { dateUTC: string; tokensUsed: number };
  /** Typed inert proposal inbox and explicit acceptance router. */
  proposalKernelEnabled: boolean;
  /** Run the post-turn extractor after healthy turns. Off by default. */
  proposalTurnSuggestions: boolean;
  /** Exo Queue ("Exo in tasca"): il desktop evade note-richiesta scritte dal
   *  telefono in exoQueueFolder (via Obsidian Sync), headless e read-only. */
  exoQueueEnabled: boolean;
  /** Cartella della coda richieste (vault-relative). */
  exoQueueFolder: string;
  /** Open the Cockpit view automatically when Obsidian's layout is ready. */
  cockpitOnStartup: boolean;
  /** LEGACY scheduled playbook runs ("<Prompt name> | daily" per line) — migrated
   *  into `automations` on load, then cleared. Kept only for the migration path. */
  scheduledRuns: string;
  /** Structured automations (playbook + slot cadence + write flag) — the
   *  scheduler in main.ts and the Cockpit Automations panel read these. */
  automations: AutomationConfig[];
  /** Load external MCP tools (Gmail/Slack/Calendar…) in headless playbook runs —
   *  Dia-style digest sources. Read-only enforced by the headless resolver
   *  (core/headless-tools.ts): read tools auto-allowed, mutations auto-denied. */
  playbookExternalTools: boolean;
  /** Set once after seeding the Morning Digest playbook, so it's never re-seeded. */
  seededDigest: boolean;
  /** Learning loop: propose saving a flow as a reusable playbook when the same
   *  KIND of task (by topic) recurs (free proposal; LLM distillation only on
   *  accept). Recurrence is tracked in `_system/memory/playbook-signals.json`. */
  learningLoop: boolean;
  /** How many times a topic must recur before the playbook nudge fires. Default 3. */
  playbookThreshold: number;
  /** Per-playbook last-run timestamps (scheduler bookkeeping). */
  scheduledLastRun: Record<string, number>;
  /** Epoch ms of the last daily Claude-CLI update check (0 = never). */
  cliUpdateCheckAt: number;
  /** Latest published Claude CLI version seen by the update check ("" = unknown). */
  cliLatestKnown: string;
  /** Git auto-commit safety net: silently commit vault writes so every
   *  agent-driven mutation is recoverable via git. OFF by default — an opt-in
   *  net, not a surprise. No-op when the vault isn't a git repo. */
  vaultAutoCommit: boolean;
  /** Periodic fallback cadence (minutes) — a commit check runs at least this
   *  often even without a fresh tracked write, catching a dirty tree from
   *  drift. The debounce quiet period after a write (2 min, fixed) usually
   *  fires first. */
  vaultAutoCommitIntervalMinutes: number;
  /** Orchestration Board master flag, default OFF. Gates the `add_task` tool,
   *  the "Promote to task" command, and (future) the board view/ribbon icon —
   *  chat is unaffected either way. See docs/superpowers/specs/2026-07-08-orchestration-board-design.md.
   *  Turning this OFF never touches already-running conversations — they keep
   *  going as normal chats; it only stops new tasks from being queued/started. */
  orchestrationEnabled: boolean;
  /** Max number of Orchestration Board tasks the driver runs concurrently. */
  orchestrationMaxConcurrent: number;
}

export const DEFAULT_SETTINGS: MVASettings = {
  provider: "claude",
  claudeBin: "",
  codexBin: "",
  claudeModel: "claude-fable-5",
  codexModel: "gpt-5.6-sol",
  claudeCustomModels: "",
  codexCustomModels: "",
  effort: "default",
  systemPrompt: "",
  customPrompts: [],
  proposalPlaybookReceipts: {},
  steerMode: "queue",
  toolsEnabled: false,
  permissionMode: "default",
  autoAllowRead: true,
  fastStartup: true,
  prewarmSession: true,
  runHooks: true,
  permAllowRules: "",
  permDenyRules: "",
  rememberAlwaysAllow: false,
  codexSandbox: "workspace-write",
  codexApproval: "on-request",
  autoCompactEnabled: true,
  contextSavingMode: false,
  obsidianToolsEnabled: true,
  nativeFirst: false,
  memoryReadEnabled: true,
  memoryWriteEnabled: true,
  selfWritingMemory: false,
  agentFolderEnabled: false,
  observerCadence: "session-end",
  observerStepInterval: 25,
  proactiveRecall: true,
  proactiveRecallK: 3,
  featureSurfacing: true,
  featureWikilinkify: true,
  revealEditedNotes: true,
  systemNotifications: true,
  seededPrompts: false,
  aiTitles: true,
  inlineAi: true,
  showSelectionChip: true,
  openTabIds: [],
  activeTabId: "",
  cachedSessionCaps: null,
  dreamPassSchedule: "off",
  lastDreamPass: 0,
  dreamLlmEnabled: false,
  memoryFileBudget: 25,
  claudememProjects: [],
  appliedProposalKeys: [],
  backgroundPassesEnabled: true,
  backgroundDailyTokenBudget: 200000,
  backgroundModel: "claude-sonnet-5",
  backgroundBudgetLedger: { dateUTC: "", tokensUsed: 0 },
  proposalKernelEnabled: true,
  proposalTurnSuggestions: false,
  exoQueueEnabled: true,
  exoQueueFolder: "_system/exo-queue",
  cockpitOnStartup: false,
  scheduledRuns: "",
  automations: [],
  playbookExternalTools: false,
  seededDigest: false,
  learningLoop: true,
  playbookThreshold: 3,
  scheduledLastRun: {},
  cliUpdateCheckAt: 0,
  cliLatestKnown: "",
  vaultAutoCommit: false,
  vaultAutoCommitIntervalMinutes: 15,
  orchestrationEnabled: false,
  orchestrationMaxConcurrent: 2,
  connectionsInlineUnderline: true,
  connectionsStemming: true,
};

/** Options for the "Background AI model" dropdown — Sonnet-class only.
 *  Product constraint: the floor for background
 *  passes is Sonnet — never offer (or default to) a Haiku model here, even
 *  though Haiku is available as the observer's own hardcoded fast-path model
 *  elsewhere. Keep in sync with the pinned ids in `providers/claude.ts`. */
const BACKGROUND_MODEL_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
];

export class MVASettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ExoPlugin) {
    super(app, plugin);
  }

  /** Remembered active tab across re-renders (not persisted to disk). */
  private activeTab = "General";

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Obsidian has no native settings tabs, so build a segmented bar of <button>s
    // (keyboard-operable for free) over one body container per tab; clicking a tab
    // shows its body and hides the rest. All settings live under exactly one tab.
    const tabNames = ["General", "Chat", "Agent & Permissions", "Memory", "Advanced"];
    const bar = containerEl.createDiv({ cls: "mva-settings-tabs" });
    const bodies = new Map<string, HTMLElement>();
    const btns = new Map<string, HTMLElement>();

    const select = (name: string) => {
      this.activeTab = name;
      for (const [n, b] of btns) b.toggleClass("is-active", n === name);
      for (const [n, el] of bodies) el.toggleClass("is-hidden", n !== name);
    };

    for (const name of tabNames) {
      const btn = bar.createEl("button", { cls: "mva-settings-tab", text: name });
      btn.onclick = () => select(name);
      btns.set(name, btn);
      bodies.set(name, containerEl.createDiv({ cls: "mva-settings-body" }));
    }

    this.renderGeneralTab(bodies.get("General")!);
    this.renderChatTab(bodies.get("Chat")!);
    this.renderAgentTab(bodies.get("Agent & Permissions")!);
    this.renderMemoryTab(bodies.get("Memory")!);
    this.renderAdvancedTab(bodies.get("Advanced")!);

    if (!bodies.has(this.activeTab)) this.activeTab = "General";
    select(this.activeTab);
  }

  /** A boolean toggle row — the repeated shape across the tabs. */
  private toggleSetting(el: HTMLElement, name: string, desc: string, key: keyof MVASettings): void {
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addToggle((t) =>
        t.setValue(this.plugin.settings[key] as boolean).onChange(async (v) => {
          (this.plugin.settings[key] as boolean) = v;
          await this.plugin.saveSettings();
        })
      );
  }

  /* ------------------------------- General ------------------------------ */

  private renderGeneralTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    new Setting(el)
      .setName("Default provider")
      .setDesc("The CLI backend every new conversation starts with.")
      .addDropdown((d) =>
        d
          .addOption("claude", "Claude")
          .addOption("codex", "Codex")
          .setValue(s.provider)
          .onChange(async (v) => {
            s.provider = v as ProviderId;
            await this.plugin.saveSettings();
          })
      );

    // The model each new chat starts with, per provider. Options = the provider's
    // built-ins + the custom ids from the textareas below; editing those textareas
    // repopulates these dropdowns live via fill().
    let claudeDd: DropdownComponent | undefined;
    let codexDd: DropdownComponent | undefined;
    const fill = (d: DropdownComponent, provider: ProviderId) => {
      d.selectEl.empty();
      const cur = provider === "claude" ? s.claudeModel : s.codexModel;
      const opts = modelOptions(
        ADAPTERS[provider].models(),
        provider === "claude" ? s.claudeCustomModels : s.codexCustomModels
      );
      for (const o of opts) d.addOption(o.id, o.label);
      // Keep the current selection valid even if it isn't in the option list.
      if (cur && !opts.some((o) => o.id === cur)) d.addOption(cur, cur);
      d.setValue(cur);
    };

    new Setting(el)
      .setName("Default Claude model")
      .setDesc("Which Claude model new conversations start with — includes any custom Claude models set below.")
      .addDropdown((d) => {
        claudeDd = d;
        fill(d, "claude");
        d.onChange(async (v) => {
          s.claudeModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName("Default Codex model")
      .setDesc("Which Codex model new conversations start with — includes any custom Codex models set below.")
      .addDropdown((d) => {
        codexDd = d;
        fill(d, "codex");
        d.onChange(async (v) => {
          s.codexModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName("Claude binary path")
      .setDesc("Path to the `claude` CLI. Leave empty to auto-detect; run `which claude` if detection fails.")
      .addText((t) =>
        t
          .setPlaceholder("auto-detect")
          .setValue(s.claudeBin)
          .onChange(async (v) => {
            s.claudeBin = v.trim();
            await this.plugin.saveSettings();
          })
      );
    this.renderCliDiagnostics(el, "claude", s.claudeBin);

    new Setting(el)
      .setName("Codex binary path")
      .setDesc("Path to the `codex` CLI. Leave empty to auto-detect; run `which codex` if detection fails.")
      .addText((t) =>
        t
          .setPlaceholder("auto-detect")
          .setValue(s.codexBin)
          .onChange(async (v) => {
            s.codexBin = v.trim();
            await this.plugin.saveSettings();
          })
      );
    this.renderCliDiagnostics(el, "codex", s.codexBin);

    new Setting(el)
      .setName("Custom Claude models")
      .setDesc("Extra Claude model ids (comma- or newline-separated) added to the model picker and the default-model dropdown above.")
      .addTextArea((t) =>
        t
          .setPlaceholder("claude-opus-4-6\nclaude-sonnet-4-6")
          .setValue(s.claudeCustomModels)
          .onChange(async (v) => {
            s.claudeCustomModels = v;
            await this.plugin.saveSettings();
            if (claudeDd) fill(claudeDd, "claude");
          })
      );

    new Setting(el)
      .setName("Custom Codex models")
      .setDesc("Extra Codex model ids (comma- or newline-separated) added to the model picker and the default-model dropdown above.")
      .addTextArea((t) =>
        t
          .setPlaceholder("gpt-5.6-terra\ngpt-5.4-mini")
          .setValue(s.codexCustomModels)
          .onChange(async (v) => {
            s.codexCustomModels = v;
            await this.plugin.saveSettings();
            if (codexDd) fill(codexDd, "codex");
          })
      );
  }

  /* -------------------------------- Chat -------------------------------- */

  private renderChatTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    new Setting(el)
      .setName("Sending during a running turn")
      .setDesc(
        "Queue = your message waits and starts as the next turn. Steer = inject it into the running turn so the agent can change course mid-flight (Claude only; Codex always queues)."
      )
      .addDropdown((d) =>
        d
          .addOption("queue", "Queue (wait for the next turn)")
          .addOption("steer", "Steer (inject into the running turn)")
          .setValue(s.steerMode)
          .onChange(async (v) => {
            s.steerMode = v as "queue" | "steer";
            await this.plugin.saveSettings();
          })
      );

    this.toggleSetting(
      el,
      "Generate chat titles with AI (Haiku)",
      "After the first reply, rename the tab to a concise 3-6 word summary using Claude Haiku; off keeps the truncated first message.",
      "aiTitles"
    );
    this.toggleSetting(
      el,
      "In-note AI toolbar",
      "Select text in a note to get a floating toolbar: rewrite it with a streaming inline diff (Edit), keep writing from it (Continue), or open the chat with it as context (Ask Exo).",
      "inlineAi"
    );
    this.toggleSetting(
      el,
      "Show selection in composer",
      "When you select text in a note, show it as a chip in the chat composer — click it to add the excerpt as context.",
      "showSelectionChip"
    );
    new Setting(el)
      .setName("Connections")
      .setDesc(
        "Surfaces the other notes you mention in a note's text but haven't linked yet — the graph work Obsidian's native pane leaves to you — and lets you wire them with one click, right where you're reading."
      )
      .setHeading();
    this.toggleSetting(
      el,
      "Underline unlinked mentions",
      "As you read a note, dot-underline the names of your other notes that appear in its text but aren't linked yet. Click an underlined name to turn it into a [[wikilink]] — or dismiss it for good if it's just a coincidence (dismissals are remembered).",
      "connectionsInlineUnderline"
    );
    this.toggleSetting(
      el,
      "Broaden mention matching",
      "Also match plurals and simple word inflections in Italian and English — e.g. 'prodotti' matches a note titled 'Prodotto'. Finds more mentions, with a small risk of the odd false match; turn off if you see noise.",
      "connectionsStemming"
    );
    this.toggleSetting(
      el,
      "Surface related notes",
      "Show notes related to the active note in the empty state, before you send anything.",
      "featureSurfacing"
    );
    this.toggleSetting(
      el,
      "Wikilink-ify replies",
      "Turn mentions of existing note titles in replies into clickable [[wikilinks]].",
      "featureWikilinkify"
    );
    this.toggleSetting(
      el,
      "Reveal edited notes",
      "When the agent edits or creates a note, open it in a tab beside the chat so you watch it change live. Only fires for the chat you're looking at — background conversations never move your view.",
      "revealEditedNotes"
    );
    this.toggleSetting(
      el,
      "System notifications",
      "Send an OS notification when a turn finishes, a card needs an answer, or an error occurs — only while Obsidian is in the background.",
      "systemNotifications"
    );

    new Setting(el)
      .setName("Custom prompts")
      .setDesc(
        'Reusable prompts for the "/" menu, one per line as "Name | prompt text". Use {{variables}} for fill-in values and " >>> " to chain steps into a multi-step workflow.'
      )
      .addTextArea((t) => {
        t.setPlaceholder("Summarize | Summarize the current note in 5 bullets")
          .setValue(s.customPrompts.map((p) => `${p.name} | ${p.prompt}`).join("\n"))
          .onChange(async (v) => {
            s.customPrompts = v
              .split("\n")
              .map((line) => {
                const i = line.indexOf("|");
                if (i < 0) return null;
                const name = line.slice(0, i).trim();
                const prompt = line.slice(i + 1).trim();
                return name && prompt ? { name, prompt } : null;
              })
              .filter((x): x is { name: string; prompt: string } => x !== null);
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 5;
      });

    new Setting(el)
      .setName("System prompt")
      .setDesc("Optional persona/instructions prepended to every conversation. Leave empty to use the CLI's default.")
      .addTextArea((t) =>
        t
          .setPlaceholder("(use the CLI's default)")
          .setValue(s.systemPrompt)
          .onChange(async (v) => {
            s.systemPrompt = v;
            await this.plugin.saveSettings();
          })
      );
  }

  /* ------------------------- Agent & Permissions ------------------------ */

  private renderAgentTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    this.toggleSetting(
      el,
      "Enable tools (agentic mode)",
      "Let the agent read, write, and edit files and run commands in your vault. Every sensitive action is still gated by the permission cards.",
      "toolsEnabled"
    );

    new Setting(el)
      .setName("Permission mode")
      .setDesc(
        "How tool use is approved. Ask prompts for each sensitive action; Accept edits auto-approves file edits; Plan only forbids changes; Bypass skips every prompt (dangerous)."
      )
      .addDropdown((d) =>
        d
          .addOption("default", "Ask (default)")
          .addOption("acceptEdits", "Accept edits")
          .addOption("plan", "Plan only")
          .addOption("bypassPermissions", "Bypass (dangerous)")
          .setValue(s.permissionMode)
          .onChange(async (v) => {
            s.permissionMode = v as PermissionMode;
            await this.plugin.saveSettings();
          })
      );

    this.toggleSetting(
      el,
      "Auto-allow read-only tools",
      "Skip the permission prompt for side-effect-free tools (Read, Glob, Grep, LS).",
      "autoAllowRead"
    );
    this.toggleSetting(
      el,
      "Remember 'Always allow' across sessions",
      "When you pick 'Always allow' on a permission card, also save it as an allow rule below so it survives a reload.",
      "rememberAlwaysAllow"
    );

    const rulesDesc =
      "One per line: ToolName or ToolName(argument). Deny wins, and both apply before the permission card. " +
      "Bash arguments match command-token boundaries; file paths match exactly unless they end in * (explicit prefix match).";
    new Setting(el)
      .setName("Always-allow rules")
      .setDesc(rulesDesc)
      .addTextArea((t) => {
        t.setPlaceholder("Bash(git status)\nread_note")
          .setValue(s.permAllowRules)
          .onChange(async (v) => {
            s.permAllowRules = v;
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 4;
        t.inputEl.style.fontFamily = "var(--font-monospace)";
      });

    new Setting(el)
      .setName("Deny rules")
      .setDesc(rulesDesc)
      .addTextArea((t) => {
        t.setPlaceholder("Bash(rm)\nWrite")
          .setValue(s.permDenyRules)
          .onChange(async (v) => {
            s.permDenyRules = v;
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 4;
        t.inputEl.style.fontFamily = "var(--font-monospace)";
      });

    this.toggleSetting(
      el,
      "Run Claude Code hooks",
      "Execute hooks in .claude/settings.json (vault + global) — PreToolUse guards, formatters, notifications — matching Claude Code. Hooks run at session start and on every tool call, so heavy or network-bound ones slow turns down; turn off if Exo feels sluggish.",
      "runHooks"
    );

    new Setting(el)
      .setName("Codex sandbox")
      .setDesc("Filesystem access granted to Codex when tools are enabled.")
      .addDropdown((d) =>
        d
          .addOptions({
            "read-only": "Read-only",
            "workspace-write": "Workspace write",
            "danger-full-access": "Full access (danger)",
          })
          .setValue(s.codexSandbox)
          .onChange(async (v) => {
            s.codexSandbox = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName("Codex approval policy")
      .setDesc("When Codex pauses to ask before running a command.")
      .addDropdown((d) =>
        d
          .addOptions({
            untrusted: "Untrusted (ask often)",
            "on-request": "On request",
            "on-failure": "On failure",
            never: "Never",
          })
          .setValue(s.codexApproval)
          .onChange(async (v) => {
            s.codexApproval = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el).setName("Safety net").setHeading();

    this.toggleSetting(
      el,
      "Auto-commit vault changes to git",
      "Silently commits only the paths Exo wrote, so its mutations are recoverable without staging your manual or other-agent changes. No-op when the vault isn't a git repo or git isn't available; never blocks a chat turn.",
      "vaultAutoCommit"
    );

    new Setting(el)
      .setName("Auto-commit fallback interval")
      .setDesc(
        "Minutes between safety-net retries for paths Exo has tracked, independent of the debounce after a write."
      )
      .addText((t) =>
        t
          .setPlaceholder("15")
          .setValue(String(s.vaultAutoCommitIntervalMinutes))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.vaultAutoCommitIntervalMinutes = n;
            await this.plugin.saveSettings();
          })
      );
  }

  /* ------------------------------- Memory ------------------------------- */

  private renderMemoryTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    this.toggleSetting(
      el,
      "Read vault memory",
      "Boot each conversation with context from _system/ (vault-context, preferences, rules, recent sessions). Claude only.",
      "memoryReadEnabled"
    );
    this.toggleSetting(
      el,
      "Write vault memory",
      "Let the agent capture decisions, learnings, and session-log entries into _system/ — every write is still permission-gated. Claude only.",
      "memoryWriteEnabled"
    );
    this.toggleSetting(
      el,
      "Self-writing memory",
      "After each healthy turn, a cheap background observer proposes durable memories and appends them to the store as @generated entries — you can review or undo each write. Off by default; runs only when Write vault memory is also on. Claude only.",
      "selfWritingMemory"
    );
    this.toggleSetting(
      el,
      "The agent is the folder (identity)",
      "Hydrate every conversation from _system/agent/ — three short blocks (persona = how Exo behaves, human = a distilled model of you, now = what matters right now) that give Exo AND any external tool (Claude Code, Codex) a coherent identity. Adds the rethink_memory tool (now/human rewrite freely, persona is propose-only) and an observer that proposes now.md updates after a turn. Off by default; with it off, boot is unchanged and the folder is never read. Rollout: run \"Exo: Seed agent folder\", review human.md, then flip this on. Claude only.",
      "agentFolderEnabled"
    );

    new Setting(el)
      .setName("Proactive recall")
      .setDesc(
        "Before each message is sent, surface the most relevant stored memories into the turn automatically — so the agent no longer has to decide to call recall. Deduped per conversation and relevance-gated, so irrelevant turns cost nothing. On by default; needs Read vault memory. Claude only."
      )
      .addToggle((t) =>
        t.setValue(s.proactiveRecall).onChange(async (v) => {
          s.proactiveRecall = v;
          await this.plugin.saveSettings();
          this.display(); // show/hide the per-turn count field
        })
      );

    if (s.proactiveRecall) {
      new Setting(el)
        .setName("Proactive recall — memories per turn")
        .setDesc("How many relevant memories to inject at most, per message.")
        .addText((t) =>
          t
            .setPlaceholder("3")
            .setValue(String(s.proactiveRecallK))
            .onChange(async (v) => {
              const n = Number.parseInt(v, 10);
              if (Number.isFinite(n) && n > 0) s.proactiveRecallK = n;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(el)
      .setName("Observer cadence")
      .setDesc(
        "When self-writing memory captures. \"End of turn\" (default) is the behavior above, unchanged. \"Every N tool-call steps\" ALSO flushes a delta capture partway through a long, tool-call-heavy turn — so context isn't lost waiting for it to finish — then the end-of-turn pass only covers whatever's left. Step passes respect the background-AI budget below."
      )
      .addDropdown((d) =>
        d
          .addOptions({ "session-end": "End of turn", "every-n-steps": "Every N tool-call steps" })
          .setValue(s.observerCadence)
          .onChange(async (v) => {
            s.observerCadence = v as "session-end" | "every-n-steps";
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (s.observerCadence === "every-n-steps") {
      new Setting(el)
        .setName("Observer step interval")
        .setDesc("Flush a delta capture every this many tool-call steps within a conversation.")
        .addText((t) =>
          t
            .setPlaceholder("25")
            .setValue(String(s.observerStepInterval))
            .onChange(async (v) => {
              const n = Number.parseInt(v, 10);
              if (Number.isFinite(n) && n > 0) s.observerStepInterval = n;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(el)
      .setName("Memory dream pass")
      .setDesc(
        "Consolidate _system/memory deterministically: merge duplicate learnings, promote well-evidenced ones to rules, mark stale rules. Every run is snapshotted and undoable; set a schedule to automate it, or run it manually from the command palette."
      )
      .addDropdown((d) =>
        d
          .addOptions({ off: "Off", daily: "Daily", weekly: "Weekly" })
          .setValue(s.dreamPassSchedule)
          .onChange(async (v) => {
            s.dreamPassSchedule = v as "off" | "daily" | "weekly";
            await this.plugin.saveSettings();
          })
      );

    this.toggleSetting(
      el,
      "Dream pass — LLM proposal stage",
      "When the dream pass runs, add a transient tool-less LLM stage that PROPOSES typed changes (merge duplicates, supersede, draft rule candidates, import durable claude-mem observations). A deterministic gate culls anything that would touch your own @user memories or match a known-false pattern BEFORE the preview; you still review and can undo every applied change. Off by default; respects the background-AI budget. Claude only.",
      "dreamLlmEnabled"
    );

    new Setting(el)
      .setName("Memory file budget (defrag threshold)")
      .setDesc(
        "When the memory store/ or learnings/ folder exceeds this many files, the dream LLM stage is asked to propose consolidation merges to reduce sprawl."
      )
      .addText((t) =>
        t
          .setPlaceholder("25")
          .setValue(String(s.memoryFileBudget))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.memoryFileBudget = n;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el).setName("Background AI").setHeading();

    this.toggleSetting(
      el,
      "Suggestion inbox",
      "Keep typed suggestions inert until you explicitly accept or dismiss them. Turning this off hides the inbox and stops all proposal routing without deleting retained suggestions.",
      "proposalKernelEnabled"
    );

    if (s.proposalKernelEnabled) {
      this.toggleSetting(
        el,
        "Suggestions after healthy turns",
        "After a completed turn, run a quiet background pass that can add up to three concrete suggestions. Off by default; suggestions never change the vault or settings before Accept.",
        "proposalTurnSuggestions"
      );
    }

    this.toggleSetting(
      el,
      "Enable background AI passes",
      "Master switch for every background LLM pass (self-writing observer, dream LLM stage). Turn off to silence all of them at once regardless of their individual toggles.",
      "backgroundPassesEnabled"
    );

    new Setting(el)
      .setName("Background daily token budget")
      .setDesc(
        "Shared daily cap (UTC) across all background passes. When exhausted, background passes skip silently until the next day. Set 0 for unlimited."
      )
      .addText((t) =>
        t
          .setPlaceholder("200000")
          .setValue(String(s.backgroundDailyTokenBudget))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n >= 0) s.backgroundDailyTokenBudget = n;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName("Background AI model")
      .setDesc(
        "Model used by background LLM passes (self-writing observer's dream stage, and future background passes). Floor is Sonnet — Haiku is never offered here, regardless of the observer's own cheap-model default."
      )
      .addDropdown((d) => {
        for (const o of BACKGROUND_MODEL_OPTIONS) d.addOption(o.id, o.label);
        // Keep an out-of-list saved value (custom id, or a retired option) selectable
        // rather than silently snapping to the first option.
        if (!BACKGROUND_MODEL_OPTIONS.some((o) => o.id === s.backgroundModel)) {
          d.addOption(s.backgroundModel, s.backgroundModel);
        }
        d.setValue(s.backgroundModel);
        d.onChange(async (v) => {
          s.backgroundModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName("Automations")
      .setDesc(
        "Run playbooks unattended on a schedule (hourly / daily / weekly at a set time). Read-only runs produce a report in _system/reports/; write-enabled runs may also edit vault notes, with every touched file snapshotted so the whole run can be restored. Prompts with {{variables}} can't be scheduled."
      )
      .addButton((b) => {
        b.setButtonText(`Manage… (${s.automations.length})`).onClick(() => {
          this.plugin.openAutomationsModal();
        });
      });

    new Setting(el)
      .setName("External tools in playbooks")
      .setDesc(
        "Let playbook runs read your connected external tools via MCP (Gmail, Slack, Calendar, Readwise…) — how the Morning Digest pulls from other apps. Strictly read-only: read tools are auto-allowed, anything that mutates is auto-denied. Slower session start when on."
      )
      .addToggle((t) =>
        t.setValue(s.playbookExternalTools).onChange(async (v) => {
          s.playbookExternalTools = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(el)
      .setName("Learning loop")
      .setDesc(
        "Offer to save a flow as a reusable playbook when the same kind of task recurs — not after a single turn. Exo fingerprints your requests by topic and nudges only once a topic comes back (see threshold below). The offer is free; the distillation runs only if you accept."
      )
      .addToggle((t) =>
        t.setValue(s.learningLoop).onChange(async (v) => {
          s.learningLoop = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(el)
      .setName("Playbook after N repetitions")
      .setDesc(
        "How many times the same kind of task must recur before Exo proposes saving it as a playbook. 3 = rule of three. Lower = proposes sooner; higher = only well-worn habits."
      )
      .addText((t) =>
        t
          .setPlaceholder("3")
          .setValue(String(s.playbookThreshold))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            s.playbookThreshold = Number.isFinite(n) && n >= 2 ? n : 3;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName("Open Cockpit on startup")
      .setDesc("Open the Exo Cockpit view automatically when Obsidian starts.")
      .addToggle((t) =>
        t.setValue(s.cockpitOnStartup).onChange(async (v) => {
          s.cockpitOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(el)
      .setName("Exo Queue — Exo in tasca")
      .setDesc(
        "Il desktop evade le note-richiesta scritte (dal telefono, via Obsidian Sync) nella cartella coda: esegue il corpo della nota headless e READ-ONLY e appende la risposta nella stessa nota, che sincronizza indietro. Poll ogni 60s."
      )
      .addToggle((t) =>
        t.setValue(s.exoQueueEnabled).onChange(async (v) => {
          s.exoQueueEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(el)
      .setName("Cartella della coda")
      .setDesc("Percorso vault-relative delle note richiesta.")
      .addText((t) =>
        t
          .setPlaceholder("_system/exo-queue")
          .setValue(s.exoQueueFolder)
          .onChange(async (v) => {
            s.exoQueueFolder = v.trim() || "_system/exo-queue";
            await this.plugin.saveSettings();
          })
      );
  }

  /* ------------------------------ Advanced ------------------------------ */

  private renderAdvancedTab(el: HTMLElement): void {
    this.toggleSetting(
      el,
      "Fast startup",
      "Skip external MCP servers at session start for snappier first responses. Turn off to load the MCP servers configured below.",
      "fastStartup"
    );
    this.toggleSetting(
      el,
      "Pre-warm the agent session",
      "Start the CLI session in the background the moment Exo opens, so your first message skips the cold start. Claude only.",
      "prewarmSession"
    );
    this.toggleSetting(
      el,
      "Auto-compact (token saver)",
      "Summarize and compact the conversation automatically when the context window fills, so long chats don't re-bill the whole history each turn. Claude only.",
      "autoCompactEnabled"
    );
    this.toggleSetting(
      el,
      "Context-saving mode",
      "Load Obsidian-native tool definitions on demand instead of always in context — saves tokens every turn, at the cost of an occasional extra discovery step. Claude only.",
      "contextSavingMode"
    );
    this.toggleSetting(
      el,
      "Obsidian tools",
      "Give the agent native vault tools (search, read, backlinks, neighborhood, create/edit notes, frontmatter) alongside the standard ones. Claude only.",
      "obsidianToolsEnabled"
    );
    this.toggleSetting(
      el,
      "Native-first",
      "Disable the built-in file tools (Read/Grep/Glob/LS/Edit/Write) so vault work goes only through the Obsidian-native tools. Bash stays available (gated). Claude only.",
      "nativeFirst"
    );

    new Setting(el).setName("Orchestration Board").setHeading();
    this.toggleSetting(
      el,
      "Enable orchestration",
      "Turns on the Orchestration Board: the `add_task` chat tool, the \"Promote to task\" command, and the board itself, so work can be queued up and run as separate conversations instead of inline in this chat. Off by default. Turning it OFF never touches conversations already running — they keep going as normal chats; it only stops new tasks from being queued or started. Claude only.",
      "orchestrationEnabled"
    );

    new Setting(el)
      .setName("Max concurrent tasks")
      .setDesc("How many Orchestration Board tasks the driver runs at the same time. Extra queued tasks wait their turn.")
      .addText((t) => {
        const s = this.plugin.settings;
        t.setPlaceholder("2")
          .setValue(String(s.orchestrationMaxConcurrent))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.orchestrationMaxConcurrent = n;
            await this.plugin.saveSettings();
          });
      });

    void this.renderMcpSection(el);
  }

  /** Structured MCP manager over the project's `.mcp.json` (vault root) plus a
   *  read-only view of global servers (~/.claude.json). Toggling a server off
   *  moves it to `mcpServersDisabled` in the same file (Claude ignores that key)
   *  so a disable is reversible. Live per-server status comes from the latest
   *  session's init snapshot when one exists. */
  private async renderMcpSection(containerEl: HTMLElement): Promise<void> {
    new Setting(containerEl).setName("MCP servers").setHeading();
    const root = containerEl.createDiv();
    await this.drawMcpManager(root);
  }

  private async drawMcpManager(root: HTMLElement): Promise<void> {
    root.empty();
    const redraw = () => void this.drawMcpManager(root);
    const adapter = this.plugin.app.vault.adapter;
    const path = ".mcp.json";
    const s = this.plugin.settings;

    root.createEl("p", {
      cls: "setting-item-description",
      text: "Vault servers live in .mcp.json (vault root) and load into new Claude sessions. Global servers (~/.claude.json) are shown read-only.",
    });

    // Fast-startup gate: external MCP is skipped entirely while it's on. Say it
    // loudly, with the fix one click away — this was the #1 "where are my MCPs?"
    // confusion with the old raw-JSON editor.
    if (s.fastStartup) {
      new Setting(root)
        .setName("External MCP is OFF — Fast startup is on")
        .setDesc("Fast startup spawns sessions with strict MCP (Obsidian-native tools only). Turn it off to load the servers below.")
        .addButton((b) =>
          b.setButtonText("Turn off Fast startup").onClick(async () => {
            s.fastStartup = false;
            await this.plugin.saveSettings();
            redraw();
          })
        );
    }

    let raw = '{\n  "mcpServers": {}\n}';
    try {
      if (await adapter.exists(path)) raw = await adapter.read(path);
    } catch {
      /* missing — use template */
    }
    const parsed = parseMcpJson(raw);
    const liveStatus = new Map((this.plugin.lastSessionCaps?.mcpServers ?? []).map((m) => [m.name, m.status]));
    const save = async (servers: McpServerEntry[]) => {
      await adapter.write(path, serializeMcpJson(servers));
      redraw();
    };

    if (parsed.error) {
      new Setting(root)
        .setName("Couldn't parse .mcp.json")
        .setDesc(`${parsed.error} — fix it in the raw editor below; structured editing is disabled to avoid clobbering the file.`);
    } else {
      if (!parsed.servers.length) {
        root.createEl("p", { cls: "setting-item-description", text: "No vault servers yet — add one below." });
      }
      for (const srv of parsed.servers) {
        const status = liveStatus.get(srv.name);
        const statusPart = status ? ` — ${status}` : "";
        const row = new Setting(root)
          .setName(srv.name)
          .setDesc(`${summarizeServer(srv.config)}${srv.enabled ? statusPart : " — disabled"}`);
        // Live dot: green when the running session reports it connected.
        if (srv.enabled && status) {
          row.nameEl.createSpan({
            text: status === "connected" ? " ●" : " ○",
            attr: { style: `color: ${status === "connected" ? "var(--color-green)" : "var(--color-orange)"}` },
          });
        }
        row.addExtraButton((b) =>
          b
            .setIcon("pencil")
            .setTooltip("Edit in the form below")
            .onClick(() => this.prefillMcpForm(srv))
        );
        row.addExtraButton((b) => {
          let armed = false;
          b.setIcon("trash").setTooltip("Remove (click twice)").onClick(async () => {
            if (!armed) {
              armed = true;
              b.setIcon("alert-triangle").setTooltip("Click again to remove");
              window.setTimeout(() => {
                armed = false;
                b.setIcon("trash").setTooltip("Remove (click twice)");
              }, 3000);
              return;
            }
            await save(removeServer(parsed.servers, srv.name));
          });
        });
        row.addToggle((t) =>
          t.setValue(srv.enabled).onChange((v) => void save(setServerEnabled(parsed.servers, srv.name, v)))
        );
      }
    }

    // Global servers (read-only): visibility, not management — editing a
    // cross-project file from inside one vault is a footgun.
    try {
      const globalRaw = await readFile(`${homedir()}/.claude.json`, "utf8");
      const names = Object.keys((JSON.parse(globalRaw) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
      if (names.length) {
        for (const n of names) {
          const status = liveStatus.get(n);
          new Setting(root).setName(n).setDesc(`global · ~/.claude.json${status ? ` — ${status}` : ""}`);
        }
      }
    } catch {
      /* no global config — fine */
    }

    if (!parsed.error) this.renderMcpAddForm(root, parsed.servers, save);

    // Raw escape hatch, collapsed: structured editing covers the common cases;
    // exotic configs (or a broken file) still have a direct path.
    const details = root.createEl("details");
    details.createEl("summary", { text: "Advanced: edit raw .mcp.json", cls: "setting-item-description" });
    const status = details.createEl("div", { cls: "setting-item-description" });
    const area = new Setting(details).setName(".mcp.json").setDesc("Must be valid JSON with an mcpServers key.");
    area.addTextArea((t) => {
      t.setValue(raw);
      t.inputEl.rows = 10;
      t.inputEl.style.width = "100%";
      t.inputEl.style.fontFamily = "var(--font-monospace)";
      area.addButton((b) =>
        b
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            const next = t.getValue();
            const check = parseMcpJson(next);
            if (check.error) {
              status.setText(check.error);
              status.style.color = "var(--text-error)";
              return;
            }
            await adapter.write(path, next);
            redraw();
          })
      );
    });

    root.createEl("p", {
      cls: "setting-item-description",
      text: "Changes apply to NEW sessions — start a new session (or new tab) to pick them up.",
    });
  }

  /** The add/edit form's live field components, so an Edit click can prefill them. */
  private mcpForm: {
    name?: import("obsidian").TextComponent;
    type?: DropdownComponent;
    target?: import("obsidian").TextComponent;
    args?: import("obsidian").TextComponent;
    extra?: import("obsidian").TextAreaComponent;
  } = {};

  private prefillMcpForm(srv: McpServerEntry): void {
    const f = this.mcpForm;
    const c = srv.config;
    const isStdio = !c.url;
    f.name?.setValue(srv.name);
    f.type?.setValue(isStdio ? "stdio" : typeof c.type === "string" ? c.type : "http");
    f.target?.setValue(String((isStdio ? c.command : c.url) ?? ""));
    f.args?.setValue(Array.isArray(c.args) ? c.args.map(String).join(" ") : "");
    const extra = isStdio ? c.env : c.headers;
    f.extra?.setValue(extra ? JSON.stringify(extra, null, 2) : "");
  }

  private renderMcpAddForm(
    root: HTMLElement,
    servers: McpServerEntry[],
    save: (servers: McpServerEntry[]) => Promise<void>
  ): void {
    const form: ServerFormInput = { name: "", type: "stdio", target: "", args: "", extraJson: "" };
    const err = root.createEl("div", { cls: "setting-item-description" });
    const setErr = (msg: string) => {
      err.setText(msg);
      err.style.color = "var(--text-error)";
    };

    const row = new Setting(root).setName("Add / edit server").setDesc("Same name overwrites (edit).");
    row.addText((t) => {
      this.mcpForm.name = t;
      t.setPlaceholder("name").onChange((v) => (form.name = v));
    });
    row.addDropdown((d) => {
      this.mcpForm.type = d;
      d.addOption("stdio", "stdio").addOption("http", "http").addOption("sse", "sse");
      d.onChange((v) => {
        form.type = v as ServerFormInput["type"];
        this.mcpForm.target?.setPlaceholder(v === "stdio" ? "command (e.g. npx)" : "https://…");
      });
    });
    row.addText((t) => {
      this.mcpForm.target = t;
      t.setPlaceholder("command (e.g. npx)").onChange((v) => (form.target = v));
    });

    const row2 = new Setting(root)
      .setName("Options")
      .setDesc("Args (stdio, space-separated) · env/headers as a JSON object.");
    row2.addText((t) => {
      this.mcpForm.args = t;
      t.setPlaceholder("-y my-mcp-server").onChange((v) => (form.args = v));
    });
    row2.addTextArea((t) => {
      this.mcpForm.extra = t;
      t.setPlaceholder('{"API_KEY": "…"}').onChange((v) => (form.extraJson = v));
      t.inputEl.rows = 2;
    });
    row2.addButton((b) =>
      b
        .setButtonText("Save server")
        .setCta()
        .onClick(async () => {
          // Read the live components (prefill writes to them, not to `form`).
          form.name = this.mcpForm.name?.getValue() ?? form.name;
          form.type = (this.mcpForm.type?.getValue() as ServerFormInput["type"]) ?? form.type;
          form.target = this.mcpForm.target?.getValue() ?? form.target;
          form.args = this.mcpForm.args?.getValue() ?? form.args;
          form.extraJson = this.mcpForm.extra?.getValue() ?? form.extraJson;
          const built = buildServerConfig(form);
          if ("error" in built) {
            setErr(built.error);
            return;
          }
          await save(upsertServer(servers, built.name, built.config));
        })
    );
  }

  /** Muted line under a binary-path field showing the RESOLVED path + CLI
   *  version (async, never blocks render). Turns future binary-drift debugging
   *  into a 5-second glance. */
  private renderCliDiagnostics(containerEl: HTMLElement, name: string, configured: string): void {
    const el = containerEl.createDiv({ cls: "setting-item-description mva-cli-diag" });
    el.setText("Resolving…");
    // Lazily run (or reuse) the daily update check for Claude, so the button
    // below can appear once both the resolved version and the latest are known.
    if (name === "claude") void this.plugin.maybeCheckCliUpdate();
    void cliDiagnostics(name, configured)
      .then((d) => {
        el.setText(
          d.found
            ? `Resolved: ${d.bin}${d.version ? ` — ${d.version}` : ""}`
            : "Not found — set the path explicitly"
        );
        if (name === "claude" && d.found && d.version) this.maybeRenderCliUpdate(containerEl, d.version);
      })
      .catch(() => el.setText("Not found — set the path explicitly"));
  }

  /** When the resolved Claude CLI is older than the latest known published
   *  version, offer a one-click `npm i -g …@latest` update (never auto-run). */
  private maybeRenderCliUpdate(containerEl: HTMLElement, currentVersion: string): void {
    const latest = this.plugin.settings.cliLatestKnown;
    if (!latest || compareSemver(currentVersion, latest) >= 0) return; // unknown or up to date
    const row = new Setting(containerEl)
      .setName(`Update available: ${latest}`)
      .setDesc("A newer Claude CLI has been published. Updating installs it into your global npm prefix.");
    row.addButton((b) =>
      b
        .setButtonText("Update")
        .setCta()
        .onClick(async () => {
          b.setButtonText("Updating…").setDisabled(true);
          new Notice("Updating Claude CLI…");
          const { ok, output } = await updateClaudeCli();
          if (ok) {
            new Notice(`Updated to ${latest} — restart sessions to pick it up.`);
            b.buttonEl.remove();
          } else {
            const tail = output.split("\n").filter(Boolean).slice(-4).join("\n");
            new Notice(`Claude CLI update failed:\n${tail || "unknown error"}`);
            b.setButtonText("Update").setDisabled(false);
          }
        })
    );
  }
}

import { Editor, FileSystemAdapter, FuzzySuggestModal, MarkdownView, Notice, Plugin, WorkspaceLeaf, addIcon, requestUrl } from "obsidian";
import { ChatView, VIEW_TYPE, EXO_ICON } from "./view";
import { DEFAULT_SETTINGS, MVASettingTab, type MVASettings } from "./settings";
import { ADAPTERS } from "./providers/registry";
import { resolveCli } from "./cli";
import { InlineEditModal } from "./ui/inline-edit";
import type { AgentEvent } from "./providers/types";
import { computePlan, applyPlan, undoPlan, type DreamSnapshot } from "./obsidian/dream";
import { DreamModal } from "./ui/dream-modal";
import { runHeadlessPlaybook, writeReport } from "./headless";
import { parseConversationsSource } from "./core/persistence";
import { sanitizeTitle } from "./core/title";
import { buildEditPrompt, buildContinuePrompt } from "./core/inline-ai";
import { inlineAiExtension } from "./editor/inline-ai";
import { selectionObserverExtension } from "./editor/selection-observer";

export default class ExoPlugin extends Plugin {
  settings!: MVASettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Exo brand mark — a concave 4-point star (matches the product logo).
    // addIcon wraps this in an svg with viewBox "0 0 100 100".
    addIcon(
      EXO_ICON,
      '<path fill="currentColor" d="M50 3 Q 50 50 97 50 Q 50 50 50 97 Q 50 50 3 50 Q 50 50 50 3 Z"/>'
    );

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    // In-note AI: a floating toolbar over the selection (Edit / Continue / Ask
    // Exo). Registered once; gated live behind the `inlineAi` setting, so
    // toggling it off makes the extension inert without a reload.
    this.registerEditorExtension(inlineAiExtension(this));

    // Selection observer: reports the active editor's selection to the composer
    // so it shows an ambient "Selection" chip. Registered once; gated live
    // behind `showSelectionChip`, so toggling it off makes it inert.
    this.registerEditorExtension(selectionObserverExtension(this));

    this.addRibbonIcon(EXO_ICON, "Open Exo", () => this.activateView());

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateView(),
    });

    const withView = (fn: (v: ChatView) => void) => () => {
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
      if (view instanceof ChatView) fn(view);
      else void this.activateView();
    };
    this.addCommand({ id: "new-tab", name: "New tab", callback: withView((v) => v.cmdNewTab()) });
    this.addCommand({
      id: "new-session",
      name: "New session (clear current tab)",
      callback: withView((v) => v.cmdNewSession()),
    });
    this.addCommand({ id: "close-tab", name: "Close current tab", callback: withView((v) => v.cmdCloseTab()) });
    this.addCommand({
      id: "fork-conversation",
      name: "Fork conversation into new tab",
      callback: withView((v) => v.cmdForkConversation()),
    });
    this.addCommand({
      id: "compact",
      name: "Compact conversation (free up context)",
      callback: withView((v) => v.cmdCompact()),
    });
    this.addCommand({
      id: "toggle-plan",
      name: "Toggle plan mode",
      callback: withView((v) => v.cmdTogglePlan()),
    });

    this.addCommand({
      id: "inline-edit",
      name: "Inline edit selection",
      editorCallback: (editor: Editor, ctx) => {
        if (!(ctx instanceof MarkdownView)) return;
        this.inlineEdit(editor);
      },
    });

    this.addCommand({
      id: "memory-dream-pass",
      name: "Run memory dream pass (consolidate _system/memory)",
      callback: () => {
        const plan = computePlan(this.app);
        new DreamModal(this.app, plan, async () => {
          const snap = await applyPlan(this.app, plan, new Date().toISOString());
          await this.saveDreamSnapshot(snap);
          new Notice(
            `Dream pass: ${plan.promote.length} promoted, ${plan.dedup.length} merged, ${plan.stale.length} marked stale. Undo from the command palette.`
          );
        }).open();
      },
    });
    this.addCommand({
      id: "memory-dream-undo",
      name: "Undo last memory dream pass",
      callback: async () => {
        const snap = await this.loadDreamSnapshot();
        if (!snap) {
          new Notice("No dream pass to undo.");
          return;
        }
        const n = await undoPlan(this.app, snap);
        await this.clearDreamSnapshot();
        new Notice(`Undid the dream pass — restored ${n} file(s).`);
      },
    });
    // Hourly check; runs a scheduled pass only when due per settings.
    this.registerInterval(window.setInterval(() => void this.maybeScheduledDreamPass(), 60 * 60 * 1000));

    this.addCommand({
      id: "run-playbook",
      name: "Run playbook now (headless, read-only)",
      callback: () => {
        const prompts = this.settings.customPrompts;
        if (!prompts.length) {
          new Notice("No custom prompts yet — add some in Exo settings.");
          return;
        }
        new PlaybookPicker(this.app, prompts, (p) => void this.runPlaybook(p.name, p.prompt)).open();
      },
    });
    this.registerInterval(window.setInterval(() => void this.checkScheduledRuns(), 30 * 60 * 1000));

    this.addSettingTab(new MVASettingTab(this.app, this));

    // Daily, non-blocking Claude-CLI update check (failures silent).
    void this.maybeCheckCliUpdate();
  }

  /**
   * Check npm for a newer Claude CLI, at most once per day. Caches the result in
   * settings (`cliLatestKnown` + `cliUpdateCheckAt`) so the settings tab can show
   * an update button without a network round-trip on every render. Uses
   * Obsidian's `requestUrl` (not node fetch — desktop CSP/proxy safe). Never
   * throws; a failed check just records the attempt so we don't hammer the API.
   */
  async maybeCheckCliUpdate(force = false): Promise<void> {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (!force && this.settings.cliUpdateCheckAt && now - this.settings.cliUpdateCheckAt < DAY) return;
    try {
      const res = await requestUrl({
        url: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
      });
      const version = (res.json as { version?: unknown } | undefined)?.version;
      if (typeof version === "string" && version) this.settings.cliLatestKnown = version;
    } catch {
      /* offline / registry down — silent */
    } finally {
      this.settings.cliUpdateCheckAt = now;
      await this.saveSettings();
    }
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
      if (leaf.view instanceof ChatView) leaf.view.focusComposer();
    }
  }

  private vaultPath(): string {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : ".";
  }

  /**
   * Core of every one-shot text transform: a transient, tool-less session that
   * streams `text-delta` chunks to `onDelta` and resolves with the full text.
   * The session is disposed on abort and on completion. Shared by `oneShot`
   * (modal), `oneShotStream` (inline Edit) and `continueStream` (inline
   * Continue) so there's one place that owns the CLI session lifecycle.
   */
  private async runStream(
    prompt: string,
    signal: AbortSignal,
    onDelta: (text: string) => void
  ): Promise<string> {
    const provider = this.settings.provider;
    const bin = provider === "claude" ? this.settings.claudeBin : this.settings.codexBin;
    const cli = await resolveCli(provider, bin);
    const session = ADAPTERS[provider].createSession({
      cli,
      model: provider === "claude" ? this.settings.claudeModel : this.settings.codexModel,
      effort: "default",
      cwd: this.vaultPath(),
      permissionMode: "default",
      toolsEnabled: false, // pure text transform — no tools needed
      fastStartup: true,
    });
    signal.addEventListener("abort", () => {
      try {
        session.dispose();
      } catch {
        /* already torn down */
      }
    });
    let out = "";
    try {
      await session.send(prompt, (e: AgentEvent) => {
        if (e.kind === "text-delta") {
          out += e.text;
          onDelta(e.text);
        }
      });
    } finally {
      session.dispose();
    }
    return out;
  }

  /** One-shot text transform (no streaming): returns the trimmed result. Used by
   *  the legacy inline-edit modal. */
  private async oneShot(instruction: string, text: string, signal: AbortSignal): Promise<string> {
    return (await this.runStream(buildEditPrompt(instruction, text), signal, () => {})).trim();
  }

  /** Streaming Edit: rewrite `text` per `instruction`, emitting live chunks via
   *  `onDelta`. Resolves with the full (untrimmed — the diff needs raw text)
   *  result. Used by the in-note floating toolbar's Edit action. */
  async oneShotStream(
    instruction: string,
    text: string,
    signal: AbortSignal,
    onDelta: (text: string) => void
  ): Promise<string> {
    return this.runStream(buildEditPrompt(instruction, text), signal, onDelta);
  }

  /** Streaming Continue: keep writing from `precedingText`, emitting live chunks
   *  via `onDelta`. Resolves with the continuation only. Used by the in-note
   *  Continue action. */
  async continueStream(
    precedingText: string,
    signal: AbortSignal,
    onDelta: (text: string) => void
  ): Promise<string> {
    return this.runStream(buildContinuePrompt(precedingText), signal, onDelta);
  }

  /** Reveal the Exo chat and seed the given selection as a quoted context block
   *  in the composer, then focus it — the in-note "Ask Exo" action. */
  async attachSelectionToChat(text: string, sourcePath: string): Promise<void> {
    await this.activateView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof ChatView) view.attachSelection(text, sourcePath);
  }

  /** Forward the active editor's current selection to the open chat view so it
   *  renders an ambient "Selection" chip in the composer (`text=""` clears it).
   *  Unlike `attachSelectionToChat`, this never reveals/activates the view — it's
   *  passive ambient state: if no ChatView is open there's simply nothing to show. */
  reportSelection(text: string, sourcePath: string): void {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof ChatView) view.setCurrentSelection(text, sourcePath);
  }

  /** Generate a concise 3-6 word chat title with Haiku. ALWAYS runs on the Claude
   *  CLI (its own model), regardless of the conversation's provider — a cheap,
   *  latency-sensitive one-liner. Transient, tool-less session (same shape as
   *  `oneShot`). Never throws: if the Claude CLI can't be resolved or the call
   *  errors/aborts/times out it resolves to "" and the caller keeps the truncated
   *  placeholder. An internal 15s timeout (plus the caller's `signal`) guarantees
   *  a hung call can't leak. */
  async generateTitle(userText: string, assistantText: string, signal: AbortSignal): Promise<string> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const cli = await resolveCli("claude", this.settings.claudeBin);
      const session = ADAPTERS.claude.createSession({
        cli,
        model: "claude-haiku-4-5", // explicit Mario directive — cheap/fast one-liner
        effort: "default",
        cwd: this.vaultPath(),
        permissionMode: "default",
        toolsEnabled: false, // title only — no tools
        fastStartup: true,
      });
      ctrl.signal.addEventListener("abort", () => {
        try {
          session.dispose();
        } catch {
          /* already torn down */
        }
      });
      // Cap the input (~1500 chars total) so the call stays cheap and fast.
      const user = userText.replace(/\s+/g, " ").trim().slice(0, 800);
      const asst = assistantText.replace(/\s+/g, " ").trim().slice(0, 700);
      const prompt =
        "Write a short, specific title for this chat. Rules: 3-6 words, plain text only, " +
        "no surrounding quotes, no backticks, no trailing punctuation, and no preamble " +
        '(never "Chat about…", "Title:", etc). Return ONLY the title.\n\n' +
        `User: ${user}\n\nAssistant: ${asst}`;
      let out = "";
      try {
        await session.send(prompt, (e: AgentEvent) => {
          if (e.kind === "text-delta") out += e.text;
        });
      } finally {
        session.dispose();
      }
      return sanitizeTitle(out);
    } catch {
      return ""; // CLI missing / errored / aborted — keep the placeholder
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private inlineEdit(editor: Editor): void {
    const selection = editor.getSelection();
    const text = selection || editor.getLine(editor.getCursor().line);
    if (!text.trim()) {
      new Notice("Select some text (or place the cursor on a non-empty line) to edit.");
      return;
    }
    const hadSelection = selection.length > 0;
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const line = editor.getCursor().line;
    new InlineEditModal(this.app, text, (instr, t, sig) => this.oneShot(instr, t, sig), (next) => {
      if (hadSelection) {
        editor.replaceRange(next, from, to);
      } else {
        editor.replaceRange(next, { line, ch: 0 }, { line, ch: editor.getLine(line).length });
      }
    }).open();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Migrate the old "Default" model option (empty id — silently let the CLI's
    // own default apply): the picker no longer offers an ambiguous unlabeled
    // state, so an empty saved id resolves to that provider's first real model.
    if (!this.settings.claudeModel) this.settings.claudeModel = ADAPTERS.claude.models()[0].id;
    if (!this.settings.codexModel) this.settings.codexModel = ADAPTERS.codex.models()[0].id;
    // Seed a few example reusable prompts on first run (once) so "Your prompts"
    // isn't empty. They're editable/deletable in Settings; never re-seeded.
    if (!this.settings.seededPrompts && this.settings.customPrompts.length === 0) {
      this.settings.customPrompts = [
        { name: "Distill", prompt: "Distill this note to its 3 core ideas, each as one crisp sentence." },
        { name: "Devil's advocate", prompt: "Argue the strongest case against the main claim in this note." },
        { name: "Next actions", prompt: "Turn this note into a short checklist of concrete next actions." },
      ];
      this.settings.seededPrompts = true;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private convoFile(): string {
    return `${this.manifest.dir}/conversations.json`;
  }

  /**
   * Persisted conversation history (separate from settings/data.json).
   *
   * Recovery-aware: reads the main file AND its `.bak` rotation, then defers the
   * trust decision to the pure `parseConversationsSource`. When the main file
   * exists but is corrupt it is NEVER deleted — it's renamed aside as
   * `<file>.corrupt-<epoch>` for forensics, and the user is told whether history
   * was recovered from backup or lost.
   */
  async loadConversations(): Promise<unknown[]> {
    const adapter = this.app.vault.adapter;
    const p = this.convoFile();
    const bak = `${p}.bak`;
    const readOrNull = async (path: string): Promise<string | null> => {
      try {
        return (await adapter.exists(path)) ? await adapter.read(path) : null;
      } catch {
        return null;
      }
    };
    const mainRaw = await readOrNull(p);
    const bakRaw = await readOrNull(bak);
    const { data, source, mainCorrupt } = parseConversationsSource(mainRaw, bakRaw);
    if (mainCorrupt) {
      // Preserve the corrupt file — never start silently empty over a bad file.
      try {
        if (await adapter.exists(p)) await adapter.rename(p, `${p}.corrupt-${Date.now()}`);
      } catch {
        /* best effort — recovery still proceeds */
      }
      new Notice(
        source === "bak"
          ? "Exo recovered conversation history from a backup — the main file was corrupted (kept for recovery)."
          : "Exo couldn't read conversation history — the file was corrupted and no usable backup existed (kept for recovery)."
      );
    }
    return data;
  }

  /**
   * Atomic, backup-rotating write. Returns false (never throws) if it failed, so
   * callers can surface it. Sequence — at no intermediate step are BOTH the main
   * file and its `.bak` missing/incomplete:
   *   1. write the payload to `<file>.tmp` (main + bak stay intact)
   *   2. rotate the current main file to `<file>.bak` (one generation)
   *   3. rename `.tmp` over the main path
   */
  async saveConversations(data: unknown[]): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    const p = this.convoFile();
    const tmp = `${p}.tmp`;
    const bak = `${p}.bak`;
    try {
      const json = JSON.stringify(data);
      // 1. Stage the new content. A crash here leaves main (and bak) untouched.
      await adapter.write(tmp, json);
      // 2. Rotate the live main file to .bak before replacing it. Rename can't
      //    overwrite an existing target on every platform, so clear the old bak
      //    first. Main is still present throughout this step.
      if (await adapter.exists(p)) {
        if (await adapter.exists(bak)) await adapter.remove(bak);
        await adapter.rename(p, bak);
      }
      // 3. Move the staged file over the (now absent) main path.
      await adapter.rename(tmp, p);
      return true;
    } catch {
      // Drop a stray tmp so a half-written file can't be mistaken for real data.
      try {
        if (await adapter.exists(tmp)) await adapter.remove(tmp);
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  private dreamFile(): string {
    return `${this.manifest.dir}/dream-snapshot.json`;
  }
  async saveDreamSnapshot(s: DreamSnapshot): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.dreamFile(), JSON.stringify(s));
    } catch {
      /* non-fatal */
    }
  }
  async loadDreamSnapshot(): Promise<DreamSnapshot | null> {
    try {
      const p = this.dreamFile();
      if (await this.app.vault.adapter.exists(p)) return JSON.parse(await this.app.vault.adapter.read(p)) as DreamSnapshot;
    } catch {
      /* corrupt/missing */
    }
    return null;
  }
  async clearDreamSnapshot(): Promise<void> {
    try {
      const p = this.dreamFile();
      if (await this.app.vault.adapter.exists(p)) await this.app.vault.adapter.remove(p);
    } catch {
      /* ignore */
    }
  }
  private async maybeScheduledDreamPass(): Promise<void> {
    const sched = this.settings.dreamPassSchedule;
    if (sched === "off") return;
    const now = Date.now();
    const period = sched === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    if (this.settings.lastDreamPass && now - this.settings.lastDreamPass < period) return;
    const plan = computePlan(this.app);
    this.settings.lastDreamPass = now;
    await this.saveSettings();
    if (plan.promote.length + plan.dedup.length + plan.stale.length === 0) return;
    const snap = await applyPlan(this.app, plan, new Date().toISOString());
    await this.saveDreamSnapshot(snap);
    new Notice(
      `Scheduled dream pass: ${plan.promote.length} promoted, ${plan.dedup.length} merged, ${plan.stale.length} stale. Undo from the command palette.`
    );
  }

  /** Run one playbook headlessly and write its report. */
  private async runPlaybook(name: string, prompt: string): Promise<void> {
    if (/\{\{\s*[\w-]+\s*\}\}/.test(prompt)) {
      new Notice(`"${name}" has {{variables}} — run it from the composer instead.`);
      return;
    }
    new Notice(`Running playbook "${name}"…`);
    const result = await runHeadlessPlaybook(this.app, this.settings, prompt);
    const path = await writeReport(this.app, name, result);
    new Notice(
      result.ok ? `Playbook "${name}" done → ${path}` : `Playbook "${name}" failed (report: ${path})`
    );
  }

  /** Run any scheduled playbooks that are due (off by default — empty list). */
  private async checkScheduledRuns(): Promise<void> {
    const lines = this.settings.scheduledRuns.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const now = Date.now();
    for (const line of lines) {
      const i = line.lastIndexOf("|");
      if (i < 0) continue;
      const name = line.slice(0, i).trim();
      const cadence = line.slice(i + 1).trim().toLowerCase();
      const period = cadence === "daily" ? 20 * 60 * 60 * 1000 : cadence === "weekly" ? 6.5 * 24 * 60 * 60 * 1000 : 0;
      if (!period || !name) continue;
      const p = this.settings.customPrompts.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!p) continue;
      const last = this.settings.scheduledLastRun[p.name] ?? 0;
      if (now - last < period) continue;
      this.settings.scheduledLastRun[p.name] = now;
      await this.saveSettings();
      await this.runPlaybook(p.name, p.prompt); // sequential — one at a time
    }
  }
}

/* --------------------------- playbook picker --------------------------- */
class PlaybookPicker extends FuzzySuggestModal<{ name: string; prompt: string }> {
  constructor(
    app: import("obsidian").App,
    private prompts: { name: string; prompt: string }[],
    private onPick: (p: { name: string; prompt: string }) => void
  ) {
    super(app);
    this.setPlaceholder("Run a playbook (read-only, report to _system/reports/)…");
  }
  getItems(): { name: string; prompt: string }[] {
    return this.prompts;
  }
  getItemText(p: { name: string; prompt: string }): string {
    return p.name;
  }
  onChooseItem(p: { name: string; prompt: string }): void {
    this.onPick(p);
  }
}

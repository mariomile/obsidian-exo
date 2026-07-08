/**
 * Task modal — the single creation/edit surface for Orchestration Board tasks
 * (it replaced the Backlog column's inline quick-add form, 2026-07-08).
 *
 * Fields: title, prompt (auto-growing textarea with the composer's `@` note
 * autocomplete), attached context notes (chips, appended to the prompt as
 * `[[wikilinks]]` by `buildTaskPrompt` — the ledger's data model is unchanged),
 * model picker, and — in create mode only — a "Run immediately" toggle that
 * enqueues the task as soon as it's created.
 *
 * Design language: this modal follows the plugin's own patterns, not generic
 * Obsidian-modal defaults — quiet sentence-case labels (`--font-ui-smaller`,
 * muted, like the prompt-vars modal), `.mva-pv-input`-style fields (accent
 * border on focus), the composer's chip + `.mva-sel-pop` popover for the model
 * picker (never a native <select>), and `.mva-btn` buttons.
 *
 * The modal is deliberately dumb: it collects values and hands a
 * `TaskModalResult` to `onSubmit`. The BoardView owns what happens next
 * (store create/update, driver reload, run) — same one-way dependency rules
 * as the rest of the board.
 */
import { App, Modal, TFile, setIcon } from "obsidian";
import { buildTaskPrompt } from "../core/tasks";
import { Autocomplete, type AcItem } from "./autocomplete";
import { openablePopover } from "./popover";

export interface TaskModalResult {
  title: string;
  /** Final prompt — context-note wikilinks already appended. */
  prompt: string;
  /** Set only when pinned to a non-default model; `undefined` clears a pin. */
  model: string | undefined;
  /** Create mode only — enqueue right after creation. Always false in edit. */
  runImmediately: boolean;
}

export interface TaskModalOptions {
  mode: "create" | "edit";
  /** Prefill (edit mode, or a seeded create). */
  initial?: { title?: string; prompt?: string; model?: string };
  modelChoices: { id: string; label: string }[];
  defaultModel: string;
  onSubmit: (result: TaskModalResult) => void | Promise<void>;
}

export class TaskModal extends Modal {
  private titleInput!: HTMLInputElement;
  private promptInput!: HTMLTextAreaElement;
  private selectedModel!: string;
  private modelChipEl!: HTMLElement;
  private closePopover: (() => void) | null = null;
  private runToggle: HTMLInputElement | null = null;
  private contextNotes: string[] = [];
  private chipsEl!: HTMLElement;

  constructor(
    app: App,
    private readonly opts: TaskModalOptions
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("mva-task-modal-window");
    contentEl.addClass("mva-task-modal");
    this.titleEl.setText(this.opts.mode === "create" ? "New task" : "Edit task");

    // Title.
    const titleField = contentEl.createDiv({ cls: "mva-task-modal-field" });
    titleField.createDiv({ cls: "mva-task-modal-label", text: "Title" });
    this.titleInput = titleField.createEl("input", {
      attr: { type: "text", placeholder: "What should this task achieve?" },
    }) as HTMLInputElement;
    this.titleInput.value = this.opts.initial?.title ?? "";

    // Prompt — auto-growing textarea with `@` note mentions (composer muscle
    // memory: same trigger, inserts a [[wikilink]] inline).
    const promptField = contentEl.createDiv({ cls: "mva-task-modal-field" });
    promptField.createDiv({ cls: "mva-task-modal-label", text: "Prompt" });
    this.promptInput = promptField.createEl("textarea", {
      attr: { placeholder: "Instructions for the agent — @ to mention a note", rows: "5" },
    }) as HTMLTextAreaElement;
    this.promptInput.value = this.opts.initial?.prompt ?? "";
    this.promptInput.addEventListener("input", () => this.autoGrow());
    new Autocomplete(this.promptInput, promptField, [
      { trigger: "@", getItems: (q) => this.noteItems(q, (name) => `[[${name}]] `) },
    ]);

    // Context notes — chips + an `@` search box; selected notes are appended
    // to the prompt as a "Context notes" wikilink list on submit.
    const ctxField = contentEl.createDiv({ cls: "mva-task-modal-field" });
    ctxField.createDiv({ cls: "mva-task-modal-label", text: "Context notes" });
    this.chipsEl = ctxField.createDiv({ cls: "mva-task-modal-chips" });
    const ctxInput = ctxField.createEl("textarea", {
      cls: "mva-task-modal-ctx-input",
      attr: { placeholder: "@ to attach a note", rows: "1" },
    }) as HTMLTextAreaElement;
    new Autocomplete(ctxInput, ctxField, [
      {
        trigger: "@",
        getItems: (q) =>
          this.noteItems(q, () => "").map((item) => ({
            ...item,
            onSelect: () => {
              this.addContextNote(item.label);
              ctxInput.value = "";
            },
          })),
      },
    ]);
    this.renderChips();

    // Model — the composer's chip + popover pattern (.mva-sel), never a native
    // <select>. The popover opens upward from the chip, same as the toolbar.
    this.selectedModel = this.opts.initial?.model ?? this.opts.defaultModel;
    const modelField = contentEl.createDiv({ cls: "mva-task-modal-field mva-task-modal-row" });
    modelField.createDiv({ cls: "mva-task-modal-label", text: "Model" });
    this.buildModelPicker(modelField);

    // Footer: run-immediately (create only) + submit.
    const footer = contentEl.createDiv({ cls: "mva-task-modal-footer" });
    if (this.opts.mode === "create") {
      const runWrap = footer.createEl("label", { cls: "mva-task-modal-run" });
      this.runToggle = runWrap.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
      runWrap.createSpan({ text: "Run immediately" });
    }
    const submitBtn = footer.createEl("button", {
      cls: "mva-btn mva-btn-primary",
      text: this.opts.mode === "create" ? "Add task" : "Save",
    });
    submitBtn.addEventListener("click", () => void this.submit());
    contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void this.submit();
    });

    this.autoGrow();
    window.setTimeout(() => this.titleInput.focus(), 0);
  }

  onClose(): void {
    this.closePopover?.();
    this.closePopover = null;
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    const title = this.titleInput.value.trim();
    if (!title) {
      this.titleInput.focus();
      return;
    }
    const body = this.promptInput.value.trim() || title;
    const prompt = buildTaskPrompt(body, this.contextNotes);
    const result: TaskModalResult = {
      title,
      prompt,
      model: this.selectedModel !== this.opts.defaultModel ? this.selectedModel : undefined,
      runImmediately: this.runToggle?.checked ?? false,
    };
    this.close();
    await this.opts.onSubmit(result);
  }

  // --- Model picker (chip + popover) ---------------------------------------

  private buildModelPicker(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: "mva-sel" });
    const chip = wrap.createDiv({ cls: "mva-sel-chip mva-task-modal-model" });
    this.modelChipEl = chip;
    const pop = wrap.createDiv({ cls: "mva-sel-pop" });
    pop.hide();

    const renderChip = () => {
      const current = this.opts.modelChoices.find((o) => o.id === this.selectedModel);
      chip.setText(current?.label ?? this.selectedModel);
    };
    const renderRows = () => {
      pop.empty();
      for (const o of this.opts.modelChoices) {
        const row = pop.createDiv({ cls: "mva-sel-opt" + (o.id === this.selectedModel ? " is-active" : "") });
        row.createSpan({ cls: "mva-sel-opt-label", text: o.label });
        if (o.id === this.selectedModel) {
          const check = row.createSpan({ cls: "mva-sel-opt-check" });
          setIcon(check, "check");
        }
        row.addEventListener("click", () => {
          this.selectedModel = o.id;
          renderChip();
          popover.close();
        });
      }
    };

    const popover = openablePopover({ anchor: chip, pop, wrap, onOpen: renderRows });
    this.closePopover = popover.close;
    chip.addEventListener("click", () => popover.toggle());
    renderChip();
  }

  // --- Context-note chips ---------------------------------------------------

  private addContextNote(name: string): void {
    if (!name || this.contextNotes.includes(name)) return;
    this.contextNotes.push(name);
    this.renderChips();
  }

  private renderChips(): void {
    this.chipsEl.empty();
    this.chipsEl.toggleClass("is-empty", this.contextNotes.length === 0);
    for (const name of this.contextNotes) {
      const chip = this.chipsEl.createSpan({ cls: "mva-task-modal-chip" });
      chip.createSpan({ text: name });
      const remove = chip.createSpan({ cls: "mva-task-modal-chip-x" });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        this.contextNotes = this.contextNotes.filter((n) => n !== name);
        this.renderChips();
      });
    }
  }

  // --- Helpers ----------------------------------------------------------------

  /** Vault markdown files as autocomplete items; `insert` decides what lands in
   *  the textarea (a wikilink for prompt mentions, nothing for the chips box). */
  private noteItems(query: string, insert: (name: string) => string): AcItem[] {
    const q = query.toLowerCase();
    const out: AcItem[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const name = f.basename;
      if (q && !name.toLowerCase().includes(q) && !f.path.toLowerCase().includes(q)) continue;
      out.push({ label: name, detail: parentPath(f), icon: "file-text", insert: insert(name) });
      if (out.length >= 50) break;
    }
    return out;
  }

  private autoGrow(): void {
    this.promptInput.style.height = "auto";
    this.promptInput.style.height = `${Math.min(this.promptInput.scrollHeight, 320)}px`;
  }
}

/** Parent folder of a file, for the autocomplete detail line ("" at root). */
function parentPath(f: TFile): string {
  const i = f.path.lastIndexOf("/");
  return i > 0 ? f.path.slice(0, i) : "";
}

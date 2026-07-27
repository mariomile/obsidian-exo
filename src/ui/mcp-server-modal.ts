/**
 * Add / edit an MCP server from the Connections pane. Reuses the shared
 * `buildServerConfig` validator (mcp-config.ts) so the pane and the (legacy)
 * settings form agree on what a valid server is, and follows the canonical form
 * recipe: `.mva-pv-label` quiet labels, chip + `.mva-sel-pop` popover for the
 * transport (never a native <select>), `.mva-btn` buttons. The modal owns no
 * persistence — it hands the built `{ name, config }` back to `onSubmit`, which
 * writes `.mcp.json` and reconnects.
 */
import { App, Modal, setIcon } from "obsidian";
import { clickable } from "./dom";
import { openablePopover } from "./popover";
import { buildServerConfig, type ServerFormInput } from "../core/mcp-config";

type Transport = ServerFormInput["type"];

const TRANSPORTS: { value: Transport; label: string }[] = [
  { value: "stdio", label: "stdio" },
  { value: "http", label: "http" },
  { value: "sse", label: "sse" },
];

/** Derive the editable form fields from an existing `.mcp.json` server config —
 *  mirrors the shape `buildServerConfig` produces so an edit round-trips. */
function inputFromConfig(name: string, config: Record<string, unknown>): ServerFormInput {
  const isStdio = !config.url;
  const type: Transport = isStdio ? "stdio" : typeof config.type === "string" ? (config.type as Transport) : "http";
  const target = String((isStdio ? config.command : config.url) ?? "");
  const args = Array.isArray(config.args) ? config.args.map(String).join(" ") : "";
  const extra = isStdio ? config.env : config.headers;
  const extraJson = extra ? JSON.stringify(extra, null, 2) : "";
  return { name, type, target, args, extraJson };
}

export class McpServerModal extends Modal {
  private form: ServerFormInput;
  private readonly editing: boolean;
  private targetInput!: HTMLInputElement;
  private argsRow!: HTMLElement;
  private extraLabel!: HTMLElement;

  constructor(
    app: App,
    private readonly opts: {
      /** Present → edit mode (name locked); absent → add a fresh server. */
      initial?: { name: string; config: Record<string, unknown> };
      onSubmit: (built: { name: string; config: Record<string, unknown> }) => void | Promise<void>;
    }
  ) {
    super(app);
    this.editing = !!opts.initial;
    this.form = opts.initial
      ? inputFromConfig(opts.initial.name, opts.initial.config)
      : { name: "", type: "stdio", target: "", args: "", extraJson: "" };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mva-root", "mva-mcp-modal");
    contentEl.createEl("h3", { cls: "mva-mcp-modal-title", text: this.editing ? "Edit MCP server" : "Add MCP server" });

    // Name (locked on edit — the name is the .mcp.json key).
    const nameRow = contentEl.createDiv({ cls: "mva-pv-row" });
    nameRow.createSpan({ cls: "mva-pv-label", text: "Name" });
    const nameInput = nameRow.createEl("input", {
      cls: "mva-pv-input",
      attr: { type: "text", placeholder: "e.g. supabase", spellcheck: "false" },
    });
    nameInput.value = this.form.name;
    nameInput.disabled = this.editing;
    nameInput.oninput = () => (this.form.name = nameInput.value);

    // Transport chip-select.
    const typeRow = contentEl.createDiv({ cls: "mva-pv-row" });
    typeRow.createSpan({ cls: "mva-pv-label", text: "Transport" });
    this.buildTransportSelect(typeRow);

    // Target (command for stdio, URL for http/sse).
    const targetRow = contentEl.createDiv({ cls: "mva-pv-row" });
    targetRow.createSpan({ cls: "mva-pv-label", text: "Command or URL" });
    this.targetInput = targetRow.createEl("input", {
      cls: "mva-pv-input",
      attr: { type: "text", spellcheck: "false" },
    });
    this.targetInput.value = this.form.target;
    this.targetInput.oninput = () => (this.form.target = this.targetInput.value);

    // Args (stdio only).
    this.argsRow = contentEl.createDiv({ cls: "mva-pv-row" });
    this.argsRow.createSpan({ cls: "mva-pv-label", text: "Args" });
    const argsInput = this.argsRow.createEl("input", {
      cls: "mva-pv-input",
      attr: { type: "text", placeholder: "-y my-mcp-server", spellcheck: "false" },
    });
    argsInput.value = this.form.args;
    argsInput.oninput = () => (this.form.args = argsInput.value);

    // Env / headers as a JSON object.
    const extraRow = contentEl.createDiv({ cls: "mva-pv-row" });
    this.extraLabel = extraRow.createSpan({ cls: "mva-pv-label" });
    const extraInput = extraRow.createEl("textarea", {
      cls: "mva-pv-input mva-mcp-extra",
      attr: { rows: "3", placeholder: '{"API_KEY": "…"}', spellcheck: "false" },
    });
    extraInput.value = this.form.extraJson;
    extraInput.oninput = () => (this.form.extraJson = extraInput.value);

    const err = contentEl.createDiv({ cls: "mva-mcp-modal-err" });

    const actions = contentEl.createDiv({ cls: "mva-mcp-modal-actions" });
    const cancel = actions.createEl("button", { cls: "mva-btn", text: "Cancel" });
    cancel.onclick = () => this.close();
    const save = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Save" });
    save.onclick = () => void this.submit(err, save);

    this.syncTransportFields();
  }

  private buildTransportSelect(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: "mva-sel" });
    const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": "Transport" } });
    const setChip = () => chip.setText(this.form.type);
    setChip();
    const pop = wrap.createDiv({ cls: "mva-sel-pop" });
    pop.hide();
    const popover = openablePopover({
      anchor: chip,
      pop,
      wrap,
      onOpen: () => {
        pop.empty();
        for (const o of TRANSPORTS) {
          const opt = pop.createDiv({ cls: "mva-sel-opt", attr: { tabindex: "0" } });
          const dot = opt.createSpan({ cls: "mva-sel-opt-dot" });
          if (o.value === this.form.type) setIcon(dot, "check");
          opt.createSpan({ cls: "mva-sel-opt-label", text: o.label });
          clickable(opt, () => {
            this.form.type = o.value;
            setChip();
            this.syncTransportFields();
            popover.close();
          });
        }
      },
      focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
    });
    clickable(chip, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
  }

  /** stdio takes a command + args + env; http/sse take a URL + headers (no args). */
  private syncTransportFields(): void {
    const stdio = this.form.type === "stdio";
    this.targetInput.placeholder = stdio ? "command (e.g. npx)" : "https://…";
    this.argsRow.toggle(stdio);
    this.extraLabel.setText(stdio ? "Env (JSON)" : "Headers (JSON)");
  }

  private async submit(err: HTMLElement, save: HTMLButtonElement): Promise<void> {
    err.setText("");
    const built = buildServerConfig(this.form);
    if ("error" in built) {
      err.setText(built.error);
      return;
    }
    save.disabled = true;
    try {
      await this.opts.onSubmit(built);
      this.close();
    } catch (e) {
      err.setText(e instanceof Error ? e.message : String(e));
      save.disabled = false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

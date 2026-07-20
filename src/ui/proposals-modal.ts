import { App, Modal, setIcon } from "obsidian";
import type { ProposalPayload, ProposalRecord } from "../core/proposals";
import type { PendingProposals, ProposalAcceptResult } from "../obsidian/proposal-store";

export interface ProposalsModalOptions {
  loadPending(): Promise<PendingProposals>;
  accept(id: string): Promise<ProposalAcceptResult>;
  dismiss(id: string): Promise<ProposalRecord>;
  sourceTitle(convoId: string): string;
  lastRouteError(id: string): string | undefined;
}

export function proposalTargetLabel(payload: ProposalPayload): string {
  switch (payload.kind) {
    case "task": return "Orchestration backlog";
    case "loop": return "Open Loops";
    case "decision": return "Decision record";
    case "playbook": return "Custom prompts";
  }
}

export function proposalPayloadDetails(payload: ProposalPayload): { label: string; value: string }[] {
  switch (payload.kind) {
    case "task":
      return [
        { label: "Prompt", value: payload.prompt },
        ...(payload.model ? [{ label: "Model", value: payload.model }] : []),
      ];
    case "loop":
      return [
        { label: "Note", value: payload.note },
        ...(payload.resurface ? [{ label: "Resurface", value: payload.resurface }] : []),
        ...(payload.tags?.length ? [{ label: "Tags", value: payload.tags.join(", ") }] : []),
      ];
    case "decision":
      return [
        { label: "Context", value: payload.context },
        { label: "Decision", value: payload.decision },
        ...(payload.rationale ? [{ label: "Rationale", value: payload.rationale }] : []),
      ];
    case "playbook":
      return [{ label: "Prompt", value: payload.prompt }];
  }
}

/** Quiet, one-at-a-time review surface. Mutations exist only behind explicit clicks. */
export class ProposalsModal extends Modal {
  private records: ProposalRecord[] = [];
  private selectedId: string | null = null;
  private busyId: string | null = null;
  private readonly sessionErrors = new Map<string, string>();

  constructor(app: App, private readonly options: ProposalsModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mva-proposals-window");
    this.contentEl.addClass("mva-proposals");
    this.titleEl.setText("Suggestions");
    void this.reload();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async reload(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "mva-proposals-loading", text: "Loading suggestions…" });
    try {
      const pending = await this.options.loadPending();
      this.records = pending.records;
      if (!this.records.some(({ id }) => id === this.selectedId)) {
        this.selectedId = this.records[0]?.id ?? null;
      }
      this.render();
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createDiv({
        cls: "mva-proposals-empty",
        text: error instanceof Error ? error.message : "Suggestions could not be loaded.",
      });
    }
  }

  private render(): void {
    this.contentEl.empty();
    if (!this.records.length) {
      const empty = this.contentEl.createDiv({ cls: "mva-proposals-empty" });
      setIcon(empty.createSpan({ cls: "mva-proposals-empty-icon" }), "inbox");
      empty.createDiv({ text: "No suggestions waiting" });
      return;
    }

    const layout = this.contentEl.createDiv({ cls: "mva-proposals-layout" });
    const list = layout.createDiv({ cls: "mva-proposals-list" });
    for (const record of this.records) {
      const row = list.createEl("button", {
        cls: `mva-proposals-row${record.id === this.selectedId ? " is-active" : ""}`,
        attr: { type: "button" },
      });
      row.createSpan({ cls: "mva-proposals-kind", text: record.kind });
      row.createSpan({ cls: "mva-proposals-row-title", text: record.title });
      row.createSpan({ cls: "mva-proposals-row-target", text: proposalTargetLabel(record.payload) });
      row.onclick = () => {
        this.selectedId = record.id;
        this.render();
      };
    }

    const selected = this.records.find(({ id }) => id === this.selectedId) ?? this.records[0];
    this.renderDetail(layout.createDiv({ cls: "mva-proposals-detail" }), selected);
  }

  private renderDetail(parent: HTMLElement, record: ProposalRecord): void {
    parent.createSpan({ cls: "mva-proposals-kind", text: record.kind });
    parent.createEl("h3", { text: record.title });
    parent.createDiv({ cls: "mva-proposals-rationale", text: record.rationale });

    const meta = parent.createDiv({ cls: "mva-proposals-meta" });
    meta.createDiv({ text: `From: ${this.options.sourceTitle(record.source.convoId)}` });
    meta.createDiv({ text: `Target: ${proposalTargetLabel(record.payload)}` });

    for (const detail of proposalPayloadDetails(record.payload)) {
      const row = parent.createDiv({ cls: "mva-proposals-field" });
      row.createDiv({ cls: "mva-proposals-field-label", text: detail.label });
      row.createDiv({ cls: "mva-proposals-field-value", text: detail.value });
    }

    const routeError = this.sessionErrors.get(record.id) ?? this.options.lastRouteError(record.id);
    if (routeError) {
      const warning = parent.createDiv({ cls: "mva-proposals-warning" });
      setIcon(warning.createSpan(), "alert-circle");
      warning.createSpan({ text: routeError });
    }

    const actions = parent.createDiv({ cls: "mva-proposals-actions" });
    const accept = actions.createEl("button", {
      cls: "mva-btn mva-btn-primary",
      text: routeError ? "Retry" : "Accept",
      attr: { type: "button" },
    });
    const dismiss = actions.createEl("button", {
      cls: "mva-btn",
      text: "Dismiss",
      attr: { type: "button" },
    });
    const busy = this.busyId === record.id;
    accept.disabled = busy;
    dismiss.disabled = busy;
    accept.onclick = () => void this.accept(record.id);
    dismiss.onclick = () => void this.dismiss(record.id);
  }

  private async accept(id: string): Promise<void> {
    if (this.busyId) return;
    this.busyId = id;
    this.render();
    try {
      const result = await this.options.accept(id);
      if (!result.ok) this.sessionErrors.set(id, result.error);
      else this.sessionErrors.delete(id);
    } catch (error) {
      this.sessionErrors.set(id, error instanceof Error ? error.message : "Suggestion could not be accepted.");
    } finally {
      this.busyId = null;
      await this.reload();
    }
  }

  private async dismiss(id: string): Promise<void> {
    if (this.busyId) return;
    this.busyId = id;
    this.render();
    try {
      await this.options.dismiss(id);
      this.sessionErrors.delete(id);
    } catch (error) {
      this.sessionErrors.set(id, error instanceof Error ? error.message : "Suggestion could not be dismissed.");
    } finally {
      this.busyId = null;
      await this.reload();
    }
  }
}

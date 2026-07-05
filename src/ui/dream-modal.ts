import { App, Modal } from "obsidian";
import type { DreamPlan } from "../obsidian/dream";
import type { DreamLlmResult } from "../obsidian/dream-llm";
import type { Proposal } from "../core/dream-proposals";

const base = (p: string) => p.split("/").pop()?.replace(/\.md$/, "") ?? p;

/** One-line human description of a proposal (kind + the ids it touches). */
function describe(p: Proposal): string {
  switch (p.kind) {
    case "merge":
      return `merge ${p.keepId} ← ${p.dropIds.join(", ")}`;
    case "supersede":
      return `supersede ${p.supersedesId}`;
    case "rule_draft":
      return `rule draft "${p.slug}"`;
    case "import":
      return `import claude-mem:${p.claudememId}`;
  }
}

/** Preview of a memory dream pass. Mutates nothing until the user clicks Apply. */
export class DreamModal extends Modal {
  constructor(
    app: App,
    private plan: DreamPlan,
    private llm: DreamLlmResult | null,
    private onApply: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mva-ie-modal");
    this.titleEl.setText("Memory dream pass");
    const { contentEl } = this;
    const p = this.plan;
    const detTotal = p.dedup.length + p.promote.length + p.stale.length;
    const kept = this.llm?.kept ?? [];
    const culled = this.llm?.culled ?? [];
    const hasLlmSurface = kept.length > 0 || culled.length > 0 || !!this.llm?.defrag || !!this.llm?.error;
    const applicable = detTotal + kept.length;

    if (detTotal === 0 && !hasLlmSurface) {
      contentEl.createEl("p", { text: `Scanned ${p.scanned} learnings — nothing to consolidate right now.` });
      const acts = contentEl.createDiv({ cls: "mva-ie-actions" });
      acts.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Close" }).onclick = () => this.close();
      return;
    }

    contentEl.createEl("p", {
      text: `Scanned ${p.scanned} learnings. Proposed changes (every change is snapshotted and undoable):`,
    });

    const section = (label: string, n: number, lines: string[]) => {
      if (!n) return;
      contentEl.createDiv({ cls: "mva-src-label", text: `${label} (${n})` });
      const ul = contentEl.createEl("ul");
      for (const t of lines) ul.createEl("li", { text: t });
    };

    // Deterministic (no-LLM) sections.
    section("Promote to rule", p.promote.length, p.promote.map((x) => `${base(x.from)} — evidence ${x.evidence}`));
    section("Merge duplicates", p.dedup.length, p.dedup.map((x) => `${base(x.keep)} + ${x.drop.length} duplicate(s) — evidence ${x.evidence}`));
    section("Mark stale", p.stale.length, p.stale.map((x) => `${base(x.path)} — last updated ${x.lastUpdated}`));

    // Dream Pass v2 — LLM proposal sections (distinct, with per-proposal reasons).
    if (this.llm?.defrag) {
      contentEl.createDiv({
        cls: "mva-src-label",
        text: "Defrag — memory over file budget; LLM asked to propose consolidation merges",
      });
    }
    if (this.llm?.error) {
      contentEl.createEl("p", {
        text: `LLM batch rejected (${this.llm.error}) — no LLM proposals applied (raw output logged to console).`,
      });
    }
    section("LLM proposals", kept.length, kept.map((x) => `${describe(x)} — ${x.reason}`));
    section("Culled (never applied)", culled.length, culled.map((c) => `${describe(c.proposal)} — culled: ${c.reason}`));

    const acts = contentEl.createDiv({ cls: "mva-ie-actions" });
    acts.createEl("button", { cls: "mva-btn", text: "Cancel" }).onclick = () => this.close();
    if (applicable > 0) {
      acts.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Apply" }).onclick = () => {
        void this.onApply();
        this.close();
      };
    } else {
      acts.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Close" }).onclick = () => this.close();
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

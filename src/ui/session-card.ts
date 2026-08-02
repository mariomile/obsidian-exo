import type { MVASettings } from "../settings";
import { capsSummary, type CapsLike } from "../core/actions-hub";

interface SessionCardCtx {
  provider: string;
  model: string;
  /** Live capability snapshot from the session's system/init, when present. */
  caps?: CapsLike | null;
  /** Open the Capabilities hub (the card is a glance; managing happens there). */
  onOpenHub: () => void;
}

/**
 * The slim in-chat session card — what replaced the full Capabilities overlay
 * (0.30). A glance at the live session: provider/model/effort/permission
 * chips, the session's loaded counts, and one button to the hub. Deliberately
 * no disk scans here — that's the hub's job; with no session yet the counts
 * collapse to a quiet fallback line.
 */
export function renderSessionCard(container: HTMLElement, s: MVASettings, ctx: SessionCardCtx): void {
  container.empty();
  container.createDiv({ cls: "mva-gallery-title", text: "Session" });
  const card = container.createDiv({ cls: "mva-caps-card mva-session-card" });
  const body = card.createDiv({ cls: "mva-caps-body" });

  const chip = (label: string, active = true): HTMLElement => {
    const el = body.createSpan({ cls: `mva-caps-chip ${active ? "is-on" : "is-off"}` });
    el.createSpan({ cls: "mva-caps-dot" });
    el.createSpan({ cls: "mva-caps-label", text: label });
    return el;
  };

  chip(`Provider: ${ctx.provider}`);
  chip(`Model: ${ctx.model || "default"}`);
  chip(`Effort: ${s.effort}`);
  chip(`Permissions: ${s.permissionMode}`);
  chip("Agentic tools", s.toolsEnabled);

  const counts = capsSummary(ctx.caps);
  const stats = card.createDiv({ cls: "mva-caps-body mva-session-counts" });
  if (!counts.length) {
    stats.createDiv({ cls: "mva-faint", text: "No session yet — counts appear after the first message." });
  } else {
    for (const c of counts) {
      const el = stats.createSpan({ cls: "mva-caps-chip is-on" });
      el.createSpan({ cls: "mva-caps-label", text: `${c.label}: ${c.value}` });
    }
  }

  const foot = card.createDiv({ cls: "mva-session-foot" });
  const open = foot.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Open Capabilities" });
  open.onclick = () => ctx.onOpenHub();
}

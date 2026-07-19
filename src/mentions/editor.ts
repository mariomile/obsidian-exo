/**
 * In-document Connections surface (CM6). Two decorations, both gated live behind
 * settings so the extension is inert when off (no reload needed):
 *   • inline underline on every OUTGOING unlinked mention (a title this note
 *     cites in plain text) — click → {@link openMentionPopover};
 *   • a bottom-of-note block listing those suggested links with one-click
 *     "Link"/"Link all".
 *
 * The mention set is recomputed async (debounced) off the live editor buffer and
 * pushed into a StateField; between recomputes, offsets are remapped through
 * edits so underlines never drift. DOM/CM6 shell — the matching, flattening and
 * mutation logic it renders is pure and unit-tested in `mentions-core`.
 */

import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { MarkdownView, TFile } from "obsidian";
import type ExoPlugin from "../main";
import { gatherOutgoing } from "./connections";
import { loadIgnoreStore } from "./ignore-store";
import { applyRangesToView, openMentionPopover } from "./popover";
import type { FlatOutgoing, MentionRange } from "./mentions-core";

interface OutgoingState {
  path: string;
  flats: FlatOutgoing[];
}

const setOutgoing = StateEffect.define<OutgoingState>();
/** Dispatched after an action that changes the mention set without editing the
 *  doc (e.g. Ignore) — asks the view plugin to recompute. */
const forceRecompute = StateEffect.define<null>();

const outgoingField = StateField.define<OutgoingState>({
  create: () => ({ path: "", flats: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setOutgoing)) return e.value;
    if (tr.docChanged) {
      const flats = value.flats
        .map((f) => ({
          ...f,
          range: { start: tr.changes.mapPos(f.range.start), end: tr.changes.mapPos(f.range.end) },
        }))
        .filter((f) => f.range.end > f.range.start);
      return { path: value.path, flats };
    }
    return value;
  },
});

function fileForView(plugin: ExoPlugin, view: EditorView): TFile | null {
  for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
    const v = leaf.view;
    if (v instanceof MarkdownView && (v.editor as unknown as { cm?: EditorView })?.cm === view) {
      return v.file;
    }
  }
  return null;
}

/** Distinct targets in the flat set, each with all its ranges — for the block. */
function groupByTarget(flats: FlatOutgoing[]): { basename: string; ranges: MentionRange[] }[] {
  const map = new Map<string, { basename: string; ranges: MentionRange[] }>();
  for (const f of flats) {
    const g = map.get(f.targetBasename) ?? { basename: f.targetBasename, ranges: [] };
    g.ranges.push(f.range);
    map.set(f.targetBasename, g);
  }
  return [...map.values()];
}

class ConnectionsBlock extends WidgetType {
  constructor(
    private readonly view: EditorView,
    private readonly flats: FlatOutgoing[],
  ) {
    super();
  }

  eq(other: ConnectionsBlock): boolean {
    return this.flats.length === other.flats.length &&
      this.flats.every((f, i) => f.targetPath === other.flats[i]?.targetPath && f.range.start === other.flats[i]?.range.start);
  }

  toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "exo-connections-block";
    const groups = groupByTarget(this.flats);
    root.createDiv({ cls: "exo-connections-head", text: `Connections · ${groups.length} suggested link${groups.length === 1 ? "" : "s"}` });
    if (groups.length === 0) {
      root.createDiv({ cls: "exo-connections-empty", text: "No unlinked mentions in this note." });
      return root;
    }
    for (const g of groups) {
      const row = root.createDiv({ cls: "exo-connections-row" });
      row.createSpan({ cls: "exo-connections-name", text: g.basename });
      row.createSpan({ cls: "exo-connections-count", text: `${g.ranges.length}×` });
      const link = row.createEl("button", { cls: "exo-mention-btn", text: g.ranges.length > 1 ? "Link all" : "Link" });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        applyRangesToView(this.view, g.basename, g.ranges);
      });
    }
    return root;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export function mentionsExtension(plugin: ExoPlugin) {
  const plug = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private timer: number | null = null;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
        this.schedule(view);
      }

      update(u: ViewUpdate): void {
        const gotData = u.transactions.some((t) => t.effects.some((e) => e.is(setOutgoing)));
        const gotForce = u.transactions.some((t) => t.effects.some((e) => e.is(forceRecompute)));
        if (gotData || u.docChanged) this.decorations = this.build(u.view);
        if (u.docChanged || gotForce) this.schedule(u.view);
      }

      private enabled(): boolean {
        const s = plugin.settings;
        return !!s.connectionsInlineUnderline || !!s.connectionsBlockEnabled;
      }

      private build(view: EditorView): DecorationSet {
        const s = plugin.settings;
        const data = view.state.field(outgoingField, false) ?? { path: "", flats: [] };
        const builder = new RangeSetBuilder<Decoration>();
        if (s.connectionsInlineUnderline) {
          const sorted = [...data.flats].sort((a, b) => a.range.start - b.range.start);
          for (const f of sorted) {
            builder.add(
              f.range.start,
              f.range.end,
              Decoration.mark({
                class: "exo-mention-underline",
                attributes: { "data-target": f.targetBasename },
              }),
            );
          }
        }
        if (s.connectionsBlockEnabled) {
          const end = view.state.doc.length;
          builder.add(end, end, Decoration.widget({ widget: new ConnectionsBlock(view, data.flats), side: 1, block: true }));
        }
        return builder.finish();
      }

      private schedule(view: EditorView): void {
        if (!this.enabled()) {
          if (this.decorations.size) this.decorations = Decoration.none;
          return;
        }
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.run(view), 600);
      }

      private async run(view: EditorView): Promise<void> {
        const file = fileForView(plugin, view);
        if (!file) return;
        const ignore = await loadIgnoreStore(plugin.app);
        const flats = await gatherOutgoing(plugin.app, file, ignore, {
          stem: !!plugin.settings.connectionsStemming,
          text: view.state.doc.toString(),
        });
        view.dispatch({ effects: setOutgoing.of({ path: file.path, flats }) });
      }

      destroy(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e: MouseEvent, view: EditorView) {
          if (!plugin.settings.connectionsInlineUnderline) return false;
          const el = (e.target as HTMLElement | null)?.closest?.(".exo-mention-underline") as HTMLElement | null;
          if (!el) return false;
          const targetBasename = el.getAttribute("data-target");
          if (!targetBasename) return false;
          const data = view.state.field(outgoingField, false);
          const file = fileForView(plugin, view);
          if (!data || !file) return false;
          const ranges = data.flats.filter((f) => f.targetBasename === targetBasename).map((f) => f.range);
          const pos = view.posAtDOM(el);
          const range = ranges.find((r) => r.start <= pos + 1 && r.end >= pos) ?? ranges[0];
          if (!range) return false;
          openMentionPopover({
            app: plugin.app,
            view,
            sourcePath: file.path,
            targetBasename,
            range,
            allRanges: ranges,
            anchor: { x: e.clientX, y: e.clientY + 12 },
            onChange: () => view.dispatch({ effects: forceRecompute.of(null) }),
          });
          return false;
        },
      },
    },
  );
  return [outgoingField, plug];
}

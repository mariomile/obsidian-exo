/**
 * In-memory diagnostics ring buffer — the observability layer for the turn
 * lifecycle. Both 2026-07-09 bugs (silent freeze, wrong-thread continuation)
 * had to be diagnosed by forensics on conversations.json because the plugin
 * logged nothing on the critical path; this buffer makes the next bug readable
 * in seconds via the "Copy diagnostics" command.
 *
 * Privacy by design: callers log NAMES, KINDS, COUNTS and ids — never vault
 * content or message text. As defense in depth, every message is truncated to
 * {@link MAX_MSG} chars, so even a mistaken caller can't bloat the buffer or
 * leak a document into a pasted diagnostics report.
 *
 * Pure module (no Obsidian imports); the clock is injectable for tests.
 */

const MAX_MSG = 200;

export interface DiagEntry {
  at: number;
  cat: string;
  msg: string;
}

export class DiagLog {
  private entries: DiagEntry[] = [];

  constructor(
    private readonly capacity = 250,
    private readonly now: () => number = Date.now
  ) {}

  /** Append an entry (oldest evicted beyond capacity). `msg` is truncated. */
  push(cat: string, msg: string): void {
    const text = msg.length > MAX_MSG ? msg.slice(0, MAX_MSG) + "…" : msg;
    this.entries.push({ at: this.now(), cat, msg: text });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  get size(): number {
    return this.entries.length;
  }

  /** Render the buffer as a paste-ready report: header key/values, then one
   *  `HH:MM:SS.mmm [cat] msg` line per entry (UTC), oldest first. */
  dump(header: Record<string, string> = {}): string {
    const head = Object.entries(header).map(([k, v]) => `${k}: ${v}`);
    const lines = this.entries.map((e) => {
      const t = new Date(e.at).toISOString().slice(11, 23); // HH:MM:SS.mmm (UTC)
      return `${t} [${e.cat}] ${e.msg}`;
    });
    return ["## Exo diagnostics", ...head, "", ...lines].join("\n");
  }
}

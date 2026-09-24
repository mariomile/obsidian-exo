// Plugin code calls `window.setTimeout` & co. (Obsidian's popout-window
// guideline). In the renderer `window` always exists; under Vitest's node
// environment it doesn't, so alias it to the global scope. Fake timers patch
// globalThis, so they keep working through the alias.
const g = globalThis as { window?: unknown };
if (typeof g.window === "undefined") g.window = globalThis;

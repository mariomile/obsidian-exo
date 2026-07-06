/** Match one Exo permission rule against a tool invocation. */
export function matchPermRule(rules: string, tool: string, argText: string): boolean {
  for (const raw of rules.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([\w-]+(?:__[\w-]+)*)(?:\((.*?)\))?$/);
    if (!m || m[1] !== tool) continue;
    const rawArg = m[2] ?? "";
    const wildcard = rawArg.endsWith("*");
    const prefix = wildcard ? rawArg.replace(/\*+$/, "") : rawArg;
    if (!prefix) return true;
    if (tool === "Bash") {
      if (argText === prefix || argText.startsWith(prefix + " ")) return true;
    } else if (wildcard ? argText.startsWith(prefix) : argText === prefix) {
      return true;
    }
  }
  return false;
}

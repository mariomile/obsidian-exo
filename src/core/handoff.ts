/**
 * Cross-plugin handoff hints. When a sibling plugin hands a query to Exo with a
 * declared source (e.g. Sonar's `?` intent mode), the query alone often reads
 * like a chat question — "toggle the sidebar" would get an explanation, not an
 * execution. The source maps to a hidden directive prepended to the outbound
 * provider message (never rendered in the chat bubble) that steers the turn
 * toward the right tool surface.
 */
export function handoffPrefix(source: string | undefined): string | undefined {
  if (source === "sonar-intent") {
    return (
      "Handoff from Sonar's '?' intent mode: the text below is an app-level intent, not a chat question. " +
      "If it maps to an app command, find it with list_sonar_actions and execute it with run_sonar_action; " +
      "confirm with Mario first only when the action is flagged '⚠ destructive'. " +
      "Answer in chat only when no command fits the intent."
    );
  }
  return undefined;
}

/**
 * Turn-failure cards, extracted from view.ts as free functions so the (large)
 * view stays under its size ceiling:
 *   - renderErrorBody: the dispatcher — auth card, setup card, or a compact
 *     inline error row with Retry.
 *   - renderAuthCard: re-login for an expired/missing Claude session (one-click
 *     `claude auth login`, then auto-retry the failed turn).
 *   - renderSetupCard: the "CLI isn't ready" first-run card.
 */
import { setIcon } from "obsidian";
import { resolveCli, authLogin, describeError } from "../cli";
import { describeCliFailure, isAuthExpired, isAuthFailure } from "../core/errors";

export interface ErrorBodyDeps {
  body: HTMLElement;
  message: string;
  provider: string;
  /** Provider display name for the setup card title. */
  displayName: string;
  claudeBin: string;
  /** Original user text to resend on Retry / after re-login ("" = no retry affordance). */
  retryText: string;
  isStreaming: () => boolean;
  retry: (text: string) => void;
  diag: (area: string, msg: string) => void;
  openSettings: () => void;
}

/** Inline error, upgraded to an auth or setup card when the CLI needs attention.
 *  Single dispatcher for both the live and rehydrated-persisted error paths. */
export function renderErrorBody(deps: ErrorBodyDeps): void {
  const { body, message, provider, retryText } = deps;
  let actionHost: HTMLElement;
  // Auth failure (expired token or missing credentials) — retrying is useless
  // until the user re-authenticates, so render a dedicated re-login card.
  if (provider === "claude" && isAuthFailure(message)) {
    renderAuthCard({
      body,
      message,
      claudeBin: deps.claudeBin,
      retryText,
      isStreaming: deps.isStreaming,
      retry: deps.retry,
      diag: deps.diag,
    });
    return;
  }
  if (/not found|not logged in|sign in|run it once/i.test(message)) {
    actionHost = renderSetupCard({
      body,
      displayName: deps.displayName,
      provider,
      message,
      onOpenSettings: deps.openSettings,
    });
  } else {
    // Keep failures visible without turning them into a dominant red card. The
    // compact row carries the human-readable state + retry; raw diagnostics stay
    // available behind a disclosure for the rare case they are needed.
    const friendly = describeCliFailure(message);
    const box = body.createDiv({ cls: "mva-inline-error" });
    const row = box.createDiv({ cls: "mva-error-row" });
    setIcon(row.createSpan({ cls: "mva-error-icon" }), "triangle-alert");
    const copy = row.createDiv({ cls: "mva-error-copy" });
    copy.createDiv({ cls: "mva-error-title", text: "Response interrupted" });
    copy.createDiv({
      cls: "mva-error-summary",
      text: friendly?.message ?? (message.length > 120 ? `${message.slice(0, 120)}…` : message),
    });
    actionHost = row;

    const detailText = [friendly?.hint, message].filter(Boolean).join("\n\n");
    const details = box.createEl("details", { cls: "mva-error-details" });
    details.createEl("summary", { text: "Details" });
    details.createDiv({ text: detailText });
  }

  if (!retryText) return;
  const retry = actionHost.createEl("button", { cls: "mva-error-retry", attr: { "aria-label": "Retry response" } });
  setIcon(retry.createSpan(), "refresh-cw");
  retry.createSpan({ text: "Retry" });
  let retrying = false;
  retry.onclick = () => {
    if (retrying || deps.isStreaming()) return;
    retrying = true;
    retry.disabled = true;
    deps.retry(retryText);
  };
}

export interface AuthCardDeps {
  body: HTMLElement;
  message: string;
  /** The configured Claude binary override ("" = auto-resolve). */
  claudeBin: string;
  /** Original user text to resend once re-authenticated ("" = no retry). */
  retryText: string;
  /** True while a turn is streaming — Log in is a no-op then (never retry into a live turn). */
  isStreaming: () => boolean;
  /** Resend the failed turn (reusing the existing user bubble) after a successful login. */
  retry: (text: string) => void;
  /** Diagnostics sink (plugin.diag.push). */
  diag: (area: string, msg: string) => void;
}

/** The "CLI isn't ready" setup card (binary missing / never signed in). Returns
 *  the card element so the caller can hang a Retry button off it, matching the
 *  auth card's sibling shape. Extracted alongside renderAuthCard to keep view.ts
 *  under its size ceiling. */
export function renderSetupCard(opts: {
  body: HTMLElement;
  displayName: string;
  provider: string;
  message: string;
  onOpenSettings: () => void;
}): HTMLElement {
  const card = opts.body.createDiv({ cls: "mva-onboard" });
  setIcon(card.createDiv({ cls: "mva-onboard-icon" }), "plug-zap");
  card.createDiv({ cls: "mva-onboard-title", text: `${opts.displayName} isn't ready` });
  card.createDiv({ cls: "mva-onboard-msg", text: opts.message });
  const steps = card.createEl("ol", { cls: "mva-onboard-steps" });
  steps.createEl("li", { text: `Open a terminal and run \`${opts.provider}\` once to sign in.` });
  steps.createEl("li", { text: "If it's installed elsewhere, set the binary path in settings." });
  const btn = card.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Open settings" });
  btn.onclick = opts.onOpenSettings;
  return card;
}

export function renderAuthCard(deps: AuthCardDeps): void {
  const { body, message, claudeBin, retryText } = deps;
  const expired = isAuthExpired(message);
  const friendly = describeCliFailure(message);
  const card = body.createDiv({ cls: "mva-onboard" });
  setIcon(card.createDiv({ cls: "mva-onboard-icon" }), "log-in");
  card.createDiv({
    cls: "mva-onboard-title",
    text: expired ? "Your Claude session expired" : "Claude isn't signed in",
  });
  card.createDiv({
    cls: "mva-onboard-msg",
    text: friendly?.message ?? "Sign in to your Anthropic account to continue.",
  });

  const login = card.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Log in" });
  const status = card.createDiv({ cls: "mva-faint" });
  card.createDiv({ cls: "mva-onboard-msg mva-faint", text: "Or run `claude auth login` in a terminal, then retry." });

  let busy = false;
  login.onclick = async () => {
    if (busy || deps.isStreaming()) return;
    busy = true;
    login.disabled = true;
    login.setText("Opening browser…");
    status.setText("Complete the sign-in in your browser, then come back here.");
    try {
      const cli = await resolveCli("claude", claudeBin);
      const { ok, output } = await authLogin(cli);
      if (ok) {
        status.setText("Signed in — retrying…");
        deps.diag("cli", "auth login ok, retrying turn");
        if (retryText) deps.retry(retryText);
        return;
      }
      const tail = output.split("\n").filter(Boolean).slice(-3).join("\n");
      status.setText(`Sign-in didn't complete. ${tail || "Try the terminal command below."}`);
    } catch (e) {
      status.setText(describeError(e, "Claude"));
    } finally {
      busy = false;
      login.disabled = false;
      login.setText("Log in");
    }
  };
}

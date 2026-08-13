# Exo Collabo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let humans (with or without Obsidian) and the Exo agent collaborate on the same document in real time, with a review-before-commit model, by forking `EveryInc/proof-sdk` as a standalone service and talking to it from Exo over HTTP.

**Architecture:** Two deployables. **Exo Collabo** is a fork of proof-sdk deployed on Railway (Express + embedded Hocuspocus collab runtime + SQLite on a volume) and serves both the agent HTTP bridge and its own Milkdown web client. **Exo** gets a pure HTTP client (`core/collab-bridge.ts`), two commands (share / import), and four agent tools. Exo never embeds a Yjs or WebSocket client: realtime editing happens in Exo Collabo's browser client, and Obsidian only ever sees accepted snapshots on explicit share and import.

**Tech Stack:** TypeScript, esbuild, vitest, Obsidian API (`requestUrl` for HTTP), Claude Agent SDK (`tool` / `SdkMcpToolDefinition`), zod. Service side: Node 18+, Express 5, better-sqlite3, Railway.

## Global Constraints

- **Size ratchet (`tests/size-contract.test.ts`) is law.** `src/main.ts` (ceiling 3474) and `src/settings.ts` (ceiling 1032) are both at exactly their ceiling: zero headroom. Never raise a ceiling. Task 2 frees budget by extraction and lowers both ceilings; every later task stays inside that budget.
- **`src/view.ts` is not touched by this plan.** It has 2 lines of headroom (6588/6590). The Collabo bridge is stateless, so tools are built in `src/obsidian/tools.ts` (not size-capped), not curried per conversation in `view.ts`.
- **`src/core/` modules stay Obsidian-free.** `collab-bridge.ts` takes an injected HTTP function; the Obsidian `requestUrl` adapter lives in `src/obsidian/`.
- **HTTP goes through Obsidian's `requestUrl`, never `fetch`.** Desktop CSP/proxy safety, already the convention (`src/main.ts:884`).
- **The agent proposes, it never commits.** Agent tools may call `comment.add` and `suggestion.add` only. `suggestion.accept`, `suggestion.reject` and `rewrite.apply` are not exposed to the agent in v1.
- **No em-dashes in commit messages or docs written in this plan.**
- Package manager is `pnpm@10.17.1`. Verification commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.

---

### Task 1: Exo Collabo service (fork + Railway deploy)

Fork proof-sdk into its own repo and get it serving on a public URL with API-key-gated document creation. This task produces no Exo plugin code: its deliverable is a reachable base URL plus an API key, which every later task consumes.

**Files:**
- Create (in the new `exo-collabo` repo, outside `obsidian-exo`): `railway.json`, `.env.example` additions
- Modify: `server/index.ts` startup log only if it misleads; no functional server changes expected

**Interfaces:**
- Consumes: nothing
- Produces: a base URL (e.g. `https://exo-collabo.up.railway.app`) and an API key string. Later tasks store these in Exo settings as `collaboUrl` and `collaboApiKey`. The service exposes, verbatim from `AGENT_CONTRACT.md`: `POST /documents`, `GET /documents/:slug/state`, `POST /documents/:slug/ops`, `GET /documents/:slug/events/pending?after=<n>&limit=<n>`, `POST /documents/:slug/events/ack`.

- [ ] **Step 1: Fork and clone**

```bash
gh repo fork EveryInc/proof-sdk --fork-name exo-collabo --clone=false --org "" 
git clone git@github.com:mariomile/exo-collabo.git ~/"Dev Projects"/exo-collabo
cd ~/"Dev Projects"/exo-collabo && npm install
```

If `gh repo fork` refuses (fork already exists, or org flag unsupported in this `gh` version), create the repo manually: `gh repo create mariomile/exo-collabo --private --clone` then add proof-sdk as a remote and `git pull upstream main`.

- [ ] **Step 2: Verify it boots locally before touching anything**

```bash
cd ~/"Dev Projects"/exo-collabo
PROOF_DB_ENV_INIT=development npm run serve
```

Expected: `[proof-sdk] listening on http://127.0.0.1:4000`. In a second shell:

```bash
curl -s -X POST http://localhost:4000/documents \
  -H "Content-Type: application/json" \
  -d '{"markdown":"# Smoke\n\nhello","title":"Smoke"}' | head -20
```

Expected: JSON containing `"success":true`, a `slug`, an `ownerSecret`, and an `accessToken`. If this fails, stop: nothing downstream can work.

- [ ] **Step 3: Add the Railway config**

Create `railway.json`:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm ci && npm run build"
  },
  "deploy": {
    "startCommand": "npm run serve",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

`server/index.ts` already reads `PORT` (line 22) and calls `server.listen(PORT)` with no host argument, so Node binds all interfaces and Railway's proxy reaches it. The `127.0.0.1` in the startup log is cosmetic only. Do not change the listen call.

- [ ] **Step 4: Commit the config**

```bash
git add railway.json
git commit -m "deploy: Railway config for Exo Collabo"
git push origin main
```

- [ ] **Step 5: Provision on Railway with a persistent volume**

In the Railway dashboard (or `railway` CLI): create a project from the `exo-collabo` repo, add a **Volume** mounted at `/data`, and set these service variables:

| Variable | Value | Why |
|---|---|---|
| `DATABASE_PATH` | `/data/exo-collabo.db` | `server/db.ts:485` reads this; without it SQLite lands in the ephemeral container filesystem and every deploy wipes every document |
| `PROOF_DB_ENV_INIT` | `production` | `server/db.ts:159` requires this once, otherwise startup refuses with an environment-mismatch error |
| `PROOF_SHARE_MARKDOWN_AUTH_MODE` | `api_key` | Without it `POST /documents` is open to the whole internet |
| `PROOF_SHARE_MARKDOWN_API_KEY` | a generated secret | The key Exo will send as `Authorization: Bearer <key>` on create |
| `PROOF_CORS_ALLOW_ORIGINS` | the Railway public domain | `server/index.ts:32` reads it; the web client is served from the same origin, so this is the deployed domain only |

Generate the API key with `openssl rand -hex 32` and keep it: Task 4 stores it in Exo settings.

- [ ] **Step 6: Verify the deployed service end to end**

```bash
BASE=https://<your-service>.up.railway.app
KEY=<the api key>

# Unauthenticated create must be refused now that auth mode is api_key
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/documents" \
  -H "Content-Type: application/json" -d '{"markdown":"# nope"}'

# Authenticated create must succeed
curl -s -X POST "$BASE/documents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"markdown":"# Deploy check\n\nit lives","title":"Deploy check","role":"commenter"}'
```

Expected: the first call prints `401` (or `403`). The second returns `"success":true` with `slug`, `shareUrl`, `ownerSecret`, `accessToken`, `accessRole":"commenter"`. Open the returned `tokenUrl` in a browser and confirm the Milkdown editor renders the document. Record the base URL and key: Task 4 needs both.

- [ ] **Step 6b: Establish how the owner opens the document**

The recipient link carries the scoped `accessToken` and therefore the recipient's role. The owner needs a different link, or nobody can ever accept a suggestion. `server/routes.ts` accepts `?token=` as a share secret through the same resolver that handles the owner secret, so this should work:

```bash
open "$BASE/d/<slug>?token=<ownerSecret>"
```

Confirm in the browser that this session can **accept and reject suggestions** while the `accessToken` link (opened in a private window) can only propose them. Write down which URL form grants owner rights: Task 5 builds its "open as owner" command on this answer. If the owner secret turns out not to work as a query token on your deployment, find the form that does before continuing, because Task 5 depends on it.

- [ ] **Step 7: Verify the volume actually persists**

Trigger a redeploy in Railway, then:

```bash
curl -s "$BASE/documents/<slug-from-step-6>/state" -H "Authorization: Bearer <accessToken>" | head -5
```

Expected: the document still exists after the redeploy. If it 404s, `DATABASE_PATH` is not pointing at the mounted volume: fix before continuing, because every later task assumes documents survive.

---

### Task 2: Free the line budget (extractions)

`main.ts` and `settings.ts` are both sitting exactly on their ceilings, so no later task can add a single line to either. This task adds no feature: it extracts two self-contained clusters into their own files and lowers both ceilings, creating the budget Tasks 4 and 5 spend.

**Files:**
- Create: `src/ui/pickers.ts`
- Create: `src/ui/settings-cli.ts`
- Modify: `src/main.ts` (remove `AgentPicker` and `PlaybookPicker` class bodies at 3383-3421, add one import)
- Modify: `src/settings.ts` (remove `renderCliDiagnostics` and `maybeRenderCliUpdate` methods at 987-1032, add one import, update two call sites)
- Modify: `tests/size-contract.test.ts` (lower both ceilings)

**Interfaces:**
- Consumes: nothing
- Produces: `AgentPicker` and `PlaybookPicker` importable from `../ui/pickers`; `renderCliDiagnostics(plugin, containerEl, name, configured)` and `maybeRenderCliUpdate(plugin, containerEl, currentVersion)` importable from `./ui/settings-cli`. Roughly 39 free lines in `main.ts` and 46 in `settings.ts`.

- [ ] **Step 1: Record the starting line counts**

```bash
cd ~/"Dev Projects"/obsidian-exo
wc -l src/main.ts src/settings.ts
```

Expected: `3474 src/main.ts`, `1032 src/settings.ts`. Write both numbers down: Step 7 compares against them.

- [ ] **Step 2: Create `src/ui/pickers.ts`**

Move both classes verbatim out of `main.ts`, exported:

```ts
/**
 * Fuzzy pickers used by the command palette entries in main.ts. They live here
 * rather than in main.ts because they are self-contained modals with no plugin
 * state: main.ts is at its size ceiling and every new command needs the budget.
 */
import { App, FuzzySuggestModal } from "obsidian";
import type { AgentDef } from "../core/agents";
import { writeModeFor } from "../core/agents";

export class AgentPicker extends FuzzySuggestModal<AgentDef> {
  constructor(
    app: App,
    private agents: AgentDef[],
    private onPick: (a: AgentDef) => void
  ) {
    super(app);
    this.setPlaceholder("Run an agent now…");
  }
  getItems(): AgentDef[] {
    return this.agents;
  }
  getItemText(a: AgentDef): string {
    const tier = writeModeFor(a.contract.autonomy) ? "writes" : "read-only";
    return `${a.brain.name} — ${tier}${a.contract.enabled ? "" : " · disabled"}`;
  }
  onChooseItem(a: AgentDef): void {
    this.onPick(a);
  }
}

export class PlaybookPicker extends FuzzySuggestModal<{ name: string; prompt: string }> {
  constructor(
    app: App,
    private prompts: { name: string; prompt: string }[],
    private onPick: (p: { name: string; prompt: string }) => void,
    reportsDir: string
  ) {
    super(app);
    this.setPlaceholder(`Run a playbook (read-only, report to ${reportsDir}/)…`);
  }
  getItems(): { name: string; prompt: string }[] {
    return this.prompts;
  }
  getItemText(p: { name: string; prompt: string }): string {
    return p.name;
  }
  onChooseItem(p: { name: string; prompt: string }): void {
    this.onPick(p);
  }
}
```

Verify where `writeModeFor` is imported from in `main.ts` before writing this file (`grep -n "writeModeFor" src/main.ts`) and match that import path. If `main.ts` no longer uses `writeModeFor` or `FuzzySuggestModal` after the removal, drop them from its import list too.

- [ ] **Step 3: Delete the two classes from `main.ts` and import them instead**

Remove lines 3383-3421 (the two class bodies). Add to the import block at the top:

```ts
import { AgentPicker, PlaybookPicker } from "./ui/pickers";
```

- [ ] **Step 4: Create `src/ui/settings-cli.ts`**

Both methods only reach `this.plugin`, so they become free functions taking the plugin:

```ts
/**
 * CLI diagnostics + one-click update row for the settings pane. Extracted from
 * settings.ts, which sits at its size ceiling: these two helpers only ever
 * touched `this.plugin`, so they lose nothing by becoming free functions.
 */
import { Notice, Setting } from "obsidian";
import type ExoPlugin from "../main";
import { cliDiagnostics, updateClaudeCli } from "../cli";
import { compareSemver } from "../core/semver";

/** When the resolved Claude CLI is older than the latest known published
 *  version, offer a one-click `npm i -g …@latest` update (never auto-run). */
export function maybeRenderCliUpdate(
  plugin: ExoPlugin,
  containerEl: HTMLElement,
  currentVersion: string,
): void {
  const latest = plugin.settings.cliLatestKnown;
  if (!latest || compareSemver(currentVersion, latest) >= 0) return; // unknown or up to date
  const row = new Setting(containerEl)
    .setName(`Update available: ${latest}`)
    .setDesc("A newer Claude CLI has been published. Updating installs it into your global npm prefix.");
  row.addButton((b) =>
    b
      .setButtonText("Update")
      .setCta()
      .onClick(async () => {
        b.setButtonText("Updating…").setDisabled(true);
        new Notice("Updating Claude CLI…");
        const { ok, output } = await updateClaudeCli();
        if (ok) {
          new Notice(`Updated to ${latest} — restart sessions to pick it up.`);
          b.buttonEl.remove();
        } else {
          const tail = output.split("\n").filter(Boolean).slice(-4).join("\n");
          new Notice(`Claude CLI update failed:\n${tail || "unknown error"}`);
          b.setButtonText("Update").setDisabled(false);
        }
      })
  );
}

/** Resolve the configured CLI and print what it actually is, plus its version
 *  (async, never blocks render). Turns future binary-drift debugging into a
 *  5-second glance. */
export function renderCliDiagnostics(
  plugin: ExoPlugin,
  containerEl: HTMLElement,
  name: string,
  configured: string,
): void {
  const el = containerEl.createDiv({ cls: "setting-item-description mva-cli-diag" });
  el.setText("Resolving…");
  // Lazily run (or reuse) the daily update check for Claude, so the button
  // below can appear once both the resolved version and the latest are known.
  if (name === "claude") void plugin.maybeCheckCliUpdate();
  void cliDiagnostics(name, configured)
    .then((d) => {
      el.setText(
        d.found
          ? `Resolved: ${d.bin}${d.version ? ` — ${d.version}` : ""}`
          : "Not found — set the path explicitly"
      );
      if (name === "claude" && d.found && d.version) maybeRenderCliUpdate(plugin, containerEl, d.version);
    })
    .catch(() => el.setText("Not found — set the path explicitly"));
}
```

- [ ] **Step 5: Delete both methods from `settings.ts` and rewire the call sites**

Remove lines 987-1032 (both private methods, keeping the closing `}` of the class). Add the import:

```ts
import { renderCliDiagnostics } from "./ui/settings-cli";
```

Then find every `this.renderCliDiagnostics(` call site (`grep -n "renderCliDiagnostics" src/settings.ts`) and rewrite each as `renderCliDiagnostics(this.plugin, ...)` with the same remaining arguments. Drop `cliDiagnostics`, `updateClaudeCli` and `compareSemver` from `settings.ts` imports if nothing else there uses them (`grep -n "cliDiagnostics\|updateClaudeCli\|compareSemver" src/settings.ts`).

- [ ] **Step 6: Lower both ceilings**

```bash
wc -l src/main.ts src/settings.ts
```

Edit `tests/size-contract.test.ts`. Set `"src/main.ts"` and `"src/settings.ts"` to the new actual counts **plus 15 lines of declared budget each**, and add a comment above each in the file's existing style saying what was extracted and that the 15 lines are the declared budget for the Exo Collabo wiring in Tasks 4 and 5, not permission to regrow.

- [ ] **Step 7: Verify nothing broke**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: typecheck clean, lint clean, all tests pass including `size-contract`. Then confirm the extraction actually paid off:

```bash
wc -l src/main.ts src/settings.ts
```

Expected: `main.ts` around 3436 and `settings.ts` around 987, both comfortably under their new ceilings.

- [ ] **Step 8: Commit**

```bash
git add src/ui/pickers.ts src/ui/settings-cli.ts src/main.ts src/settings.ts tests/size-contract.test.ts
git commit -m "refactor(size): pickers and CLI diagnostics leave their host files

main.ts and settings.ts both sat exactly on their ceilings, so no feature
could add a line to either. Both extracted clusters were self-contained:
the pickers hold no plugin state, the CLI helpers only reached this.plugin.
Ceilings lowered accordingly."
```

---

### Task 3: `core/collab-bridge.ts`, the pure HTTP client

The whole Exo Collabo protocol as pure functions over an injected HTTP callable. No Obsidian import, no network in tests.

**Files:**
- Create: `src/core/collab-bridge.ts`
- Test: `tests/collab-bridge.test.ts`

**Interfaces:**
- Consumes: the route contract verified in Task 1
- Produces, all exported from `src/core/collab-bridge.ts`:
  - types `ShareRole`, `CollaboConfig`, `HttpRequest`, `HttpResponse`, `HttpFn`, `CreatedDocument`, `DocumentState`, `CollaboEvent`, `CollaboOp`, `ShareRef`
  - class `CollaboError`
  - functions `createDocument`, `fetchState`, `postOp`, `pendingEvents`, `ackEvents`, `parseShareRef`

- [ ] **Step 1: Write the failing tests**

Create `tests/collab-bridge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  createDocument,
  fetchState,
  postOp,
  pendingEvents,
  ackEvents,
  parseShareRef,
  CollaboError,
  type CollaboConfig,
  type HttpFn,
  type HttpRequest,
} from "../src/core/collab-bridge";

const cfg: CollaboConfig = { baseUrl: "https://collabo.test", apiKey: "k-123" };

/** Records every request and replies with a canned response. */
function recorder(res: { status?: number; json?: unknown } = {}) {
  const seen: HttpRequest[] = [];
  const http: HttpFn = async (req) => {
    seen.push(req);
    return { status: res.status ?? 200, json: res.json ?? { success: true } };
  };
  return { http, seen };
}

describe("createDocument", () => {
  it("posts the markdown with the api key and returns the share credentials", async () => {
    const { http, seen } = recorder({
      json: {
        success: true,
        slug: "abc123xy",
        shareUrl: "https://collabo.test/d/abc123xy",
        tokenUrl: "https://collabo.test/d/abc123xy?token=tok-9",
        ownerSecret: "owner-secret",
        accessToken: "tok-9",
        accessRole: "commenter",
      },
    });

    const doc = await createDocument(http, cfg, {
      markdown: "# Plan\n\nShip it.",
      title: "Plan",
      role: "commenter",
    });

    expect(doc.slug).toBe("abc123xy");
    expect(doc.ownerSecret).toBe("owner-secret");
    expect(doc.accessToken).toBe("tok-9");
    expect(doc.accessRole).toBe("commenter");
    // tokenUrl is what a collaborator can actually open without signing in
    expect(doc.shareUrl).toBe("https://collabo.test/d/abc123xy?token=tok-9");

    expect(seen[0].url).toBe("https://collabo.test/documents");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.Authorization).toBe("Bearer k-123");
    expect(JSON.parse(seen[0].body!)).toEqual({
      markdown: "# Plan\n\nShip it.",
      title: "Plan",
      role: "commenter",
    });
  });

  it("falls back to shareUrl when the service returns no tokenUrl", async () => {
    const { http } = recorder({
      json: {
        success: true,
        slug: "s",
        shareUrl: "https://collabo.test/d/s",
        ownerSecret: "o",
        accessToken: "t",
        accessRole: "editor",
      },
    });
    const doc = await createDocument(http, cfg, { markdown: "x", title: "t", role: "editor" });
    expect(doc.shareUrl).toBe("https://collabo.test/d/s");
  });

  it("throws CollaboError carrying the status on a refusal", async () => {
    const { http } = recorder({ status: 401, json: { error: "UNAUTHORIZED" } });
    await expect(
      createDocument(http, cfg, { markdown: "x", title: "t", role: "editor" }),
    ).rejects.toBeInstanceOf(CollaboError);
  });

  it("trims a trailing slash on the base url instead of doubling it", async () => {
    const { http, seen } = recorder({
      json: { success: true, slug: "s", shareUrl: "u", ownerSecret: "o", accessToken: "t", accessRole: "viewer" },
    });
    await createDocument(http, { baseUrl: "https://collabo.test/", apiKey: "k" }, {
      markdown: "x",
      title: "t",
      role: "viewer",
    });
    expect(seen[0].url).toBe("https://collabo.test/documents");
  });
});

describe("fetchState", () => {
  it("reads markdown and updatedAt with the document token", async () => {
    const { http, seen } = recorder({
      json: { markdown: "# Live\n\nbody", updatedAt: "2026-08-12T10:00:00.000Z" },
    });
    const state = await fetchState(http, cfg, "abc123xy", "tok-9");
    expect(state.markdown).toBe("# Live\n\nbody");
    expect(state.updatedAt).toBe("2026-08-12T10:00:00.000Z");
    expect(seen[0].url).toBe("https://collabo.test/documents/abc123xy/state");
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers.Authorization).toBe("Bearer tok-9");
  });

  it("reports a missing document as a CollaboError, not an empty note", async () => {
    const { http } = recorder({ status: 404, json: { error: "NOT_FOUND" } });
    await expect(fetchState(http, cfg, "gone", "tok")).rejects.toBeInstanceOf(CollaboError);
  });
});

describe("postOp", () => {
  it("sends the op with an idempotency key so a retry cannot duplicate it", async () => {
    const { http, seen } = recorder();
    await postOp(
      http,
      cfg,
      "abc123xy",
      "tok-9",
      { type: "comment.add", by: "ai:exo", text: "This claim needs a source.", quote: "revenue tripled" },
      "idem-1",
    );
    expect(seen[0].url).toBe("https://collabo.test/documents/abc123xy/ops");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers["Idempotency-Key"]).toBe("idem-1");
    expect(JSON.parse(seen[0].body!)).toEqual({
      type: "comment.add",
      by: "ai:exo",
      text: "This claim needs a source.",
      quote: "revenue tripled",
    });
  });

  it("carries a suggestion op through unchanged", async () => {
    const { http, seen } = recorder();
    await postOp(
      http,
      cfg,
      "s",
      "tok",
      { type: "suggestion.add", by: "ai:exo", kind: "replace", quote: "old", content: "new" },
      "idem-2",
    );
    expect(JSON.parse(seen[0].body!).kind).toBe("replace");
  });
});

describe("pendingEvents / ackEvents", () => {
  it("polls after a cursor and returns the events", async () => {
    const { http, seen } = recorder({
      json: { events: [{ id: 7, type: "suggestion.accept", by: "mario", at: "2026-08-12T11:00:00.000Z" }] },
    });
    const events = await pendingEvents(http, cfg, "s", "tok", 3);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(7);
    expect(events[0].type).toBe("suggestion.accept");
    expect(seen[0].url).toBe("https://collabo.test/documents/s/events/pending?after=3&limit=50");
  });

  it("returns an empty list when the service sends no events array", async () => {
    const { http } = recorder({ json: { ok: true } });
    expect(await pendingEvents(http, cfg, "s", "tok", 0)).toEqual([]);
  });

  it("acks through the last seen id", async () => {
    const { http, seen } = recorder();
    await ackEvents(http, cfg, "s", "tok", 7);
    expect(seen[0].url).toBe("https://collabo.test/documents/s/events/ack");
    expect(JSON.parse(seen[0].body!)).toEqual({ through: 7 });
  });
});

describe("parseShareRef", () => {
  it("reads slug, token and base url out of a pasted share link", () => {
    expect(parseShareRef("https://collabo.test/d/abc123xy?token=tok-9")).toEqual({
      baseUrl: "https://collabo.test",
      slug: "abc123xy",
      token: "tok-9",
    });
  });

  it("accepts a link with no token", () => {
    expect(parseShareRef("https://collabo.test/d/abc123xy")).toEqual({
      baseUrl: "https://collabo.test",
      slug: "abc123xy",
      token: null,
    });
  });

  it("accepts a bare slug and leaves the base url to the caller", () => {
    expect(parseShareRef("abc123xy")).toEqual({ baseUrl: null, slug: "abc123xy", token: null });
  });

  it("rejects a url that is not a share link", () => {
    expect(parseShareRef("https://collabo.test/documents/abc")).toBeNull();
    expect(parseShareRef("")).toBeNull();
    expect(parseShareRef("not a slug at all")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm vitest run tests/collab-bridge.test.ts
```

Expected: FAIL, cannot resolve `../src/core/collab-bridge`.

- [ ] **Step 3: Write `src/core/collab-bridge.ts`**

```ts
/**
 * Exo Collabo protocol, as pure functions over an injected HTTP callable.
 *
 * Deliberately Obsidian-free: the plugin passes a `requestUrl` adapter, tests
 * pass a recorder. Every route here is the public SDK surface documented in the
 * service's own AGENT_CONTRACT.md, not the hosted-product compatibility aliases.
 *
 * The agent is a proposer, never a committer: `suggestion.accept`,
 * `suggestion.reject` and `rewrite.apply` are intentionally NOT in `CollaboOp`.
 * Promoting a proposal to canonical text is the owner's move, made in the web
 * client.
 */

export type ShareRole = "viewer" | "commenter" | "editor";

/** Service coordinates. `apiKey` authenticates document CREATION only; every
 *  per-document call authenticates with that document's own token instead. */
export interface CollaboConfig {
  baseUrl: string;
  apiKey: string;
}

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  json: unknown;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

/** Any non-2xx answer from the service. Carries the status so callers can tell
 *  "you lost access" (401/403/404) from "the service is unwell" (5xx). */
export class CollaboError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "CollaboError";
  }
}

export interface CreatedDocument {
  slug: string;
  /** The link to hand to a human: tokenised when the service returned one, so
   *  the recipient can open it without an account. */
  shareUrl: string;
  ownerSecret: string;
  accessToken: string;
  accessRole: ShareRole;
}

export interface DocumentState {
  markdown: string;
  updatedAt: string | null;
}

export interface CollaboEvent {
  id: number;
  type: string;
  by: string | null;
  at: string | null;
}

/** The ops the agent is allowed to send. Both are proposals. */
export type CollaboOp =
  | { type: "comment.add"; by: string; text: string; quote?: string }
  | {
      type: "suggestion.add";
      by: string;
      kind: "insert" | "delete" | "replace";
      quote: string;
      content?: string;
    };

/** A pasted share link taken apart. `baseUrl` is null for a bare slug, meaning
 *  the caller should fall back to the configured service. */
export interface ShareRef {
  baseUrl: string | null;
  slug: string;
  token: string | null;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One place where a non-2xx becomes a typed throw, so no caller has to
 *  remember to check `status` and none of them silently treats an error page as
 *  a document. */
async function send(http: HttpFn, req: HttpRequest): Promise<unknown> {
  const res = await http(req);
  if (res.status < 200 || res.status >= 300) {
    const body = isRecord(res.json) ? res.json : {};
    const code = typeof body.error === "string" ? body.error : null;
    const detail = typeof body.message === "string" ? body.message : code;
    throw new CollaboError(detail || `Request failed with ${res.status}`, res.status, code);
  }
  return res.json;
}

const authHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

export async function createDocument(
  http: HttpFn,
  cfg: CollaboConfig,
  doc: { markdown: string; title: string; role: ShareRole },
): Promise<CreatedDocument> {
  const json = await send(http, {
    url: `${trimSlash(cfg.baseUrl)}/documents`,
    method: "POST",
    headers: authHeaders(cfg.apiKey),
    body: JSON.stringify({ markdown: doc.markdown, title: doc.title, role: doc.role }),
  });
  const b = isRecord(json) ? json : {};
  const slug = str(b.slug);
  if (!slug) throw new CollaboError("The service created no document.", 502);
  return {
    slug,
    // tokenUrl is the one a recipient can actually open; shareUrl alone may
    // require an account on hosted deployments.
    shareUrl: str(b.tokenUrl) || str(b.shareUrl),
    ownerSecret: str(b.ownerSecret),
    accessToken: str(b.accessToken),
    accessRole: (str(b.accessRole) || "commenter") as ShareRole,
  };
}

export async function fetchState(
  http: HttpFn,
  cfg: CollaboConfig,
  slug: string,
  token: string,
): Promise<DocumentState> {
  const json = await send(http, {
    url: `${trimSlash(cfg.baseUrl)}/documents/${encodeURIComponent(slug)}/state`,
    method: "GET",
    headers: authHeaders(token),
  });
  const b = isRecord(json) ? json : {};
  return { markdown: str(b.markdown), updatedAt: typeof b.updatedAt === "string" ? b.updatedAt : null };
}

export async function postOp(
  http: HttpFn,
  cfg: CollaboConfig,
  slug: string,
  token: string,
  op: CollaboOp,
  idempotencyKey: string,
): Promise<void> {
  await send(http, {
    url: `${trimSlash(cfg.baseUrl)}/documents/${encodeURIComponent(slug)}/ops`,
    method: "POST",
    headers: { ...authHeaders(token), "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(op),
  });
}

export async function pendingEvents(
  http: HttpFn,
  cfg: CollaboConfig,
  slug: string,
  token: string,
  after: number,
  limit = 50,
): Promise<CollaboEvent[]> {
  const json = await send(http, {
    url: `${trimSlash(cfg.baseUrl)}/documents/${encodeURIComponent(slug)}/events/pending?after=${after}&limit=${limit}`,
    method: "GET",
    headers: authHeaders(token),
  });
  const raw = isRecord(json) && Array.isArray(json.events) ? json.events : [];
  return raw.filter(isRecord).map((e) => ({
    id: typeof e.id === "number" ? e.id : 0,
    type: str(e.type),
    by: typeof e.by === "string" ? e.by : null,
    at: typeof e.at === "string" ? e.at : null,
  }));
}

export async function ackEvents(
  http: HttpFn,
  cfg: CollaboConfig,
  slug: string,
  token: string,
  through: number,
): Promise<void> {
  await send(http, {
    url: `${trimSlash(cfg.baseUrl)}/documents/${encodeURIComponent(slug)}/events/ack`,
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ through }),
  });
}

/** Accepts a full share link (`…/d/<slug>?token=…`) or a bare slug. Returns
 *  null for anything else, so the import command can refuse a paste instead of
 *  inventing a slug out of it. */
export function parseShareRef(input: string): ShareRef | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]+$/.test(raw)) return { baseUrl: null, slug: raw, token: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const m = /^\/d\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!m) return null;
  return { baseUrl: `${url.protocol}//${url.host}`, slug: m[1], token: url.searchParams.get("token") };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm vitest run tests/collab-bridge.test.ts
```

Expected: PASS, all cases green.

- [ ] **Step 5: Verify the repo-wide gates**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: clean, and the full suite still green.

- [ ] **Step 6: Commit**

```bash
git add src/core/collab-bridge.ts tests/collab-bridge.test.ts
git commit -m "feat(collabo): the Exo Collabo protocol as pure functions

An injected HTTP callable keeps core/ Obsidian-free and the tests offline.
The op union deliberately omits accept, reject and rewrite: the agent
proposes, the owner promotes."
```

---

### Task 4: Settings and the share registry

Where the service URL, the API key, and the note-to-document mapping live. Spends part of the budget freed in Task 2.

**Files:**
- Modify: `src/settings-schema.ts` (add three fields to `MVASettings` and `DEFAULT_SETTINGS`; not size-capped)
- Modify: `src/settings.ts` (two fields in the Advanced tab)
- Test: `tests/collabo-settings.test.ts`

**Interfaces:**
- Consumes: `ShareRole` from `src/core/collab-bridge`
- Produces: `MVASettings.collaboUrl: string`, `MVASettings.collaboApiKey: string`, `MVASettings.collaboShares: Record<string, CollaboShare>` where `CollaboShare` is `{ slug: string; ownerSecret: string; accessToken: string; role: ShareRole }`, exported from `src/settings-schema.ts`. Keys of `collaboShares` are vault-relative note paths.

- [ ] **Step 1: Write the failing test**

Create `tests/collabo-settings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, type CollaboShare } from "../src/settings-schema";

describe("Collabo settings defaults", () => {
  it("ships disabled: no service configured until the user sets one", () => {
    expect(DEFAULT_SETTINGS.collaboUrl).toBe("");
    expect(DEFAULT_SETTINGS.collaboApiKey).toBe("");
  });

  it("starts with an empty share registry", () => {
    expect(DEFAULT_SETTINGS.collaboShares).toEqual({});
  });

  it("types a share entry with everything needed to reach the document again", () => {
    const share: CollaboShare = {
      slug: "abc123xy",
      ownerSecret: "owner",
      accessToken: "tok",
      role: "commenter",
    };
    expect(share.slug).toBe("abc123xy");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm vitest run tests/collabo-settings.test.ts
```

Expected: FAIL, `collaboUrl` does not exist on the settings type / `CollaboShare` is not exported.

- [ ] **Step 3: Add the fields to `src/settings-schema.ts`**

Add near the top, after the existing imports:

```ts
import type { ShareRole } from "./core/collab-bridge";

/** What Exo remembers about a note it has shared to Exo Collabo. `ownerSecret`
 *  is the promote/revoke credential and never leaves plugin data; `accessToken`
 *  is the scoped one used for ordinary reads and agent proposals. */
export interface CollaboShare {
  slug: string;
  ownerSecret: string;
  accessToken: string;
  role: ShareRole;
}
```

Add to the `MVASettings` interface, next to the other master flags at the end:

```ts
  /** Exo Collabo service base URL. Empty means the feature is off: the share
   *  and import commands hide themselves and the `collabo_*` tools are not
   *  registered, so the session tool list is byte-identical to before the
   *  feature existed. */
  collaboUrl: string;
  /** Key for document CREATION on that service (its
   *  PROOF_SHARE_MARKDOWN_API_KEY). Per-document calls use the document's own
   *  token instead, never this. */
  collaboApiKey: string;
  /** Vault-relative note path to the document it was shared as, so re-sharing
   *  the same note reconnects instead of creating a second document. */
  collaboShares: Record<string, CollaboShare>;
```

Add to `DEFAULT_SETTINGS`:

```ts
  collaboUrl: "",
  collaboApiKey: "",
  collaboShares: {},
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run tests/collabo-settings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the two fields to the Advanced tab in `src/settings.ts`**

Inside `renderAdvancedTab`, following the file's existing `new Setting(...)` style:

```ts
    new Setting(el)
      .setName("Exo Collabo service")
      .setDesc("Base URL of your Exo Collabo deployment. Empty turns sharing off entirely.")
      .addText((t) =>
        t
          .setPlaceholder("https://exo-collabo.up.railway.app")
          .setValue(this.plugin.settings.collaboUrl)
          .onChange(async (v) => {
            this.plugin.settings.collaboUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName("Exo Collabo API key")
      .setDesc("Authenticates document creation on that service. Per-document calls use the document's own token.")
      .addText((t) =>
        t
          .setPlaceholder("hex secret")
          .setValue(this.plugin.settings.collaboApiKey)
          .onChange(async (v) => {
            this.plugin.settings.collaboApiKey = v.trim();
            await this.plugin.saveSettings();
          })
      );
```

Check the local variable name for the container in `renderAdvancedTab` before pasting (it may be `containerEl` rather than `el`) and match it.

- [ ] **Step 6: Verify the gates, including the size contract**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green. If `size-contract` fails on `src/settings.ts`, the Task 2 budget was mis-set: reduce these two settings blocks or extract more, never raise the ceiling.

- [ ] **Step 7: Commit**

```bash
git add src/settings-schema.ts src/settings.ts tests/collabo-settings.test.ts
git commit -m "feat(collabo): service config and the note-to-document registry

Empty collaboUrl is the off switch for the whole feature. The registry
maps a note path to its document so re-sharing reconnects instead of
creating a duplicate."
```

---

### Task 5: The share command

The first user-facing surface: share the active note, pick what the recipient can do, get a link on the clipboard.

**Files:**
- Create: `src/obsidian/collabo-http.ts`
- Create: `src/obsidian/collabo-commands.ts`
- Modify: `src/main.ts` (one import, one call)
- Test: `tests/collabo-commands.test.ts`

**Interfaces:**
- Consumes: everything exported by `src/core/collab-bridge`; `CollaboShare` and the three settings fields from Task 4
- Produces:
  - `obsidianHttp: HttpFn` from `src/obsidian/collabo-http.ts`
  - `registerCollaboCommands(plugin: ExoPlugin): void` from `src/obsidian/collabo-commands.ts`
  - `shareNote(deps: ShareDeps, opts: { path: string; markdown: string; title: string; role: ShareRole }): Promise<string>` from the same file, where `ShareDeps` is `{ http: HttpFn; cfg: CollaboConfig; shares: Record<string, CollaboShare>; save: () => Promise<void> }`. Returns the share URL. Task 6 reuses `ShareDeps` and `obsidianHttp`.
  - `docUrl(cfg: CollaboConfig, slug: string, token: string): string`, the one place a document URL is built. Task 6 and the owner command both use it.

- [ ] **Step 1: Write the failing test**

Create `tests/collabo-commands.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shareNote, docUrl, type ShareDeps } from "../src/obsidian/collabo-commands";
import type { CollaboShare } from "../src/settings-schema";
import type { HttpFn, HttpRequest } from "../src/core/collab-bridge";

function deps(shares: Record<string, CollaboShare> = {}) {
  const seen: HttpRequest[] = [];
  let saved = 0;
  const http: HttpFn = async (req) => {
    seen.push(req);
    return {
      status: 200,
      json: {
        success: true,
        slug: "abc123xy",
        shareUrl: "https://collabo.test/d/abc123xy",
        tokenUrl: "https://collabo.test/d/abc123xy?token=tok-9",
        ownerSecret: "owner",
        accessToken: "tok-9",
        accessRole: "commenter",
      },
    };
  };
  const d: ShareDeps = {
    http,
    cfg: { baseUrl: "https://collabo.test", apiKey: "k" },
    shares,
    save: async () => {
      saved += 1;
    },
  };
  return { d, seen, saved: () => saved };
}

describe("shareNote", () => {
  it("creates the document and returns the tokenised link", async () => {
    const { d } = deps();
    const url = await shareNote(d, {
      path: "Active/Plan.md",
      markdown: "# Plan",
      title: "Plan",
      role: "commenter",
    });
    expect(url).toBe("https://collabo.test/d/abc123xy?token=tok-9");
  });

  it("records the share against the note path and persists it", async () => {
    const shares: Record<string, CollaboShare> = {};
    const { d, saved } = deps(shares);
    await shareNote(d, { path: "Active/Plan.md", markdown: "# Plan", title: "Plan", role: "editor" });
    expect(shares["Active/Plan.md"]).toEqual({
      slug: "abc123xy",
      ownerSecret: "owner",
      accessToken: "tok-9",
      role: "commenter",
    });
    expect(saved()).toBe(1);
  });

  it("reuses the existing document instead of creating a second one", async () => {
    const shares: Record<string, CollaboShare> = {
      "Active/Plan.md": { slug: "old-slug", ownerSecret: "o", accessToken: "t", role: "commenter" },
    };
    const { d, seen } = deps(shares);
    const url = await shareNote(d, {
      path: "Active/Plan.md",
      markdown: "# Plan",
      title: "Plan",
      role: "commenter",
    });
    // No create call at all: the note already has a document.
    expect(seen).toHaveLength(0);
    expect(url).toBe("https://collabo.test/d/old-slug?token=t");
    expect(shares["Active/Plan.md"].slug).toBe("old-slug");
  });
});

describe("docUrl", () => {
  const cfg = { baseUrl: "https://collabo.test", apiKey: "k" };

  it("builds the recipient link from the scoped token", () => {
    expect(docUrl(cfg, "abc123xy", "tok-9")).toBe("https://collabo.test/d/abc123xy?token=tok-9");
  });

  it("builds the owner link from the owner secret, which is a different link", () => {
    expect(docUrl(cfg, "abc123xy", "owner-secret")).toBe(
      "https://collabo.test/d/abc123xy?token=owner-secret",
    );
  });

  it("does not double the slash when the base url has a trailing one", () => {
    expect(docUrl({ baseUrl: "https://collabo.test/", apiKey: "k" }, "s", "t")).toBe(
      "https://collabo.test/d/s?token=t",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm vitest run tests/collabo-commands.test.ts
```

Expected: FAIL, cannot resolve `../src/obsidian/collabo-commands`.

- [ ] **Step 3: Write the Obsidian HTTP adapter**

Create `src/obsidian/collabo-http.ts`:

```ts
/**
 * The one place `core/collab-bridge`'s injected HttpFn meets Obsidian.
 *
 * `requestUrl` rather than fetch: desktop CSP and proxy safe, same choice
 * already made for the CLI version check in main.ts. `throw: false` keeps the
 * status in our hands, because the bridge turns non-2xx into CollaboError
 * itself and must not have that decision pre-empted by a thrown request.
 */
import { requestUrl } from "obsidian";
import type { HttpFn } from "../core/collab-bridge";

export const obsidianHttp: HttpFn = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  let json: unknown = null;
  try {
    json = res.json;
  } catch {
    json = null; // an error page that is not JSON: status alone carries the meaning
  }
  return { status: res.status, json };
};
```

- [ ] **Step 4: Write the share command**

Create `src/obsidian/collabo-commands.ts`:

```ts
/**
 * Exo Collabo commands. They live here rather than in main.ts because main.ts
 * is at its size ceiling and this feature is self-contained: it needs the
 * plugin only for settings, the active file, and saveSettings.
 *
 * `shareNote` is separated from the command wiring so the interesting behaviour
 * (create once, reuse forever, persist the mapping) is testable without an app.
 */
import { FuzzySuggestModal, Notice, type App } from "obsidian";
import type ExoPlugin from "../main";
import type { CollaboShare } from "../settings-schema";
import {
  CollaboError,
  createDocument,
  type CollaboConfig,
  type HttpFn,
  type ShareRole,
} from "../core/collab-bridge";
import { obsidianHttp } from "./collabo-http";

export interface ShareDeps {
  http: HttpFn;
  cfg: CollaboConfig;
  shares: Record<string, CollaboShare>;
  save: () => Promise<void>;
}

const ROLES: { role: ShareRole; label: string }[] = [
  { role: "commenter", label: "Commenter: can comment and suggest, cannot change the text" },
  { role: "editor", label: "Editor: can change the text directly" },
  { role: "viewer", label: "Viewer: read only" },
];

class RolePicker extends FuzzySuggestModal<{ role: ShareRole; label: string }> {
  constructor(app: App, private onPick: (role: ShareRole) => void) {
    super(app);
    this.setPlaceholder("What can the person with this link do?");
  }
  getItems(): { role: ShareRole; label: string }[] {
    return ROLES;
  }
  getItemText(r: { role: ShareRole; label: string }): string {
    return r.label;
  }
  onChooseItem(r: { role: ShareRole; label: string }): void {
    this.onPick(r.role);
  }
}

/** The one place a document URL is built. The token decides what the opener
 *  can do: the scoped accessToken gives the recipient's role, the ownerSecret
 *  gives owner rights, which is how Mario accepts a suggestion. */
export function docUrl(cfg: CollaboConfig, slug: string, token: string): string {
  return `${cfg.baseUrl.replace(/\/+$/, "")}/d/${slug}?token=${encodeURIComponent(token)}`;
}

/** Share a note, or hand back the link of the document it already has. Returns
 *  the URL to give a human. */
export async function shareNote(
  deps: ShareDeps,
  opts: { path: string; markdown: string; title: string; role: ShareRole },
): Promise<string> {
  const existing = deps.shares[opts.path];
  if (existing) {
    // A note has exactly one document for its whole life. Re-running the
    // command is how you get the link back, not how you fork the conversation.
    return docUrl(deps.cfg, existing.slug, existing.accessToken);
  }
  const doc = await createDocument(deps.http, deps.cfg, {
    markdown: opts.markdown,
    title: opts.title,
    role: opts.role,
  });
  deps.shares[opts.path] = {
    slug: doc.slug,
    ownerSecret: doc.ownerSecret,
    accessToken: doc.accessToken,
    role: doc.accessRole,
  };
  await deps.save();
  return doc.shareUrl;
}

/** Settings to config, or null when the feature is not set up. */
export function collaboConfig(plugin: ExoPlugin): CollaboConfig | null {
  const baseUrl = plugin.settings.collaboUrl.trim();
  if (!baseUrl) return null;
  return { baseUrl, apiKey: plugin.settings.collaboApiKey.trim() };
}

export function depsFor(plugin: ExoPlugin, cfg: CollaboConfig): ShareDeps {
  return {
    http: obsidianHttp,
    cfg,
    shares: plugin.settings.collaboShares,
    save: () => plugin.saveSettings(),
  };
}

export function registerCollaboCommands(plugin: ExoPlugin): void {
  plugin.addCommand({
    id: "collabo-share-note",
    name: "Share this note to Exo Collabo",
    // Hidden entirely when no service is configured: an entry that always
    // fails is worse than no entry.
    checkCallback: (checking: boolean) => {
      const cfg = collaboConfig(plugin);
      const file = plugin.app.workspace.getActiveFile();
      if (!cfg || !file || file.extension !== "md") return false;
      if (!checking) {
        new RolePicker(plugin.app, (role) => {
          void (async () => {
            try {
              const markdown = await plugin.app.vault.read(file);
              const url = await shareNote(depsFor(plugin, cfg), {
                path: file.path,
                markdown,
                title: file.basename,
                role,
              });
              await navigator.clipboard.writeText(url);
              new Notice("Exo Collabo: link copied to clipboard");
            } catch (e) {
              new Notice(
                e instanceof CollaboError
                  ? `Exo Collabo refused the share: ${e.message}`
                  : `Exo Collabo is unreachable: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          })();
        }).open();
      }
      return true;
    },
  });

  plugin.addCommand({
    id: "collabo-open-owner",
    name: "Open this note's shared document as owner",
    // The share command copies the RECIPIENT link, which carries their role.
    // Accepting a suggestion needs the owner secret, so it gets its own entry
    // rather than being a mode of the share command nobody would find.
    checkCallback: (checking: boolean) => {
      const cfg = collaboConfig(plugin);
      const file = plugin.app.workspace.getActiveFile();
      const share = file ? plugin.settings.collaboShares[file.path] : undefined;
      if (!cfg || !share) return false;
      if (!checking) window.open(docUrl(cfg, share.slug, share.ownerSecret), "_blank");
      return true;
    },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm vitest run tests/collabo-commands.test.ts
```

Expected: PASS, all three cases green.

- [ ] **Step 6: Wire it into `main.ts`**

Add the import next to the other `./obsidian/...` imports:

```ts
import { registerCollaboCommands } from "./obsidian/collabo-commands";
```

And in `onload`, immediately after the last existing `this.addCommand({...})` block, one line:

```ts
    registerCollaboCommands(this);
```

- [ ] **Step 7: Verify everything, including the size contract**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all green. `size-contract` must pass on `src/main.ts` using the budget freed in Task 2. If it fails, extract more from `main.ts`; never raise the ceiling.

- [ ] **Step 8: Verify against the live service by hand**

Reload Obsidian, set the service URL and API key in Exo settings (Advanced tab), open any note, run **Share this note to Exo Collabo**, pick Commenter. Expected: a notice saying the link was copied. Paste it in a browser: the note renders in the Exo Collabo editor, and that session can comment but not edit the text directly. Run the command again on the same note: the same link comes back, and no second document appears.

Then run **Open this note's shared document as owner**. Expected: a browser tab opens on the same document with owner rights, able to accept and reject suggestions. If it opens with the same limited rights as the recipient link, the URL form found in Task 1 Step 6b is wrong: fix it here before continuing, because Task 7's whole review gate assumes the owner has somewhere to accept.

- [ ] **Step 9: Commit**

```bash
git add src/obsidian/collabo-http.ts src/obsidian/collabo-commands.ts src/main.ts tests/collabo-commands.test.ts
git commit -m "feat(collabo): share the active note and get a link

The role is chosen per share, the way Google Docs does it. A note keeps
one document for its whole life: re-running the command returns the link
rather than forking the conversation."
```

---

### Task 6: The import command

The symmetric half: pull a document into the vault, including one that was never an Exo note.

**Files:**
- Modify: `src/obsidian/collabo-commands.ts`
- Test: `tests/collabo-import.test.ts`

**Interfaces:**
- Consumes: `ShareDeps`, `collaboConfig`, `depsFor` from Task 5; `fetchState`, `parseShareRef` from Task 3
- Produces: `resolveImport(deps: ShareDeps, input: string): { slug: string; token: string; targetPath: string | null } | null` and `importDocument(deps: ShareDeps, input: string): Promise<{ markdown: string; targetPath: string | null; slug: string }>` from `src/obsidian/collabo-commands.ts`. `targetPath` is the vault note this document already belongs to, or null when it is new to this vault.

- [ ] **Step 1: Write the failing test**

Create `tests/collabo-import.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveImport, importDocument, type ShareDeps } from "../src/obsidian/collabo-commands";
import type { CollaboShare } from "../src/settings-schema";
import type { HttpFn } from "../src/core/collab-bridge";

function deps(shares: Record<string, CollaboShare> = {}): ShareDeps {
  const http: HttpFn = async () => ({
    status: 200,
    json: { markdown: "# Shared\n\nbody", updatedAt: "2026-08-12T10:00:00.000Z" },
  });
  return {
    http,
    cfg: { baseUrl: "https://collabo.test", apiKey: "k" },
    shares,
    save: async () => {},
  };
}

describe("resolveImport", () => {
  it("takes the token straight out of a pasted share link", () => {
    expect(resolveImport(deps(), "https://collabo.test/d/abc123xy?token=tok-9")).toEqual({
      slug: "abc123xy",
      token: "tok-9",
      targetPath: null,
    });
  });

  it("recognises a document this vault already owns and reuses its token", () => {
    const shares = {
      "Active/Plan.md": { slug: "abc123xy", ownerSecret: "o", accessToken: "stored", role: "editor" as const },
    };
    expect(resolveImport(deps(shares), "abc123xy")).toEqual({
      slug: "abc123xy",
      token: "stored",
      targetPath: "Active/Plan.md",
    });
  });

  it("refuses a bare slug it has never seen, because there is no token for it", () => {
    expect(resolveImport(deps(), "neverseen")).toBeNull();
  });

  it("refuses a paste that is not a share link", () => {
    expect(resolveImport(deps(), "https://example.com/some/page")).toBeNull();
  });
});

describe("importDocument", () => {
  it("returns the document markdown and where it belongs", async () => {
    const shares = {
      "Active/Plan.md": { slug: "abc123xy", ownerSecret: "o", accessToken: "stored", role: "editor" as const },
    };
    const out = await importDocument(deps(shares), "abc123xy");
    expect(out.markdown).toBe("# Shared\n\nbody");
    expect(out.targetPath).toBe("Active/Plan.md");
    expect(out.slug).toBe("abc123xy");
  });

  it("reports a document new to this vault with no target path", async () => {
    const out = await importDocument(deps(), "https://collabo.test/d/newdoc?token=t");
    expect(out.targetPath).toBeNull();
    expect(out.slug).toBe("newdoc");
  });

  it("throws on a paste it cannot resolve rather than writing an empty note", async () => {
    await expect(importDocument(deps(), "garbage")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm vitest run tests/collabo-import.test.ts
```

Expected: FAIL, `resolveImport` is not exported.

- [ ] **Step 3: Add the import logic to `src/obsidian/collabo-commands.ts`**

Extend the imports from the bridge to include `fetchState` and `parseShareRef`, then append:

```ts
/** Work out which document a paste refers to and which token opens it.
 *  A link carries its own token; a bare slug only works for a document this
 *  vault already knows, because nothing else supplies a credential. */
export function resolveImport(
  deps: ShareDeps,
  input: string,
): { slug: string; token: string; targetPath: string | null } | null {
  const ref = parseShareRef(input);
  if (!ref) return null;
  const owned = Object.entries(deps.shares).find(([, s]) => s.slug === ref.slug);
  const token = ref.token ?? owned?.[1].accessToken ?? null;
  if (!token) return null;
  return { slug: ref.slug, token, targetPath: owned?.[0] ?? null };
}

/** Read the accepted document. Pending suggestions are not part of state, so
 *  what comes back is exactly what the owner has promoted, never someone
 *  else's draft. */
export async function importDocument(
  deps: ShareDeps,
  input: string,
): Promise<{ markdown: string; targetPath: string | null; slug: string }> {
  const target = resolveImport(deps, input);
  if (!target) throw new Error("That is not an Exo Collabo link this vault can open.");
  const state = await fetchState(deps.http, deps.cfg, target.slug, target.token);
  return { markdown: state.markdown, targetPath: target.targetPath, slug: target.slug };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run tests/collabo-import.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the command inside `registerCollaboCommands`**

Append inside the function, after the share command:

```ts
  plugin.addCommand({
    id: "collabo-import",
    name: "Import a document from Exo Collabo",
    checkCallback: (checking: boolean) => {
      const cfg = collaboConfig(plugin);
      if (!cfg) return false;
      if (!checking) {
        void (async () => {
          const pasted = (await navigator.clipboard.readText().catch(() => "")).trim();
          try {
            const deps = depsFor(plugin, cfg);
            const out = await importDocument(deps, pasted);
            if (out.targetPath) {
              const file = plugin.app.vault.getAbstractFileByPath(out.targetPath);
              if (file instanceof TFile) {
                await plugin.app.vault.modify(file, out.markdown);
                new Notice(`Exo Collabo: updated ${out.targetPath}`);
                return;
              }
            }
            // New to this vault: land it in the inbox rather than guessing a home.
            const path = `_inbox/Collabo ${out.slug}.md`;
            await plugin.app.vault.create(path, out.markdown);
            new Notice(`Exo Collabo: imported to ${path}`);
          } catch (e) {
            new Notice(
              e instanceof CollaboError
                ? `Exo Collabo refused the read: ${e.message}`
                : `Could not import: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        })();
      }
      return true;
    },
  });
```

Add `TFile` to the `obsidian` import at the top of the file.

- [ ] **Step 6: Verify the gates**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all green.

- [ ] **Step 7: Verify against the live service by hand**

Copy the share link produced in Task 5 Step 8, edit the document in the browser, save, then run **Import a document from Exo Collabo** in Obsidian. Expected: the original note now contains the browser edit. Then create a brand new document directly in the Exo Collabo web app, copy its link, run the command again. Expected: a new note appears under `_inbox/`.

- [ ] **Step 8: Commit**

```bash
git add src/obsidian/collabo-commands.ts tests/collabo-import.test.ts
git commit -m "feat(collabo): import a document, including one born outside Exo

A link carries its own token; a bare slug only resolves for a document
this vault already knows. Documents new to the vault land in _inbox
rather than having a home guessed for them."
```

---

### Task 7: The agent tools

Five `collabo_*` tools so the agent can read a shared document, propose on it, and see what the humans did with its proposals. Registered in `tools.ts` (not size-capped), gated on the service being configured, with no `view.ts` changes.

**Files:**
- Create: `src/obsidian/collabo-tools.ts`
- Modify: `src/obsidian/tool-kit.ts` (widen `ExoToolHost.settings` with the three Collabo fields)
- Modify: `src/obsidian/tools.ts` (import, spread into the tool array, add read tools to the auto-allow set)
- Test: `tests/collabo-tools.test.ts`

**Interfaces:**
- Consumes: `postOp`, `fetchState`, `pendingEvents`, `ackEvents`, `CollaboConfig` from Task 3; `CollaboShare` and the three settings fields from Task 4
- Produces, from `src/obsidian/collabo-tools.ts`: `buildCollaboTools(bridge: CollaboToolBridge): SdkMcpToolDefinition<any>[]`, `COLLABO_READ_TOOLS: string[]`, `interface CollaboToolBridge`, and `collaboBridgeFrom(app: App): CollaboToolBridge | undefined`. The five tool names are `collabo_list_shares`, `collabo_read`, `collabo_events`, `collabo_comment`, `collabo_suggest`.

**Why the bridge resolves from `app` and not from a caller:** the browser bridge is curried per conversation in `view.ts` because it owns a lease. Exo Collabo is stateless, so there is nothing to curry, and resolving from `app` via `getExo` (the precedent set by `buildCapabilityTools(app)` in the same file) keeps `view.ts` untouched, which its 2 remaining lines of headroom require.

- [ ] **Step 1: Write the failing test**

Create `tests/collabo-tools.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildCollaboTools,
  COLLABO_READ_TOOLS,
  type CollaboToolBridge,
} from "../src/obsidian/collabo-tools";

function fakeBridge(over: Partial<CollaboToolBridge> = {}): CollaboToolBridge {
  return {
    shares: () => [{ path: "Active/Plan.md", slug: "abc123xy", role: "commenter" }],
    read: async () => ({ markdown: "# Shared\n\nbody", updatedAt: "2026-08-12T10:00:00.000Z" }),
    events: async () => [
      { id: 7, type: "suggestion.accept", by: "mario", at: "2026-08-12T11:00:00.000Z" },
    ],
    comment: async () => {},
    suggest: async () => {},
    ...over,
  };
}

type Handler = (args: unknown, extra: unknown) => Promise<{
  content: { type: string; text?: string }[];
  isError?: boolean;
}>;

const handlerOf = (bridge: CollaboToolBridge, name: string): Handler => {
  const t = buildCollaboTools(bridge).find((x) => x.name === name);
  expect(t, name).toBeTruthy();
  return t!.handler as Handler;
};

describe("registration surface", () => {
  it("registers exactly the five v1 tools", () => {
    expect(buildCollaboTools(fakeBridge()).map((t) => t.name).sort()).toEqual([
      "collabo_comment",
      "collabo_events",
      "collabo_list_shares",
      "collabo_read",
      "collabo_suggest",
    ]);
  });

  it("marks only the three observers as auto-allowed reads", () => {
    expect([...COLLABO_READ_TOOLS].sort()).toEqual([
      "mcp__obsidian__collabo_events",
      "mcp__obsidian__collabo_list_shares",
      "mcp__obsidian__collabo_read",
    ]);
  });

  it("exposes no tool that promotes or overwrites: the agent proposes only", () => {
    const names = buildCollaboTools(fakeBridge()).map((t) => t.name);
    expect(names).not.toContain("collabo_accept");
    expect(names).not.toContain("collabo_reject");
    expect(names).not.toContain("collabo_rewrite");
  });
});

describe("collabo_list_shares", () => {
  it("names every shared note with its slug and role", async () => {
    const out = await handlerOf(fakeBridge(), "collabo_list_shares")({}, {});
    expect(out.content[0].text).toContain("Active/Plan.md");
    expect(out.content[0].text).toContain("abc123xy");
    expect(out.content[0].text).toContain("commenter");
  });

  it("says so plainly when nothing is shared", async () => {
    const out = await handlerOf(fakeBridge({ shares: () => [] }), "collabo_list_shares")({}, {});
    expect(out.content[0].text).toMatch(/no shared/i);
  });
});

describe("collabo_read", () => {
  it("returns the document markdown", async () => {
    const out = await handlerOf(fakeBridge(), "collabo_read")({ slug: "abc123xy" }, {});
    expect(out.content[0].text).toContain("# Shared");
  });

  it("reports a refusal as an error result instead of throwing", async () => {
    const bridge = fakeBridge({
      read: async () => {
        throw new Error("no access");
      },
    });
    const out = await handlerOf(bridge, "collabo_read")({ slug: "gone" }, {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("no access");
  });
});

describe("collabo_events", () => {
  it("reports what the humans did, so a rejected suggestion is not retried blindly", async () => {
    const out = await handlerOf(fakeBridge(), "collabo_events")({ slug: "abc123xy" }, {});
    expect(out.content[0].text).toContain("suggestion.accept");
    expect(out.content[0].text).toContain("mario");
  });

  it("says so plainly when nothing has happened since the last check", async () => {
    const out = await handlerOf(fakeBridge({ events: async () => [] }), "collabo_events")(
      { slug: "s" },
      {},
    );
    expect(out.content[0].text).toMatch(/nothing new/i);
  });
});

describe("collabo_comment / collabo_suggest", () => {
  it("passes the comment through to the bridge", async () => {
    const calls: unknown[] = [];
    const bridge = fakeBridge({
      comment: async (slug, text, quote) => {
        calls.push({ slug, text, quote });
      },
    });
    const out = await handlerOf(bridge, "collabo_comment")(
      { slug: "abc123xy", text: "Needs a source.", quote: "revenue tripled" },
      {},
    );
    expect(calls[0]).toEqual({ slug: "abc123xy", text: "Needs a source.", quote: "revenue tripled" });
    expect(out.isError).toBeFalsy();
  });

  it("passes the suggestion through with its kind", async () => {
    const calls: unknown[] = [];
    const bridge = fakeBridge({
      suggest: async (slug, kind, quote, content) => {
        calls.push({ slug, kind, quote, content });
      },
    });
    await handlerOf(bridge, "collabo_suggest")(
      { slug: "s", kind: "replace", quote: "old", content: "new" },
      {},
    );
    expect(calls[0]).toEqual({ slug: "s", kind: "replace", quote: "old", content: "new" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm vitest run tests/collabo-tools.test.ts
```

Expected: FAIL, cannot resolve `../src/obsidian/collabo-tools`.

- [ ] **Step 3: Write `src/obsidian/collabo-tools.ts`**

```ts
/**
 * The five `collabo_*` tools. Same shape as browser-tools: this module depends
 * only on a bridge interface, so the tool surface is testable with a fake and
 * tools.ts never reaches into plugin internals.
 *
 * There is deliberately no accept, reject or rewrite tool. In Exo Collabo the
 * owner promotes a proposal to canonical text in the web client; an agent that
 * could accept its own suggestion would make the review gate decorative.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { ok, err } from "./tool-kit";

export interface CollaboShareSummary {
  path: string;
  slug: string;
  role: string;
}

/** What the plugin implements. Every method is scoped to one document by slug;
 *  credentials never reach the model. */
export interface CollaboToolBridge {
  shares(): CollaboShareSummary[];
  read(slug: string): Promise<{ markdown: string; updatedAt: string | null }>;
  /** Everything that happened on the document since the last call, already
   *  acknowledged so each event is reported once. */
  events(slug: string): Promise<{ id: number; type: string; by: string | null; at: string | null }[]>;
  comment(slug: string, text: string, quote?: string): Promise<void>;
  suggest(
    slug: string,
    kind: "insert" | "delete" | "replace",
    quote: string,
    content?: string,
  ): Promise<void>;
}

async function run(fn: () => Promise<ReturnType<typeof ok>>): Promise<ReturnType<typeof ok>> {
  try {
    return await fn();
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export function buildCollaboTools(bridge: CollaboToolBridge): SdkMcpToolDefinition<any>[] {
  const listShares = tool(
    "collabo_list_shares",
    "List the notes shared to Exo Collabo, with the slug and role of each. Start here: every other collabo tool needs a slug.",
    {},
    async () =>
      run(async () => {
        const rows = bridge.shares();
        if (!rows.length) return ok("No shared documents yet.");
        return ok(rows.map((r) => `${r.path} (slug ${r.slug}, ${r.role})`).join("\n"));
      }),
  );

  const read = tool(
    "collabo_read",
    "Read the current accepted text of a shared document. Pending suggestions are not included: this is what the owner has promoted.",
    { slug: z.string().describe("Document slug from collabo_list_shares") },
    async (args: { slug: string }) =>
      run(async () => {
        const state = await bridge.read(args.slug);
        return ok(`updatedAt: ${state.updatedAt ?? "unknown"}\n\n${state.markdown}`);
      }),
  );

  const events = tool(
    "collabo_events",
    "See what people did on a shared document since you last checked: comments added, suggestions accepted or rejected. Check this before re-proposing anything, because a rejected suggestion is an answer, not a failure to retry.",
    { slug: z.string().describe("Document slug from collabo_list_shares") },
    async (args: { slug: string }) =>
      run(async () => {
        const rows = await bridge.events(args.slug);
        if (!rows.length) return ok("Nothing new since the last check.");
        return ok(
          rows.map((e) => `${e.at ?? "unknown time"}: ${e.type} by ${e.by ?? "someone"}`).join("\n"),
        );
      }),
  );

  const comment = tool(
    "collabo_comment",
    "Leave a comment on a shared document. Use this to raise a question or flag something rather than changing the text.",
    {
      slug: z.string().describe("Document slug from collabo_list_shares"),
      text: z.string().describe("The comment body"),
      quote: z.string().optional().describe("Exact text from the document to anchor the comment to"),
    },
    async (args: { slug: string; text: string; quote?: string }) =>
      run(async () => {
        await bridge.comment(args.slug, args.text, args.quote);
        return ok("Comment posted. It is visible to everyone on the document.");
      }),
  );

  const suggest = tool(
    "collabo_suggest",
    "Propose a change to a shared document. It stays a proposal until the owner accepts it: you cannot accept your own suggestion.",
    {
      slug: z.string().describe("Document slug from collabo_list_shares"),
      kind: z.enum(["insert", "delete", "replace"]).describe("What kind of change this is"),
      quote: z.string().describe("Exact text from the document this applies to"),
      content: z.string().optional().describe("The new text, for insert and replace"),
    },
    async (args: { slug: string; kind: "insert" | "delete" | "replace"; quote: string; content?: string }) =>
      run(async () => {
        await bridge.suggest(args.slug, args.kind, args.quote, args.content);
        return ok("Suggestion posted. It becomes part of the document only when the owner accepts it.");
      }),
  );

  return [listShares, read, events, comment, suggest];
}

/** Observers only. The two proposing tools are absent on purpose: their
 *  permission card is the record that the agent wrote into a surface other
 *  people are reading. `collabo_events` belongs here despite acknowledging as
 *  it reads: the ack moves a private cursor, it changes no document and no
 *  collaborator can see it. */
export const COLLABO_READ_TOOLS = [
  "mcp__obsidian__collabo_list_shares",
  "mcp__obsidian__collabo_read",
  "mcp__obsidian__collabo_events",
];
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run tests/collabo-tools.test.ts
```

Expected: PASS. If `tool(...)` rejects the empty schema `{}` for `collabo_list_shares`, match whatever the zero-argument tools already in `tools.ts` do (`grep -n "list_tags\|list_loops" src/obsidian/tools.ts` shows the convention) and mirror it.

- [ ] **Step 5: Widen `ExoToolHost.settings` in `src/obsidian/tool-kit.ts`**

`getExo(app)` returns an `ExoToolHost` whose `settings` slice currently exposes only `automations`, `customPrompts`, `scheduledLastRun` and `claudeBin`. The bridge factory needs three more fields, so add them to that inline settings type:

```ts
    claudeBin: string;
    /** Exo Collabo service coordinates and the note-to-document registry.
     *  Read here rather than threaded from view.ts: the Collabo bridge is
     *  stateless, so there is nothing to curry per conversation. */
    collaboUrl: string;
    collaboApiKey: string;
    collaboShares: Record<string, { slug: string; ownerSecret: string; accessToken: string; role: string }>;
```

The structural type is repeated rather than imported from `settings-schema` because `ExoToolHost` describes the slice tools need, not the whole plugin: that is the existing convention in this interface.

- [ ] **Step 6: Add the bridge factory to `src/obsidian/collabo-tools.ts`**

Append to the file created in Step 3, extending its imports with `App` from `obsidian`, `getExo` from `./tool-kit`, `obsidianHttp` from `./collabo-http`, and `fetchState`, `postOp`, `pendingEvents`, `ackEvents`, `type CollaboConfig` from `../core/collab-bridge`:

```ts
/** Resolve the live bridge from the app, or undefined when no service is
 *  configured. Undefined is the normal case and must leave the session tool
 *  list byte-identical to before this feature existed. */
export function collaboBridgeFrom(app: App): CollaboToolBridge | undefined {
  const exo = getExo(app);
  const baseUrl = exo?.settings.collaboUrl?.trim();
  if (!exo || !baseUrl) return undefined;
  const cfg: CollaboConfig = { baseUrl, apiKey: exo.settings.collaboApiKey.trim() };
  const shares = exo.settings.collaboShares;
  /** Credentials never reach the model: it names a slug, we find the token. */
  const tokenFor = (slug: string): string => {
    const hit = Object.values(shares).find((s) => s.slug === slug);
    if (!hit) throw new Error(`No shared document with slug ${slug}.`);
    return hit.accessToken;
  };
  return {
    shares: () => Object.entries(shares).map(([path, s]) => ({ path, slug: s.slug, role: s.role })),
    read: (slug) => fetchState(obsidianHttp, cfg, slug, tokenFor(slug)),
    events: async (slug) => {
      const token = tokenFor(slug);
      const rows = await pendingEvents(obsidianHttp, cfg, slug, token, 0);
      // Ack through the last id so the queue stays bounded and the agent is
      // told about each event once. Reporting the same rejection every turn
      // would read as new information and invite a re-proposal.
      if (rows.length) {
        await ackEvents(obsidianHttp, cfg, slug, token, Math.max(...rows.map((r) => r.id)));
      }
      return rows;
    },
    comment: async (slug, text, quote) => {
      await postOp(
        obsidianHttp,
        cfg,
        slug,
        tokenFor(slug),
        { type: "comment.add", by: "ai:exo", text, quote },
        `exo-${slug}-${Date.now()}`,
      );
    },
    suggest: async (slug, kind, quote, content) => {
      await postOp(
        obsidianHttp,
        cfg,
        slug,
        tokenFor(slug),
        { type: "suggestion.add", by: "ai:exo", kind, quote, content },
        `exo-${slug}-${Date.now()}`,
      );
    },
  };
}
```

- [ ] **Step 7: Register the tools in `src/obsidian/tools.ts`**

Add the import next to the browser-tools one:

```ts
import { buildCollaboTools, COLLABO_READ_TOOLS, collaboBridgeFrom } from "./collabo-tools";
```

Inside `buildObsidianTools`, just before the `return [` array, resolve the bridge:

```ts
  // Stateless service: resolved from the app here rather than curried per
  // conversation in view.ts, same as buildCapabilityTools(app) above.
  const collaboBridge = collaboBridgeFrom(app);
```

Add to the returned array, immediately after the browser spread:

```ts
    ...(collaboBridge ? buildCollaboTools(collaboBridge) : []),
```

And add to the auto-allow read set next to `...BROWSER_READ_TOOLS`:

```ts
  ...COLLABO_READ_TOOLS,
```

No other file changes: `view.ts` is not touched, and `ObsidianToolOpts` gains no new option.

- [ ] **Step 8: Verify the gates**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all green, including `size-contract` (nothing here touches a capped file) and `api-contract`. If `tests/api-contract.test.ts` pins the tool roster, update it to include the four new names.

- [ ] **Step 9: Verify against the live service by hand**

Reload Obsidian with the service configured and at least one shared note. In an Exo chat, ask: "list the shared collabo documents, read the one for the plan note, and leave a comment questioning the weakest claim in it." Expected: the agent calls `collabo_list_shares` and `collabo_read` without a permission card, then raises one for `collabo_comment`. Open the share link in the browser: the comment is there, attributed to `ai:exo`. Confirm it is a comment, not a text change.

Then ask it to suggest a rewrite of one sentence, reject that suggestion in the browser as owner, and ask the agent "what happened to your suggestion?". Expected: `collabo_events` reports the rejection, and asking a second time reports nothing new rather than repeating it.

- [ ] **Step 10: Commit**

```bash
git add src/obsidian/collabo-tools.ts src/obsidian/tool-kit.ts src/obsidian/tools.ts tests/collabo-tools.test.ts
git commit -m "feat(collabo): four agent tools, all of them proposals

The agent reads a shared document and comments or suggests on it. There
is no accept, reject or rewrite tool: the owner promotes in the web
client, so the review gate is real rather than decorative."
```

---

## Verification of the whole feature

After Task 7, the end-to-end path that must work:

1. Share a vault note as commenter, send the link to someone with no Obsidian.
2. They open it in a browser, edit and comment in realtime.
3. Ask Exo to review the same document: it comments and suggests, never overwrites.
4. Accept the good suggestions in the web client, reject the rest.
5. Run import in Obsidian: the note now holds exactly the accepted text.
6. Separately, have someone create a document from scratch in Exo Collabo and send the link: import lands it in `_inbox/`.

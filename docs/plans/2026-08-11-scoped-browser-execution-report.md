# Agent Browser: execution report

Plan: `docs/plans/2026-08-11-scoped-browser-plan.md`.

> Note on this file: the resuming session was told a prior execution report
> existed at this path recording seam probes already done. It did not exist
> (`docs/plans/` had no `*scoped-browser-execution-report*`, and the plan file
> had no `## Probe results` section). So no probe was treated as settled, and
> all three load-bearing seams were probed from scratch. This file starts here.

## Status

Tasks 1 to 5 had already landed on `main` as five commits before this session
(`b1edb1f`, `3c0179d`, `72e2b89`, `4aa928c`, `f1a0518`). Tasks 6 to 10 landed
in this session. Task 11 (live verification) is **partially done**: everything
verifiable without deploying a new `main.js` into the live vault was verified
against the running Obsidian; the end-to-end agent conversation was not run,
because deploying and reloading were both out of bounds. Details in
"What the live run proved" and "What could not be verified" below.

## Commits added

| SHA | Task | What |
|---|---|---|
| `f5fb230` | 6a | Extract `MVASettings`/`DEFAULT_SETTINGS`/`LEGACY_QUEUE_FOLDER` into `src/settings-schema.ts`; lower the `settings.ts` ceiling 1340 -> 1032 |
| `3dd77b3` | 6b | `browserEnabled`, default off, plus its toggle in the settings tab |
| `b138b48` | 7 | `BrowserHost` with the pinned security posture, written after the live probes; probe results recorded in the plan |
| `afa206f` | 8 | The `exo-browser` leaf and its registration in `ui/view-registry.ts` |
| `48425a5` | 9 | `BrowserController`: lease, leaf orchestration, per-convo bridge factory |
| `62c9cb6` | 10 | Wire the bridge into both tool servers, paid for by the `formatDate`/`formatRelative` extraction |

## Gate

- `pnpm vitest run`: **151 files, 2396 tests, 0 failures** (baseline at session
  start was 148 / 2381 / 0).
- `tsc -noEmit`: exit 0.
- `pnpm lint`: 0 errors, 8 warnings (all pre-existing, unchanged count).
- `pnpm build` and `pnpm release:check` were **not** run, per the constraint
  that the build deploys into the live vault. Bundling was validated instead
  with `OBSIDIAN_PLUGIN_DIR=/tmp/exo-bundle-check node esbuild.config.mjs
  production`: clean build, 1.88 MB `main.js`, and the browser code is present
  in the bundle (`persist:exo-agent-browser`, `browser_snapshot`,
  `exo-browser`, and `require("electron")` surviving as an external).

## Ratchets

| File | Before | After | Ceiling |
|---|---|---|---|
| `src/view.ts` | 6593 | **6573** | 6600 (27 free) |
| `src/main.ts` | 3480 | **3480** | 3480 (0 free, unchanged, zero lines added) |
| `src/settings.ts` | 1024 (uncommitted extraction) | **1032** | **1032**, lowered from 1340 |

No ceiling was raised. `settings.ts` now sits exactly at its lowered ceiling:
the plan declared those 8 lines as the margin for the `browserEnabled` toggle
and the toggle spent all 8. Every further `MVASettings` key now costs lines in
`settings-schema.ts`, which is not ratcheted, so that is the intended shape,
but the next line added to the settings *tab* needs an extraction first.

## Verification of the inherited uncommitted work

The tree carried an unfinished settings-schema extraction. Verified before
committing, and the dying agent's note was correct on both counts:

- `MemorySetup` is genuinely needed by the moved block (`memorySetup?: MemorySetup`
  in `MVASettings`), so `settings-schema.ts` imports it from `./core/vault-setup`.
  The plan's expected import list (seam 7) was missing it.
- `LEGACY_QUEUE_FOLDER` is used by the settings **tab**, not only by the
  defaults (`settings.ts:760,763`, as the queue-folder placeholder and as the
  empty-input fallback). It therefore moves to `settings-schema.ts` and is
  **exported**, and `settings.ts` imports it back. The plan described it as a
  private const going along for the ride.

Beyond that the extraction was complete and behavior-neutral: the full suite
passed with zero test edits, and `settings.ts` re-exports `DEFAULT_SETTINGS`
and `MVASettings` so the external importers keep their `from "./settings"`
path.

## The three load-bearing seams

All three probed. None had to fall back.

**1. The `<webview>` element's method surface inside an Obsidian leaf: PRESENT,
no fallback needed.**

```
{"tag":"WEBVIEW","loadURL":"function","executeJavaScript":"function",
 "capturePage":"function","getURL":"function","getTitle":"function",
 "isLoading":"function","stop":"function","getWebContentsId":"function"}
```

The planned `remote.webContents.fromId(el.getWebContentsId())` routing is dead
code that was never written. Probed end to end as well: navigating to
`https://example.com` gave `getURL() === "https://example.com/"`,
`getTitle() === "Example Domain"`, and `executeJavaScript(script, false)`
returned the script's value **already as a string**, so the JSON-string
protocol crosses the guest boundary intact and `capExecResult` only caps it.

**2. `electron.remote.session`: AVAILABLE, and the hardening actually denies.**

```
{"keys":[...,"remote"],"hasRemote":true,"hasRemoteSession":true}
```

Not just present: exercised. With exactly the handlers `hardenSession()`
installs (`setPermissionRequestHandler(cb(false))`,
`setPermissionCheckHandler(() => false)`) applied to a probe partition, a real
page got:

```
geolocation.getCurrentPosition -> {"outcome":"denied","code":1,"msg":"User denied Geolocation"}
navigator.permissions.query     -> {"state":"denied"}
getUserMedia({audio:true})      -> {"outcome":"denied","name":"NotAllowedError"}
```

So `hardened` should be true on this build, and the deny-all posture is real
rather than nominal. The `will-download` block is installed but was **not**
exercised: no download was triggered during the probe (`downloadBlocked:
"no-event"`). That one is still an unproven claim.

Also confirmed while there: **`window.open` returns `null`** inside the
webview, and the page did not navigate. The no-`allowpopups` posture is inert
as designed.

**3. Does the Claude Code CLI forward MCP image content blocks to the model:
YES.** This one needed no Obsidian at all, so it was settled in isolation: a
throwaway stdio MCP server returning `{type:"image", data:<b64>, mimeType:
"image/png"}` plus a text block, a hand-encoded 240x240 PNG (red top half,
blue bottom half, green square on the left straddling the boundary), and
`claude -p ... --mcp-config`. The model answered:

> 1. **Red** - fills the entire upper half of the image
> 2. **Blue** - fills the entire lower half of the image
> 3. **Green** - a square positioned on the left side, straddling the
>    horizontal boundary between the red and blue sections

It saw the image, including the detail that the green square crosses the
midline. **The plan's fallback (writing the PNG to `paths.reports` and
returning a vault path) is not needed for Claude sessions.** The Codex loopback
bridge (seam 4) was not tested.

## The seam the probes changed the code over

Plan seam 5 said `capturePage` on a backgrounded window "may return an empty
image". It is worse than "may", and it is silent: an off-composite webview
(`opacity:0.01; z-index:-1`) resolved `capturePage()` **without throwing**,
with a `0x0`, `isEmpty() === true`, **zero-byte** image. A blank screenshot is
therefore the default failure mode of an unpainted surface, and nothing about
it looks like a failure.

Handled rather than absorbed: `BrowserHost.capture()` returns `""` for an empty
capture, and `BrowserController.screenshot()` turns that into a
`BrowserToolRefused` naming visibility, so the model is told the tab was not
painted instead of being handed 0 bytes it would confidently describe as an
empty page.

The positive path is verified too. With the Obsidian window brought to the
front and the webview actually painted, `capturePage()` returned **1272x832,
`isEmpty() === false`**, resized to 1024 wide -> **49,769 PNG bytes / 66,360
base64 chars**, and the decoded PNG is a legible render of example.com
(heading, body copy and the "Learn more" link all correct). So
`browser_screenshot` produces a real, model-readable image whenever the leaf is
visible, and refuses out loud whenever it is not.

## What the live run proved

Against Mario's real, running Obsidian, via `obsidian-cli eval`, without
deploying anything:

1. The webview element surface, `remote.session`, and the whole
   navigate/exec/capture path work (above).
2. The deny-all permission posture denies geolocation, permission queries and
   microphone; `window.open` is inert.
3. **The injected page scripts from Task 3 work against real pages.** The exact
   script strings were bundled out of `src/core/browser-inject.ts` and run in a
   real webview against `https://example.com` and
   `https://en.wikipedia.org/wiki/Obsidian`:
   - `STATUS_SCRIPT`: `{"scrollY":0,"scrollHeight":800,"viewportHeight":800}`;
     after `scrollScript({pages:1})` on Wikipedia,
     `{"scrollY":680,"scrollHeight":9002,...}` (exactly `0.85 * 800`).
   - `SNAPSHOT_SCRIPT` on example.com:
     `[{"ref":"e1","role":"heading","text":"Example Domain","level":1},
       {"ref":"e2","role":"link","text":"Learn more","href":"https://iana.org/domains/example"}]`.
     On Wikipedia: 200 elements (the in-page cap, hit exactly), headings with
     correct levels, links with hrefs.
   - `READ_PAGE_SCRIPT`: real text plus `total`, on both pages.
   - `typeIntoScript` into Wikipedia's search box: `{"ok":true}`, and reading
     the element back afterwards gave `{"v":"Obsidian"}`. The native-setter
     path really writes the value.
   - `clickScript({ref:"e1"})` on Wikipedia: `{"ok":true}`, and the URL
     actually moved to `.../Obsidian#bodyContent`. Ref-based clicking works
     end to end.
   - **The escaping holds under a real adversarial selector.**
     `clickScript({selector: '"]; window.close(); //'})` returned
     `{"ok":false,"reason":"Failed to execute 'querySelector' on 'Document':
     '\"]; window.close(); //' is not a valid selector."}`. The payload reached
     the page as an inert string literal and came back as a clean refusal.
     Obsidian did not close.
4. `dev:errors` clean at the end; zero webviews and zero `exo-browser` leaves
   left behind.

## What could NOT be verified, and why

- **The end-to-end agent conversation**: permission cards for `browser_open` /
  `browser_navigate` / `browser_type`, the eight tools appearing in a live
  session's tool list, the auto-allowed read set not raising cards, the lease
  refusal texts as they render in chat, the takeover note, and the off-flag
  byte-identity check. All of these need the new `main.js` in the vault **and**
  a plugin reload. Deploying was ruled out for this session (the build deploys
  into the live vault and another session shares this tree), and reloading Exo
  kills any in-flight turn. Neither was done.
  - Measured state, for whoever picks this up: the live vault's `main.js` was
    rebuilt at 21:13 by the other session from this shared tree, so it contains
    the browser code up to the controller but **not** the Task-10 view wiring.
    The **running** plugin is older still: version 0.35.0, with no
    `browserEnabled` key in its settings and only six `exo-*` view types
    registered (no `exo-browser`). A build + reload is the whole remaining gap.
- **`will-download` blocking**: the handler installs, but no download was
  triggered, so it is untested.
- **Codex + image blocks** (plan seam 4): untested.
- **No setting was flipped and nothing was left enabled.** `browserEnabled`
  does not exist in the running build, so there was nothing to restore. No
  probe conversation was created, so there was none to archive.

## styles.css: NOT touched, and what it still needs

Task 8 Step 3 calls for a CSS block in `styles.css`. That file is being
rewritten by another session, so it was left alone and the leaf shipped without
its stylesheet. **The `exo-browser` leaf will render but will not lay out
correctly until this lands**: `<webview>` is display-inline with no intrinsic
size, so without these rules the browser body collapses and, per the finding
above, `browser_screenshot` will correctly but unhelpfully refuse with "the
browser tab rendered nothing to capture".

The block to add, beside the other `mva-` view blocks (verify the spacing
tokens against neighbouring rules; no raw hex, no `!important`):

```css
/* Agent browser leaf: the webview must fill the pane under a slim header. */
.mva-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0;
}
.mva-browser-header {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-1) var(--size-4-2);
  border-bottom: 1px solid var(--background-modifier-border);
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
}
.mva-browser-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
}
.mva-browser-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.mva-browser-webview {
  flex: 1;
  width: 100%;
  height: 100%;
}
.mva-browser-placeholder {
  margin: auto;
  max-width: 32em;
  text-align: center;
  color: var(--text-muted);
  padding: var(--size-4-4);
}
```

The view also sets a `mva-browser-unhardened` class on the body when
`remote.session` hardening failed. Given the probe says hardening succeeds on
this build, no visual treatment is required for it today; the class exists so a
future style can surface the weaker posture without touching TypeScript.

## Deviations from the plan, and why

1. **Task 6 shipped as two commits, not one.** The extraction was inherited
   half-done and is mechanical and behavior-neutral; the flag is a feature.
   Splitting them makes the extraction independently revertible.
2. **`BrowserHost.capture()` gained an empty-capture return**, and
   `BrowserController.screenshot()` gained the matching refusal. Driven by the
   probe, not by preference (see above).
3. **`BrowserView` gained a `painted` getter.** Cheap, no dependencies, and it
   is the honest way to tell "hidden leaf" from "broken webview" if the
   screenshot refusal ever needs to say which.
4. **`tests/__mocks__/obsidian.ts` gained `ItemView` as well as `Platform`.**
   The controller `instanceof BrowserView`-checks, so the mock needs a base
   class for the module to even load under vitest. The plan only listed
   `Platform`.
5. **styles.css skipped**, as above.

## Known limitations worth a follow-up (not fixed, out of scope)

- **Link-dense pages can crowd form controls out of the snapshot.** On the
  Wikipedia probe the in-page cap of 200 was hit and the returned set contained
  **zero** elements with role `input` or `textarea`, even though the page has a
  working search box that `typeIntoScript` drove successfully by CSS selector.
  The formatter then caps again at 120. So on a big page the agent may not find
  a form field by `ref` and has to fall back to `selector`. Both caps are
  deliberate v1 choices in the plan; changing the in-page ordering to
  prioritise form controls over navigation links would fix it and is a
  contained change to `SNAPSHOT_SCRIPT`.
- The repo-root `main.js` build artifact (gitignored) was refreshed by the
  temp-dir bundle check. The live vault copy was not touched.

---

# Follow-up: the first `browser_open` always failed (fixed)

Session of 2026-08-11, after the live end-to-end verification the report above
could not run. Commit `ee60985`.

## The defect, as the agent saw it

A real turn asked for a page. The transcript:

1. `browser_open` -> **FAILED**: `The WebView must be attached to the DOM and
   the dom-ready event emitted`
2. `browser_open` again, byte-identical arguments -> **succeeded**
3. `browser_read_page` -> correct content

Deterministic, not flaky: the controller created the leaf and called into the
guest in the same breath. Electron attaches the guest asynchronously and every
webview method rejects until `dom-ready` has fired, so the FIRST call after the
leaf is created was always the one that paid the race.

That model retried and even explained the failure to itself. That is luck. The
same message reads to another model as "the browser is broken", and the feature
looks dead on first use. A tool must not hand the caller an infrastructure race
as a failure.

## The fix

`BrowserHost` now owns a readiness gate:

- The `dom-ready` listener is registered in the **same tick** the element enters
  the DOM (inside `attach()`, right after `this.webview = el`), so there is no
  window in which the event could fire before anyone is listening.
- `whenReady(timeoutMs = READY_TIMEOUT_MS)` resolves when the guest is ready.
  It is **idempotent**: once `dom-ready` has fired the flag short-circuits it,
  so it never waits twice and never registers a second listener (the first is
  removed when it fires, and a second one would never fire at all).
- The wait is bounded by a real signal, never by a sleep. **`READY_TIMEOUT_MS =
  10_000`**: the observed cost on a warm window is milliseconds, so 10s is a
  wide margin over the real case, and it stays under `NAV_TIMEOUT_MS` (15s) so a
  guest that never attaches fails before it can eat the caller's whole
  navigation budget. On expiry the error names the likely cause and the fix:
  the tab is hidden or collapsed, which is exactly the state that stops the
  guest from compositing (same root cause as the empty-capture finding above).
- `destroy()` settles anyone mid-wait with `"closed"`, drops the listener and
  drops the gate, so closing the leaf during the wait yields a clean error and
  leaks neither a listener nor a pending promise.

`BrowserController.ensureView` awaits it for **every** entry point (`open` and,
through `currentView`, all the others) and converts the host's plain `Error`
into a `BrowserToolRefused`, so a genuine timeout still renders as an answer
rather than a crash. The host keeps zero imports.

The empty-capture refusal is untouched and now has a test of its own, so it
cannot be weakened by accident.

## Tests

Strict TDD: red first (`host.whenReady is not a function`, then the wiring
assertion), then the implementation.

- `tests/browser-host.test.ts` grew a fake `<webview>` harness (node env, no
  DOM: `document.createElement` is stubbed for the duration) that emits
  `dom-ready` on demand and counts its own listeners. Five readiness tests: the
  wait does not resolve early; an already-ready host returns with a **zero**
  budget and adds no listener; expiry carries the actionable text; closing the
  leaf mid-wait rejects and leaves zero listeners; a destroyed host refuses to
  wait at all. Plus one test pinning `capture()` returning `""` for an unpainted
  guest.
- `tests/browser-wiring.test.ts` pins the seam: `await host.whenReady()` lives
  inside `ensureView`, next to a `BrowserToolRefused`.

Gate: `pnpm vitest run` **156 files, 2538 tests, 0 failures** (was 151 / 2396);
`tsc -noEmit` exit 0; `pnpm lint` 0 errors, 8 pre-existing warnings. Ratchets
untouched: this fix lives entirely in the browser modules.

## Live retest: the run the report above could not do

Tree was clean of other sessions' work, so `pnpm build` (deploys into the live
vault) and `obsidian-cli plugin:reload id=exo` were run for real.

From a genuinely fresh state (`exo-browser` leaves detached, zero webviews,
`browserEnabled` on, window visible and focused), one turn was driven through
`app.plugins.plugins.exo.askExo(...)` asking for exactly one `browser_open` on
`https://example.com` and explicitly forbidding a retry.

Transcript of the probe conversation `c215`, read back from
`conversations.json`:

```json
{"t":"tool","name":"mcp__obsidian__browser_open","input":{"url":"https://example.com"},
 "ok":true,"output":"url: https://example.com/\ntitle: Example Domain\nscroll: 0 to 777 of 777px (100% seen)"}
```

**One** `browser_open` segment, `ok: true`, page really loaded. The string
`must be attached to the DOM` does not appear anywhere in the turn. The first
call now opens the page.

Cleanup: probe conversation archived (not deleted) and its tab closed, the
`exo-browser` leaf detached, zero agent-browser webviews left (the one webview
still in the DOM is Obsidian's core Web viewer, partition
`persist:vault-…`, not `persist:exo-agent-browser`). `browserEnabled` left ON as
asked. `permissionMode` was already `bypassPermissions` and was not changed.
`dev:errors` shows only a pre-existing Obsidian Sync "Disconnected" trace from
before the session.

## Still open from the report above

Unchanged by this fix: `will-download` blocking is still unexercised, the Codex
image-block seam (plan seam 4) is still untested, and the snapshot cap can still
crowd form controls out on link-dense pages.

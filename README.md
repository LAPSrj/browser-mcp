# browser-mcp

A real browser for AI agents — an MCP (Model Context Protocol) server that
exposes navigation, interaction, inspection, and capture primitives built on
[Playwright](https://playwright.dev/). Extensible via domain plugins.

Features:

- **User-replicable core.** Every core tool corresponds to something a human
  can do in a browser: navigate, click, type, hover, scroll, read text,
  upload files, open tabs, capture screenshots, save PDFs.
- **Persistent sessions.** `open_session` → use the same page across many
  tool calls → `close_session`. Idle and wall-clock TTLs keep sessions from
  outliving their usefulness; every session dies with the MCP server.
- **Video recording.** Sessions opened with `record_video: true` capture a
  `.webm` per tab. Wall-clock TTL is clamped short on purpose so you can't
  accidentally record a 30-min video.
- **Trace recording.** Start and stop Playwright tracing around any set of
  actions in a session — returns a `trace.zip` you can scrub through in
  Playwright's Trace Viewer.
- **Plugin system.** Dev-only inspection, WordPress auth, and Gutenberg
  workflows live in separate plugins you opt into via an env var.
- **Multi-browser.** Chromium, Firefox, and WebKit for ephemeral calls and
  persistent sessions alike. Optional BrowserStack for remote desktop browsers
  (any OS) and real iOS Safari devices, with Local tunneling to test
  private / localhost URLs.

## Install

```bash
bun install              # or npm install / pnpm install
npx playwright install chromium   # or `playwright install` for all three
bun run build
```

## Use as an MCP server

Add to your MCP client configuration (e.g. Claude Desktop's
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/absolute/path/to/browser-mcp/dist/index.js"],
      "env": {
        "BROWSER_MCP_BASE_URL": "https://mysite.com",
        "BROWSER_MCP_OUTPUT_DIR": ".browser",
        "BROWSER_MCP_PLUGINS": "dev"
      }
    }
  }
}
```

Only the core primitives load by default. Enable plugins with
`BROWSER_MCP_PLUGINS` (comma-separated, dependency-ordered).

## Use from the command line

Every core primitive is runnable directly:

```bash
# Ephemeral (spins up a browser, runs one action, shuts down)
node dist/index.js navigate --url=https://example.com
node dist/index.js get_text --url=https://example.com --selector=h1
node dist/index.js multi_screenshot --url=https://example.com --fullPage=true

# With a plugin
BROWSER_MCP_PLUGINS=dev node dist/index.js evaluate_script \
  --url=https://example.com --script="return document.title"
```

`--help` lists every tool.

JSON values work as-is: `--viewports='[{"width":375,"height":812}]'`.

> **Note on sessions via CLI.** `open_session` creates a session inside the
> current process. That session dies with the CLI invocation, so multi-call
> session flows are MCP-only. CLI use is best for one-shot ephemeral tools.

## Core

### Session lifecycle

| Tool | Purpose |
|---|---|
| `open_session` | Start a persistent browser session. Returns `session_id`. Optional `browser`, `viewport`, `url`, `user_agent`, `locale`, `timezone`, `record_video`, `idle_ttl_ms`, `wall_ttl_ms`, `output_dir`, `headless`, `attach_cdp`, `auto_launch`, `executable_path`, `user_data_dir`, `ignore_https_errors`, `useBrowserStack`, `browserStackOs`, `browserStackOsVersion`, `browserStackDevice`, `browserStackLocal`. |
| `close_session` | Close a session by id. Returns video paths if recording was on. |
| `list_sessions` | List open sessions with tabs, TTLs, and next expiry. |
| `pause_session` | Snapshot a session's storage state (cookies + local/sessionStorage + launch shape) and close it. The returned `snapshot` is opaque JSON the caller persists. For human-in-loop handovers (captcha / MFA solved in a separate headed window). Not supported on `attach_cdp` sessions or while recording video / tracing. |
| `resume_session` | Reopen from a `pause_session` snapshot. Returns a NEW `session_id` — the resumed context inherits storage state but is a fresh session. Browser engine locked to the snapshot; per-call overrides for `headless`, `idle_ttl_ms`, `wall_ttl_ms`, `output_dir`. |

Every interactive primitive accepts an optional `session_id` (plus `tab_id`
for multi-tab sessions). Without `session_id`, the primitive runs against a
throwaway ephemeral context.

#### Sessions + video

Enabling `record_video: true` on `open_session` makes Playwright record the
entire browser context. Because videos grow fast, video-enabled sessions
default to a 2-minute wall TTL and cap at 10 minutes. Close the session to
finalize the webm — `close_session` returns the file paths.

#### Sessions + trace

For step-level debugging (DOM snapshots, network, console, action timeline),
enable the `dev` plugin and use `trace_start` / `trace_stop` around the
actions you want to capture. The result is a `trace.zip` openable with
`npx playwright show-trace <file>` — much richer than video when you want to
understand what the agent did.

#### Sessions + CDP attach mode

`open_session({ attach_cdp: true })` skips Playwright's bundled Chromium and
launches (or connects to) a real Chromium-channel browser instead. Two
modes:

- **Auto-launch** — `attach_cdp: true` spawns an isolated browser instance
  of the configured product on a session-scoped temp profile with
  `--remote-debugging-port` enabled, and attaches via
  `chromium.connectOverCDP()`. Product is picked by `BROWSER_MCP_PRODUCT`
  (one of `edge`, `chrome`, `brave`, `vivaldi`, `opera`); platform default
  is `edge` on Windows/WSL and `chrome` on macOS/Linux. Useful when the
  real browser engine, real cookies, or installed extensions matter.
- **Endpoint** — `attach_cdp: "http://localhost:9222"` attaches to a
  user-managed browser already running with CDP exposed. The MCP never
  spawns or closes the browser in this mode.

Per-call overrides: `executable_path` (path to the browser binary —
overrides `BROWSER_MCP_EXECUTABLE_PATH`), `user_data_dir` (reuse an
existing profile instead of the temp profile), `auto_launch` (explicit
override of the config default), `headless: false` (visible window — on
WSL, attached Windows browsers are naturally headed),
`restore_previous_tabs: true` (opt into Chromium's session-restore — by
default browser-mcp closes restored tabs on attach so the agent isn't
greeted by tabs from a prior run).

**Translate popup suppression.** Auto-generated temp profiles get
`--disable-features=Translate,TranslateUI` AND a pre-seeded
`Default/Preferences` with `translate.enabled = false` before the browser
starts — the feature flag alone isn't sufficient on current Edge because
the infobar is also gated on the per-profile pref. User-supplied
`user_data_dir` paths are NOT touched.

**WSL transparency.** WSL2's NAT can't reach Windows-host loopback, so on
WSL the auto-launch path additionally spawns a session-scoped Windows-side
PowerShell TCP relay (`0.0.0.0:<relay-port>` → `127.0.0.1:<cdp-port>`).
The relay tears down with the browser; a 10-minute idle backup timeout
fires only if browser-PID watching fails. Set `BROWSER_MCP_CDP_DEBUG=1` to
log relay activity to `%TEMP%\browser-mcp\<session>\relay.log`.

**Footgun.** Never OS-kill the attached browser (Task Manager,
`taskkill /IM msedge.exe`) — the browser shares its process group with
the user's real Edge/Chrome/etc, so this kills both. `close_session` is
the only safe teardown: it kills the spawned browser tree via the root
PID captured at spawn (`taskkill /F /T`) and leaves any unrelated browser
windows untouched. Playwright's `browser.close()` is skipped internally
for attach_cdp sessions for the same reason.

**Multi-server shared profile.** Multiple browser-mcp servers (typically
one per Claude Code conversation) can share a single `user_data_dir`. The
first to open spawns Chromium and writes a sidecar file
(`<user_data_dir>/.bm-browser.json`) recording the root PID + CDP port +
attached sessions. Subsequent opens detect the sidecar and attach to the
existing browser instead of trying to spawn a competitor. `close_session`
removes the session from the sidecar; when the last session leaves,
the browser tree is taskkill'd. Per-tab ownership uses each popup's
`Page.opener()` parent-child link — each session only sees, controls,
and closes its own tabs. `rel="noopener"` popups become orphans (no
opener; not auto-claimed by any session). See § Multi-server in
`llms-full.txt` for the full contract.

**Per-product validation status (Windows/WSL).** Edge ✓, Chrome ✓. Brave
/ Vivaldi / Opera are code-supported via the same spawn + relay + teardown
path but not live-validated — per-product FRE dialogs or default-browser
prompts may surface that aren't documented yet.

**Limits.** Chromium-channel only (no Firefox / WebKit). Cannot combine
with `record_video`.

#### Sessions + BrowserStack

`open_session({ useBrowserStack: true })` runs the persistent session on
BrowserStack's cloud grid instead of a local browser — the `session_id` is
reused across calls exactly like a local one. Add `browserStackDevice` (e.g.
`"iPhone 15 Pro Max"`) to run on a **real iOS device (Apple Safari)**;
otherwise it's a desktop OS host (`browserStackOs` / `browserStackOsVersion`).
Requires `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY`.

- **Idle ceiling.** BrowserStack force-closes the remote session after 300s
  (5 min) of inactivity — its server-side maximum. Keep the session active
  (any tool call within ~5 min) or the next call surfaces a disconnect.
- **No `record_video`.** Rejected — Playwright's video API needs a
  locally-launched context, not a remote connect. BrowserStack records every
  session server-side regardless; fetch the video from its dashboard / REST API.
- **Mutually exclusive with `attach_cdp`.**
- **Local URLs (`browserStackLocal`).** `browserStackLocal: true` opens a
  BrowserStack Local tunnel so the remote browser / device can reach private
  URLs served from the machine running the MCP (localhost, a dev vhost, an
  internal host). The tunnel is shared and ref-counted — it starts on the first
  tunneled session and stops when the last one closes. Needs
  `BROWSERSTACK_ACCESS_KEY`. See [§ BrowserStack](#browserstack) for the
  host-resolution caveats (notably: `.localhost` is not tunnel-routable on real
  iOS).
- **Real-device uploads.** `upload_file` (setInputFiles) injects a file into an
  `<input>` on a real device, but `click_to_upload` cannot — real iOS Safari
  surfaces no file-chooser event to automation (the picker is native OS UI), so
  it fast-fails with a clear message. To verify a genuine tap would land on the
  upload control (the z-index / overlay class of bug), use the `dev` plugin's
  `hit_test`; to actually pick a file through the native sheet, use BrowserStack
  Live (manual).

#### Safeguards

- **Idle TTL** — default 5 min. Reset on every tool call.
- **Wall TTL** — default 30 min (2 min with video).
- **Max concurrent sessions** — `BROWSER_MCP_MAX_SESSIONS` (default 5).
- **Process lifetime** — sessions die when the MCP server does. SIGINT /
  SIGTERM / `beforeExit` all run cleanup.

### Navigation

`navigate`, `go_back`, `go_forward`, `reload` — all accept `session_id`. The
ephemeral `navigate` is useful as a "load this page, return status/title"
probe. The session-bound variants require `session_id`.

`navigate` returns actionable diagnostics on page load failures: certificate
errors suggest using `ignore_https_errors` or switching to HTTP; DNS failures,
connection refused, and HTTP 5xx are reported with clear error messages.

### Interaction

`click`, `type_text`, `press_key`, `hover`, `scroll`, `drag`,
`select_option`, `check`, `uncheck`, `upload_file`, `click_to_upload`,
`drop_to_upload`.

`click` returns rich context about what happened: the element's metadata
(tag, type, role, href, form action/method, disabled state), whether
navigation occurred (new URL + title), page errors after navigation, and
warnings when `force:true` is used on a disabled element.

```json
{ "tool": "click", "params": { "session_id": "...", "selector": "#submit", "button": "left" } }
{ "tool": "type_text", "params": { "session_id": "...", "selector": "#email", "text": "a@b.com", "press_enter": true } }
{ "tool": "press_key", "params": { "session_id": "...", "key": "Control+A" } }
{ "tool": "scroll", "params": { "session_id": "...", "to": "bottom" } }
```

**Three ways to upload**, pick by how the page is built:

- `upload_file` — inject files straight into an `<input>` (Playwright
  `setInputFiles`). Works everywhere, including real iOS devices, but never
  clicks / triggers user activation.
- `click_to_upload` — perform a genuine click on a trigger that opens the
  browser's file chooser, then supply the files. For buttons/labels that open a
  hidden or synthetic input. **Desktop only** — real iOS Safari surfaces no
  chooser event, so it fast-fails there (use `upload_file`).
- `drop_to_upload` — simulate a drag-and-drop onto a dropzone that has no usable
  `<input>` (dropzone.js / react-dropzone). **Desktop pattern.**

To check whether a genuine tap would actually reach the upload control (vs being
covered by an overlay or a mispositioned input — the iOS picker-tap bug), use
the `dev` plugin's `hit_test`.

### Waits

`wait_for_selector`, `wait_for_url`, `wait_for_load_state`, `wait` (sleep).

Pattern matching in `wait_for_url` is a substring by default; wrap the
string in `/…/flags` form for a regex (e.g. `"/checkout-[0-9]+/i"`).

### Reads

`get_text`, `get_attribute`, `get_html`, `get_url` — all accept `session_id`
or run ephemerally. Returned content is the element's visible text,
attribute value, outerHTML, or the current URL + title.

### Tabs (session-scoped)

`open_tab`, `switch_tab`, `list_tabs`, `close_tab`. Each session holds an
active tab; every subsequent primitive targets the active tab unless you
pass an explicit `tab_id`.

### Cookies + storage (session-scoped)

`get_cookies`, `set_cookies`, `clear_cookies`, `get_storage`, `set_storage`,
`clear_storage`. Storage tools accept `area: "local" | "session"`.

### Capture + save

| Tool | Scope | Notes |
|---|---|---|
| `screenshot` | Session-bound | Screenshot a session's active (or named) tab. Optional `selector` (crop to element), `full_page`. Returns the page URL and title alongside the file path. |
| `multi_screenshot` | Ephemeral multi-browser / multi-viewport | Launches fresh browsers per call. Returns each result as text + preview image. Returns an error if the page cannot be loaded (certificate errors, DNS, connection refused). |
| `element_screenshot` | Ephemeral | Screenshot one CSS-selected element. Returns an error on page load failure. |
| `save_pdf` | Any | Chromium-only PDF export. |
| `save_html` | Any | Writes `page.content()` to disk. |

### Dialogs

`handle_next_dialog` pre-arms a one-shot handler (`accept` / `dismiss`,
optional prompt text) for the next `alert` / `confirm` / `prompt` raised
on the session's active tab.

## Plugins

Plugins are opt-in. Enable with `BROWSER_MCP_PLUGINS=name1,name2,…` —
dependencies must come before dependents.

### `dev` — developer inspection

Tools that only DevTools can deliver — stuff a real user can't see.

| Tool | Description |
|---|---|
| `evaluate_script` | Run JS in the page context and return the value. |
| `console_capture` | Capture console logs. |
| `network_log` | Capture network requests. |
| `dom_snapshot` | Simplified DOM tree. |
| `accessibility_snapshot` | Accessibility tree + 6 hand-rolled structural checks. **Not** a full WCAG audit — use `axe_audit` for that. |
| `axe_audit` | Full axe-core WCAG 2.x audit. Session-aware. Returns structured violations / passes / incomplete / inapplicable with rule IDs and CSS selectors. |
| `computed_styles` | Effective CSS for an element; optional CSS source tracing. |
| `style_check` | Assert computed CSS properties match expected values. Pass a selector + expected map; returns pass/fail per property with mismatches. Optional `tolerance_px` for fuzzy numeric comparison. |
| `performance_metrics` | Core Web Vitals + load timing. |
| `visual_diff` | Pixel-diff two PNGs. |
| `compare_screenshot` | Screenshot + diff against a reference. |
| `compare_element` | Screenshot → crop element → diff against a reference. |
| `align_elements` | Find the (dx, dy) translation that aligns each element to a reference image. Pixel-grounded — bypasses DOM-coordinate trust. |
| `schema_extract` | Parse JSON-LD structured data blocks; flag common issues. |
| `page_metadata` | Title, OG tags, meta tags, favicon, lang. |
| `hit_test` | Geometric reachability probe: at a point (selector center or x/y) report the z-ordered hit stack (`elementFromPoint` / `elementsFromPoint`) and whether a genuine tap would land on / forward to a file input. Detects overlays / mispositioned inputs (the iOS file-picker tap bug). Works on real iOS. |
| `trace_start` / `trace_stop` | Playwright tracing bound to a session. |

Dev tools are registered without the `dev_` prefix so agents still call
them by their short, well-known names.

### `wp` — WordPress authenticated session

No tools. Registers the `wordpress` mode — any tool can opt in with
`use: "wordpress"` to attach the cached wp-login.php cookie to the browser
context. Required env vars: `WP_URL`, `WP_USERNAME`, `WP_PASSWORD`.
Optional: `WP_LOGIN_URL`, `WP_SESSION_TTL`.

```bash
BROWSER_MCP_PLUGINS=wp WP_URL=https://mysite.com WP_USERNAME=admin \
  WP_PASSWORD=... node dist/index.js navigate \
  --url=https://mysite.com/wp-admin/users.php --use=wordpress
```

### `wp-gutenberg` — Gutenberg editor workflows

Depends on `wp`. Enable with `BROWSER_MCP_PLUGINS=wp,wp-gutenberg`.
Provides block-level tools for WordPress block editor workflows:

- `wp-gutenberg_insert_block` — insert a block via `wp.data`; accepts `inner_blocks` for InnerBlocks parents (recursive tree seeding) and `save: true` to persist (default is in-memory only, ephemeral). On `template-locked` FSE posts (WP 6.5+ block themes) the outer store top level is the locked template canvas — inserting there is silently rejected — so insertion auto-targets the editable post body (the `core/post-content` controlled inner-block list); pass an explicit `root_client_id` to override, and classic / `post-only` posts are unaffected
- `wp-gutenberg_get_blocks` — list blocks in a post
- `wp-gutenberg_screenshot_block` — editor / frontend screenshots
- `wp-gutenberg_inspect_toolbar` — structured block toolbar listing
- `wp-gutenberg_compare_block` — resolve + screenshot + diff in one call
- `wp-gutenberg_evaluate` — run JS in an authenticated editor page
- `wp-gutenberg_check_block` — insert + validate + a11y + screenshots; on `template-locked` FSE posts it inserts into the post body (not the locked canvas root), so the validity verdict reflects the real block instead of a false negative
- `wp-gutenberg_publish` — save / publish a post
- `wp-gutenberg_block_html` — normalized editor + frontend HTML for structural diffing. Strips Gutenberg-universal noise (RichText UX, useBlockProps decoration, components-* / appender chrome, default classes for `supports.className: false` blocks, auto-generated wrapper IDs, semantic no-ops). Accepts `strip_attributes` / `strip_classes` / `strip_css_vars` / `strip_subtrees` for project-specific runtime artifacts (intersection observers, scroll listeners, hydration markers). On block-theme posts the editor wraps the post body in a canvas template tree (`core/template-part → main → core/post-content → footer`) where `core/post-content` is a renderer leaf and the post body blocks live in a nested `useEntityBlockEditor("postType","post")` provider invisible to `core/block-editor.getBlocks()`. The default `source: "auto"` detects this case (presence of a `core/post-content` leaf in the canvas tree) and resolves the target against the parsed post body instead — strictly a no-op on classic-theme posts (no leaf, behaviorally identical to `source: "template"`). Pass `source: "template"` to force the canvas-tree resolution (legacy behavior) or `source: "post_content"` to force parsing `getEditedPostContent()` regardless of the canvas state. In `post_content` mode `client_id` is rejected (parsed blocks have synthetic clientIds); use `block_name`, `block_path`, or `block_index`. The reported `client_id` in `post_content` mode is the inner-store clientId read off the located `[data-block]` element.
- `wp-gutenberg_clear_blocks` — wipe the post body's blocks; on `template-locked` FSE posts it empties only the `core/post-content` inner blocks and leaves the surrounding template intact (returns the count removed)

Plus custom actions usable in any tool's `actions[]`: `gutenberg_insert`,
`gutenberg_set_attribute`, `gutenberg_select_block`, `gutenberg_remove`,
`gutenberg_clear`.

## Actions

Every ephemeral tool accepts an `actions` array of pre-run steps:

| Action | Params |
|---|---|
| `click` | `selector`, `optional?`, `timeout?`, `force?` |
| `type` | `selector`, `text`, `optional?`, `timeout?` |
| `wait_for_selector` | `selector`, `optional?`, `timeout?` |
| `wait` | `ms` |
| `scroll_to` | `selector`, `optional?`, `timeout?` |
| `evaluate` | `script` (fire-and-forget; use `evaluate_script` to get a value) |
| `hover` | `selector`, `optional?`, `timeout?`, `force?` |
| `select` | `selector`, `value`, `optional?`, `timeout?` |
| `assert_visible` / `assert_hidden` | `selector`, `timeout?` |
| `assert_attribute` | `selector`, `attribute`, `equals?` or `absent?` |
| `assert_text` | `selector`, `contains?` or `equals?` |
| `assert_count` | `selector`, `equals` |

Assertion actions never abort the sequence — they collect pass/fail and
return a summary alongside the tool's main result.

Plugins can register custom action types (e.g. `gutenberg_insert`,
`gutenberg_set_attribute`).

## BrowserStack

Any tool that opens an ephemeral context (no `session_id`) — `multi_screenshot`,
`element_screenshot`, and the `dev` / `design-compare` plugin tools — accepts
`useBrowserStack: true` to run the call on BrowserStack instead of a local
browser. `open_session` accepts the same flags to open a **persistent**
BrowserStack session whose `session_id` is reused across calls (see
[§ Sessions + BrowserStack](#sessions--browserstack)). Set
`BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY` first.

Per-call targeting:

| Param | Applies to | Notes |
|---|---|---|
| `browserStackOs` | desktop | OS host, e.g. `"Windows"`, `"OS X"`. Default `"Windows"`. Ignored when `browserStackDevice` is set. |
| `browserStackOsVersion` | desktop + device | `"11"` / `"Sequoia"` for desktop, or the iOS version (e.g. `"17"`) for a device. Desktop default `"11"`. |
| `browserStackDevice` | real device | Real device name, e.g. `"iPhone 15 Pro Max"`. Routes the call to a **real iOS device running Apple Safari**. |
| `browserStackLocal` | any | `true` opens a BrowserStack Local tunnel so the session can reach private / localhost URLs served from the MCP host. Needs `BROWSERSTACK_ACCESS_KEY`. See [Local URLs](#local-urls-browserstack-local) below. |

```bash
# Desktop WebKit on macOS Sonoma (NOT Safari — Playwright-WebKit on a Mac host)
multi_screenshot --url=https://example.com --useBrowserStack=true \
  --browser=webkit --browserStackOs="OS X" --browserStackOsVersion=Sonoma

# Real iOS Safari on a physical iPhone
multi_screenshot --url=https://example.com --useBrowserStack=true \
  --browserStackDevice="iPhone 15 Pro Max" --browserStackOsVersion=17
```

Notes:
- Desktop `browser: webkit` maps to BrowserStack's `playwright-webkit` — that is
  WebKit on a host OS, **not** Apple Safari. Real Safari requires
  `browserStackDevice` (a real iOS device).
- Real devices boot slowly; the first navigation can take 60–90s (handled
  automatically with a longer timeout).
- The BrowserStack-side idle timeout is set to its 5-minute max so sessions
  survive gaps between calls.
- **Video:** Playwright's `record_video` does not work over the BrowserStack
  connection (no local webm is produced). BrowserStack records every session
  server-side automatically — retrieve the video from its dashboard or REST API
  (`builds.json` → build sessions → `video_url`).
- **Real Android is not supported yet.** The device allocates, but BrowserStack
  serves a Playwright connection that neither `connect()` nor `connectOverCDP()`
  can consume (reproduced with BrowserStack's own SDK); tracked as a
  BrowserStack-side issue. Use a desktop OS or a real iOS device.

### Local URLs (BrowserStack Local)

`browserStackLocal: true` starts a [BrowserStack Local](https://www.browserstack.com/local-testing)
tunnel (via the `browserstack-local` daemon) so the remote browser / device can
reach URLs served from the machine running the MCP — `localhost`, a dev vhost,
an internal-only host. The tunnel is a shared, ref-counted singleton: it comes
up on the first tunneled session and tears down when the last one closes. Only
`BROWSERSTACK_ACCESS_KEY` is required.

The URL you navigate to is not constrained by the MCP — you pass any host in
`url` / `navigate`. Two things determine whether it actually resolves:

- **The host must resolve from the MCP machine.** The tunnel daemon runs where
  the MCP runs (e.g. inside WSL, not Windows), so the hostname has to resolve
  there — add it to that box's `/etc/hosts` / resolver if it's a custom name.
- **On real iOS, `.localhost` is not tunnel-routable.** Safari treats the
  `.localhost` TLD as loopback (RFC 6761) and never sends it through the tunnel.
  Use a public host that resolves to loopback instead — BrowserStack's own
  `bs-local.com` (apex only, no subdomains), or a wildcard dev domain you
  control (`*.dev.example.com → 127.0.0.1`), which also preserves per-subdomain
  vhosts. Host-sensitive apps (e.g. WordPress, whose `siteurl`/`home` pin a
  canonical host and would otherwise 301-redirect the device away) must be told
  to accept the alternate `Host`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `BROWSER_MCP_BASE_URL` | — | Prefix for relative URLs in tool params. |
| `BROWSER_MCP_OUTPUT_DIR` | `.browser` | Artifacts directory (screenshots, videos, traces). |
| `BROWSER_MCP_PLUGINS` | — | Comma-separated plugin names to load (e.g. `dev,wp,wp-gutenberg`). |
| `BROWSER_MCP_MAX_BROWSERS` | `3` | Max concurrent ephemeral browser launches. `0` = unlimited. |
| `BROWSER_MCP_MAX_SESSIONS` | `5` | Max persistent sessions open at once. |
| `BROWSER_MCP_LAUNCH_TIMEOUT` | `30000` | Per-launch timeout in ms. |
| `BROWSER_MCP_LAUNCH_RETRIES` | `2` | Launch retries. |
| `BROWSER_MCP_TOOL_TIMEOUT` | `90000` | Hard tool timeout in ms. |
| `BROWSER_MCP_REALISTIC_UA` | `1` | Strip headless markers from the browser's default user-agent string. Chromium headless sends `HeadlessChrome` in the UA which sites commonly detect — this replaces it with a standard Chrome UA using the actual browser version. Firefox and WebKit headless UAs are already realistic. Set `0` to keep the raw headless UA. |
| `BROWSER_MCP_GPU` | `1` | Hardware-accelerated (GPU) rendering for local browsers. **Chromium**: routes ANGLE→D3D12 so WebGL/canvas rasterization runs on the GPU instead of CPU SwiftShader (much lower CPU on shader-heavy pages). **Firefox**: enables WebGL (off by default in Playwright's headless Firefox) — it is GPU-accelerated automatically. **WebKit**: already GPU by default, unchanged. Set `0` to fall back to CPU SwiftShader for Chromium and stock WebGL-off Firefox — do this if screenshot baselines must match a SwiftShader/CI environment (GPU and SwiftShader produce different pixels). |
| `BROWSER_MCP_NETWORK_IDLE_TIMEOUT` | `15000` | Navigation `networkidle` timeout before falling back to `load`. |
| `BROWSER_MCP_PRODUCT` | `edge` (WSL/Win) / `chrome` (macOS/Linux) | Which Chromium-channel browser auto-launch uses. One of `edge`, `chrome`, `brave`, `vivaldi`, `opera`. Throws on typo. |
| `BROWSER_MCP_EXECUTABLE_PATH` | per-product default | Path to the browser executable for `open_session({ attach_cdp: true })` auto-launch. Overrides the product's canonical default; required for Opera on Windows (no machine-wide path). Per-call `executable_path` overrides this. |
| `BROWSER_MCP_CDP_DEBUG` | `0` | When `1`, the WSL CDP relay logs activity to `%TEMP%\browser-mcp\<session>\relay.log`. |
| `WP_URL` / `WP_USERNAME` / `WP_PASSWORD` | — | Required by the `wp` and `wp-gutenberg` plugins. |
| `WP_LOGIN_URL` | `{WP_URL}/wp-login.php` | Custom WP login page. |
| `WP_SESSION_TTL` | `3600` | Seconds to cache the WP login session. |
| `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY` | — | Required when any tool is called with `useBrowserStack: true`. The access key also authenticates the `browserStackLocal` tunnel. See [BrowserStack](#browserstack). |

## Writing a plugin

A plugin implements `ScreenshotPlugin`:

```ts
import type { ScreenshotPlugin, PluginContext, PluginConfigSchema } from "../types.js";

const myPlugin: ScreenshotPlugin = {
  name: "my-plugin",
  version: "0.1.0",

  // Optional — enforce declared prereqs.
  dependencies: ["wp"],

  // Optional — when false, registered tool names are NOT prefixed with
  // the plugin name. Default: true.
  prefixTools: true,

  getConfigSchema(): PluginConfigSchema {
    return {
      myApiKey: { envVar: "MY_API_KEY", required: true, description: "API token" },
    };
  },

  async register(ctx: PluginContext, resolvedConfig) {
    ctx.registerTool({
      name: "do_thing",
      description: "Do a domain-specific thing.",
      schema: { target: z.string() },
      handler: async (params) => ({ content: [{ type: "text", text: "done" }] }),
    });

    ctx.registerMode("my-mode", [async (context, page) => { /* hook */ }],
      "Short description of what this mode attaches to a context.");

    ctx.registerAction("my_plugin_do", async (page, params) => { /* ... */ });
  },
};
```

Register the plugin in `src/plugins/loader.ts` as a lazy import.

Core principles for plugins:

1. **Plugins consume core, never bypass it.** No plugin opens its own
   browser or ships its own screenshot path. If you need something core
   doesn't provide, add it to core.
2. **Name plugins by domain, not site.** `wordpress`, `shopify-admin`;
   never `acme-store`.

## License

[PolyForm Strict License 1.0.0](LICENSE.md)

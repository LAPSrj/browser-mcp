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
  persistent sessions alike. Optional BrowserStack for remote browsers.

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
node dist/index.js screenshot --url=https://example.com --fullPage=true

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
| `open_session` | Start a persistent browser session. Returns `session_id`. Optional `browser`, `viewport`, `url`, `user_agent`, `locale`, `timezone`, `record_video`, `idle_ttl_ms`, `wall_ttl_ms`, `output_dir`, `headless`, `attach_cdp`, `auto_launch`, `executable_path`, `user_data_dir`. |
| `close_session` | Close a session by id. Returns video paths if recording was on. |
| `list_sessions` | List open sessions with tabs, TTLs, and next expiry. |

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

- **Auto-launch** — `attach_cdp: true` spawns an isolated Edge instance on
  a session-scoped temp profile with `--remote-debugging-port` enabled, and
  attaches via `chromium.connectOverCDP()`. Useful when the real browser
  engine, real cookies, or installed extensions matter.
- **Endpoint** — `attach_cdp: "http://localhost:9222"` attaches to a
  user-managed browser already running with CDP exposed. The MCP never
  spawns or closes the browser in this mode.

Per-call overrides: `executable_path` (Windows path to the Edge binary —
overrides `BROWSER_MCP_EDGE_EXE`), `user_data_dir` (reuse an existing
profile instead of the temp profile), `auto_launch` (explicit override of
the config default), `headless: false` (visible window — on WSL, attached
Windows browsers are naturally headed).

**WSL transparency.** WSL2's NAT can't reach Windows-host loopback, so on
WSL the auto-launch path additionally spawns a session-scoped Windows-side
PowerShell TCP relay (`0.0.0.0:<relay-port>` → `127.0.0.1:<cdp-port>`).
The relay tears down with the browser; a 10-minute idle backup timeout
fires only if browser-PID watching fails. Set `BROWSER_MCP_CDP_DEBUG=1` to
log relay activity to `%TEMP%\browser-mcp\<session>\relay.log`.

**Footgun.** Never OS-kill the attached browser (Task Manager,
`taskkill /IM msedge.exe`) — Edge shares its process group with the user's
real Edge, so this kills both. `close_session` is the only safe teardown:
it filters by the session's user-data-dir tag and leaves the user's real
Edge running. Playwright's `browser.close()` is skipped internally for
attach_cdp sessions for the same reason.

**Limits.** Chromium-channel only (no Firefox / WebKit) — and Edge
specifically today. Cannot combine with `record_video`.

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

### Interaction

`click`, `type_text`, `press_key`, `hover`, `scroll`, `drag`,
`select_option`, `check`, `uncheck`, `upload_file`.

```json
{ "tool": "click", "params": { "session_id": "...", "selector": "#submit", "button": "left" } }
{ "tool": "type_text", "params": { "session_id": "...", "selector": "#email", "text": "a@b.com", "press_enter": true } }
{ "tool": "press_key", "params": { "session_id": "...", "key": "Control+A" } }
{ "tool": "scroll", "params": { "session_id": "...", "to": "bottom" } }
```

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
| `screenshot` | Ephemeral multi-browser / multi-viewport | Keeps the existing multi-browser / multi-viewport flow. Returns each result as text + preview image. |
| `element_screenshot` | Ephemeral | Screenshot one CSS-selected element. |
| `capture` | Session-bound | Screenshot a session's active (or named) tab. Optional `selector`, `full_page`. |
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
| `accessibility_snapshot` | Accessibility tree + optional WCAG-like rule checks. |
| `computed_styles` | Effective CSS for an element; optional CSS source tracing. |
| `performance_metrics` | Core Web Vitals + load timing. |
| `visual_diff` | Pixel-diff two PNGs. |
| `compare_screenshot` | Screenshot + diff against a reference. |
| `compare_element` | Screenshot → crop element → diff against a reference. |
| `align_elements` | Find the (dx, dy) translation that aligns each element to a reference image. Pixel-grounded — bypasses DOM-coordinate trust. |
| `schema_extract` | Parse JSON-LD structured data blocks; flag common issues. |
| `page_metadata` | Title, OG tags, meta tags, favicon, lang. |
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

- `wp-gutenberg_insert_block` — insert a block via `wp.data`; accepts `inner_blocks` for InnerBlocks parents (recursive tree seeding) and `save: true` to persist (default is in-memory only, ephemeral)
- `wp-gutenberg_get_blocks` — list blocks in a post
- `wp-gutenberg_screenshot_block` — editor / frontend screenshots
- `wp-gutenberg_inspect_toolbar` — structured block toolbar listing
- `wp-gutenberg_compare_block` — resolve + screenshot + diff in one call
- `wp-gutenberg_evaluate` — run JS in an authenticated editor page
- `wp-gutenberg_check_block` — insert + validate + a11y + screenshots
- `wp-gutenberg_publish` — save / publish a post
- `wp-gutenberg_block_html` — normalized editor + frontend HTML for structural diffing. Strips Gutenberg-universal noise (RichText UX, useBlockProps decoration, components-* / appender chrome, default classes for `supports.className: false` blocks, auto-generated wrapper IDs, semantic no-ops). Accepts `strip_attributes` / `strip_classes` / `strip_css_vars` / `strip_subtrees` for project-specific runtime artifacts (intersection observers, scroll listeners, hydration markers).
- `wp-gutenberg_clear_blocks` — wipe all blocks in a post

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
| `BROWSER_MCP_NETWORK_IDLE_TIMEOUT` | `15000` | Navigation `networkidle` timeout before falling back to `load`. |
| `BROWSER_MCP_EDGE_EXE` | — | Windows path to the Edge executable for `open_session({ attach_cdp: true })` auto-launch. Per-call `executable_path` overrides it. |
| `BROWSER_MCP_CDP_DEBUG` | `0` | When `1`, the WSL CDP relay logs activity to `%TEMP%\browser-mcp\<session>\relay.log`. |
| `WP_URL` / `WP_USERNAME` / `WP_PASSWORD` | — | Required by the `wp` and `wp-gutenberg` plugins. |
| `WP_LOGIN_URL` | `{WP_URL}/wp-login.php` | Custom WP login page. |
| `WP_SESSION_TTL` | `3600` | Seconds to cache the WP login session. |
| `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY` | — | Required when any tool is called with `useBrowserStack: true`. |

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

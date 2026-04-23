# screenshot-mcp

An MCP (Model Context Protocol) server for taking screenshots and inspecting web pages using Playwright. Designed for AI agents to verify designs and behavior of web pages.

## Features

- **Multi-browser screenshots** — Chromium, Firefox, WebKit
- **Multiple viewports** — Test responsive designs in one call
- **Pre-screenshot actions** — Click, type, scroll, hover, wait, and more
- **Assertion actions** — `assert_visible`, `assert_hidden`, `assert_attribute`, `assert_text`, `assert_count` collect pass/fail without aborting the sequence
- **Console capture** — Capture browser console output
- **DOM snapshot** — Get a simplified DOM tree
- **Accessibility tree + rule asserts** — Inspect the accessibility structure; optionally check named WCAG-like rules
- **Visual diff** — Pixel-by-pixel image comparison with top-N diff cluster breakdown
- **Compare element / screenshot** — Ref-image diff with `boundsHandling:"intersect"` and `alignTo` shortcut
- **Evaluate script** — Run JS in the page and return the JSON-serialized result
- **Schema extract** — Parse + validate JSON-LD structured data with issue heuristics
- **Network log** — Capture all network requests
- **Page metadata** — Extract title, OG tags, meta tags
- **Performance metrics** — Core Web Vitals and load timing
- **Computed styles** — Get effective CSS styles of any element, with optional source file tracing
- **Element screenshots** — Screenshot a specific CSS selector
- **BrowserStack support** — Opt-in remote browser testing
- **Relative URL support** — Configure a base URL to use relative paths
- **Configurable output directory** — Set a default screenshot path
- **Plugin system** — Extend with domain-specific tools (e.g. Gutenberg, Shopify)
- **Gutenberg plugin** — Test WordPress block editor blocks: insert, inspect, screenshot, validate, compare against a Figma reference

## Installation

```bash
# Install dependencies
bun install

# Install Playwright browsers
npx playwright install chromium
# Or install all browsers:
npx playwright install
```

## Usage

### As an MCP server

Add to your MCP client configuration (e.g., Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "screenshot": {
      "command": "node",
      "args": ["path/to/screenshot-mcp/dist/index.js"]
    }
  }
}
```

#### Configuration

You can configure the server using environment variables in your MCP client config:

```json
{
  "mcpServers": {
    "screenshot": {
      "command": "node",
      "args": ["path/to/screenshot-mcp/dist/index.js"],
      "env": {
        "SCREENSHOT_MCP_BASE_URL": "https://mysite.com",
        "SCREENSHOT_MCP_OUTPUT_DIR": "./screenshots"
      }
    }
  }
}
```

| Environment Variable | Description | Default |
|---|---|---|
| `SCREENSHOT_MCP_BASE_URL` | Base URL for resolving relative paths. When set, tools accept relative URLs like `/about` or `blog/post` in addition to absolute URLs. | _(none — only absolute URLs accepted)_ |
| `SCREENSHOT_MCP_OUTPUT_DIR` | Default directory for saving screenshots and output files. | `.screenshots` |
| `SCREENSHOT_MCP_MAX_BROWSERS` | Maximum number of concurrent browser instances. Limits parallel Playwright sessions to prevent resource exhaustion when multiple agents call tools simultaneously. Set to `0` for unlimited. | `3` |
| `SCREENSHOT_MCP_LAUNCH_TIMEOUT` | Browser launch timeout in ms. If the browser doesn't connect within this time, the launch is considered failed. | `30000` |
| `SCREENSHOT_MCP_LAUNCH_RETRIES` | Number of browser launch attempts. On failure, stale browser processes are killed before retrying with increasing backoff. | `2` |
| `SCREENSHOT_MCP_TOOL_TIMEOUT` | Global timeout in ms for the entire tool execution. Ensures no tool call can hang indefinitely regardless of the cause. | `90000` |
| `SCREENSHOT_MCP_NETWORK_IDLE_TIMEOUT` | Timeout in ms for `networkidle` navigation. If exceeded, falls back to `load` instead of failing. | `15000` |
| `SCREENSHOT_MCP_PLUGINS` | Comma-separated list of plugins to enable (e.g. `gutenberg`). | _(none)_ |

**Relative URLs:** When `SCREENSHOT_MCP_BASE_URL` is set to e.g. `https://mysite.com`, you can pass `/about` as the URL and it will be resolved to `https://mysite.com/about`. Absolute URLs (starting with `http://` or `https://`) are always accepted regardless of this setting.

### Direct CLI usage

You can also run tools directly from the command line without an MCP client:

```bash
# Take a screenshot
node dist/index.js screenshot --url=https://example.com

# Full page screenshot with multiple browsers
node dist/index.js screenshot --url=https://example.com --fullPage=true --browsers='["chromium","firefox"]'

# Mobile viewport
node dist/index.js screenshot --url=https://example.com --viewports='[{"width":375,"height":812,"label":"mobile"}]'

# Element screenshot
node dist/index.js element_screenshot --url=https://example.com --selector="h1"

# Capture console logs to file
node dist/index.js console_capture --url=https://example.com --toFile=true

# DOM snapshot
node dist/index.js dom_snapshot --url=https://example.com --maxDepth=3

# Visual diff
node dist/index.js visual_diff --imageA=before.png --imageB=after.png

# Page metadata
node dist/index.js page_metadata --url=https://example.com

# Performance metrics
node dist/index.js performance_metrics --url=https://example.com

# Computed styles (non-default only, mobile viewport)
node dist/index.js computed_styles --url=https://example.com --selector=".hero" --viewport='{"width":375,"height":812}'

# Show help
node dist/index.js --help
```

Options are passed as `--key=value` or `--key value`. JSON values (arrays, objects) are supported.

### Build and run

```bash
# Build TypeScript
npm run build

# Start the MCP server (stdio transport)
npm run start

# Or run a tool directly
node dist/index.js screenshot --url=https://example.com
```

## Tools

### `screenshot`

Take screenshots of a URL across multiple browsers and viewports.

```json
{
  "url": "https://example.com",
  "browsers": ["chromium", "firefox"],
  "viewports": [
    { "width": 1280, "height": 720, "label": "desktop" },
    { "width": 375, "height": 812, "label": "mobile" }
  ],
  "fullPage": true,
  "actions": [
    { "action": "click", "selector": "#accept-cookies" },
    { "action": "wait", "ms": 500 }
  ]
}
```

With a base URL configured, you can use relative paths:

```json
{
  "url": "/pricing",
  "browsers": ["chromium"]
}
```

### `element_screenshot`

Screenshot a specific element on a page.

```json
{
  "url": "https://example.com",
  "selector": ".hero-banner",
  "browser": "chromium"
}
```

### `console_capture`

Capture browser console output.

```json
{
  "url": "https://example.com",
  "toFile": true
}
```

### `dom_snapshot`

Get a simplified DOM tree.

```json
{
  "url": "https://example.com",
  "selector": "main",
  "maxDepth": 3
}
```

### `accessibility_snapshot`

Get the page's accessibility tree. Optionally scope to a selector and run named rule checks against WCAG-like rules that commonly bite block-style UIs.

```json
{
  "url": "https://example.com",
  "scope": "main",
  "assertRules": [
    "section-has-name",
    "details-summary-has-heading",
    "region-has-roledescription",
    "button-has-name",
    "img-has-alt",
    "form-control-has-label"
  ],
  "skipTree": false
}
```

Each rule returns pass/fail with the list of failing elements (short selector + reason). Pair with `skipTree: true` when you only want pass/fail output.

### `visual_diff`

Compare two images pixel-by-pixel. Returns a diff image, mismatch percentage, and top-N contiguous diff clusters (bbox + pixel count) so you can tell a single layout regression apart from scattered anti-aliasing drift.

```json
{
  "imageA": ".screenshots/before.png",
  "imageB": ".screenshots/after.png",
  "threshold": 0.1
}
```

### `compare_screenshot`

Take a screenshot and compare it against a reference image. Supports `ignoreRegions` with an optional `reason` field that's echoed back in the result (useful for keeping a reviewable mask trail).

```json
{
  "url": "https://example.com",
  "referenceImage": ".screenshots/reference.png",
  "threshold": 0.1,
  "ignoreRegions": [
    { "x": 40, "y": 120, "width": 320, "height": 80, "reason": "hero video poster frame — content is dynamic" }
  ]
}
```

### `compare_element`

Take a page screenshot, crop it to a CSS-selected element (with padding), and compare against a reference image. Options:

- **`boundsHandling: "strict" | "intersect"`** — `"strict"` (default) errors when the element crop extends past the reference bounds; `"intersect"` clamps the crop to the reference's dimensions and compares only the overlapping region. Use `"intersect"` when the live element is slightly taller/wider than the Figma reference (e.g. mobile breakpoints).
- **`alignTo: "top" | "center"`** — shift the reference crop so the element's top-left (or center) aligns with the reference's (0,0). The usual case: your Figma reference is cropped to a single block but the live page has a demo-container header above it. Mutually exclusive with `alignOn`.
- **`alignOn`** — same idea but takes a named anchor pair (`referenceRect` + `frontendSelector`) for when the structural offset isn't at the element's own bbox origin.
- **`ignoreRegions[].reason`** — same reviewable mask trail as `compare_screenshot`.
- **`ignoreText: true`** — mask every rendered text line (per-line client-rect) in position-only mode. Hides glyph-interior pixels so Chromium-vs-Figma font rasterization drift stops polluting the score, while still catching layout regressions that move or resize the text. **Caveat:** a wrong string of text is undetectable under `ignoreText` — pair with `assert_text` or a skill-side computed-styles check against `style.letterSpacing` / `style.lineHeightPx` from the design source. `compare_screenshot` supports the same option.

```json
{
  "url": "https://mysite.com/test-page",
  "referenceImage": "./figma/cta-desktop.png",
  "selector": ".wp-block-my-plugin-cta[id=\"cta-primary\"]",
  "alignTo": "top",
  "boundsHandling": "intersect",
  "maxDiffPercent": 2
}
```

Diff results include a top-N diff cluster breakdown (bbox + pixel count per cluster) so `0.83` can be attributed to specific regions rather than judged as a single opaque number.

### `network_log`

Capture network requests.

```json
{
  "url": "https://example.com",
  "filterUrl": "api\\.example\\.com"
}
```

### `page_metadata`

Extract page metadata and OG tags.

```json
{
  "url": "https://example.com"
}
```

### `performance_metrics`

Measure Core Web Vitals and load performance.

```json
{
  "url": "https://example.com",
  "browser": "chromium"
}
```

### `computed_styles`

Get the computed/effective CSS styles of a DOM element. By default returns only properties that differ from the browser's defaults for that element type. Supports a specific viewport size for testing responsive styles.

```json
{
  "url": "https://example.com",
  "selector": ".hero-banner",
  "filter": "non-default",
  "viewport": { "width": 375, "height": 812 }
}
```

Limit to specific properties:

```json
{
  "url": "https://example.com",
  "selector": ".hero-banner",
  "properties": ["color", "font-size", "display", "background-color"]
}
```

Trace styles back to their source CSS file and line number (Chromium only):

```json
{
  "url": "https://example.com",
  "selector": ".hero-banner",
  "includeSource": true,
  "includeInherited": true
}
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | URL to visit |
| `selector` | string | required | CSS selector of the element to inspect |
| `filter` | `"all"` \| `"non-default"` | `"non-default"` | Return all ~350 computed properties, or only those differing from browser defaults |
| `properties` | string[] | — | Limit to specific properties. Overrides `filter` |
| `includeSource` | boolean | `false` | Trace each property to its CSS file and line number (Chromium only) |
| `includeInherited` | boolean | `false` | When `includeSource` is true, also show the ancestor inheritance chain |
| `viewport` | object | `{width:1280, height:720}` | Viewport size — affects media queries, container queries, and viewport units |
| `actions` | Action[] | — | Actions to run before inspecting (e.g. hover to capture `:hover` styles) |

### `evaluate_script`

Run a JavaScript snippet in the page context and return the JSON-serialized result. Unlike the `evaluate` action (fire-and-forget), this tool returns the value. `return` works at the top level — the script is wrapped in an IIFE under the hood, so both statement-style and function-body-style snippets work.

```json
{
  "url": "https://example.com",
  "script": "const items = [...document.querySelectorAll('.item')]; return items.map(el => el.dataset.id);"
}
```

### `schema_extract`

Parse and validate all `<script type="application/ld+json">` structured-data blocks on the page. Returns the parsed JSON, detected `@type` values, and heuristic issue flags (`json-parse-failed`, `whitespace-run`, `escape-chars-in-string`, `faq-question-in-answer`, `faq-empty-answer`). Intended to catch cases where a block looks present in `accessibility_snapshot` but is actually malformed or contains raw `\t\n` escape runs.

```json
{
  "url": "https://example.com/faq"
}
```

## Plugin-provided capabilities (`use` param)

Every core tool accepts a `use` parameter that opts into named capabilities registered by loaded plugins. The most common example: the Gutenberg plugin registers a `wordpress` mode that attaches the cached wp-admin session cookie, letting any core tool reach login-gated URLs like `/wp-admin/*`, authenticated REST endpoints, or post preview URLs.

```json
{
  "url": "https://mysite.com/wp-admin/plugins.php",
  "use": "wordpress"
}
```

Pass an array to stack multiple modes: `"use": ["wordpress", "some-other-mode"]`. Session hooks run in order before the tool executes.

### `list_modes`

Returns the modes available from currently-loaded plugins.

```bash
SCREENSHOT_MCP_PLUGINS=gutenberg node dist/index.js list_modes
# [
#   {
#     "name": "wordpress",
#     "plugin": "gutenberg",
#     "description": "Authenticated WordPress session — injects the cached wp-admin cookie ..."
#   }
# ]
```

From the CLI, pass `--use=<mode>` to any core tool:

```bash
SCREENSHOT_MCP_PLUGINS=gutenberg \
WP_URL=https://mysite.com WP_USERNAME=admin WP_PASSWORD=... \
node dist/index.js screenshot --url=https://mysite.com/wp-admin/users.php --use=wordpress
```

Unknown mode names fail fast with the list of registered modes.

## Pre-screenshot Actions

All browser-based tools support an `actions` array to interact with the page before capturing:

| Action | Params | Description |
|--------|--------|-------------|
| `click` | `selector`, `optional?`, `timeout?`, `force?` | Click an element |
| `type` | `selector`, `text`, `optional?`, `timeout?` | Fill a text input |
| `wait_for_selector` | `selector`, `optional?`, `timeout?` | Wait for element to appear |
| `wait` | `ms` | Wait for a duration |
| `scroll_to` | `selector`, `optional?`, `timeout?` | Scroll element into view |
| `evaluate` | `script` | Run JavaScript on the page (fire-and-forget). `return` works at the top level; use `evaluate_script` tool to get the value back. |
| `hover` | `selector`, `optional?`, `timeout?`, `force?` | Hover over an element |
| `select` | `selector`, `value`, `optional?`, `timeout?` | Select a dropdown option |
| `assert_visible` | `selector`, `timeout?` | Assert element is visible — collects pass/fail without aborting |
| `assert_hidden` | `selector`, `timeout?` | Assert element is hidden — collects pass/fail without aborting |
| `assert_attribute` | `selector`, `attribute`, `equals?` or `absent?` | Assert an attribute's value or absence |
| `assert_text` | `selector`, `contains?` or `equals?` | Assert element's trimmed textContent |
| `assert_count` | `selector`, `equals` | Assert the number of elements matching a selector |

Assertion actions never throw or stop the sequence. Results are collected and returned alongside the tool's main output (e.g. "Assertions: 3 passed, 1 failed" with per-assertion detail). This lets flows like "click summary A, assert A open, click summary B, assert A closed and B open" run through a single tool call without bespoke plumbing.

#### Optional actions and error handling

Selector-based actions support `optional`, `timeout`, and `force` params for handling elements that may or may not be present on the page:

- **`optional`** (boolean, default: `false`) — When `true`, the action is silently skipped if the element is not found, instead of failing the entire action sequence. Remaining actions continue to run.
- **`timeout`** (number, ms) — How long to wait for the element. Defaults to 5000ms when `optional` is `true`, or the context default (30s) otherwise. When explicitly set and the action fails, remaining actions are skipped but the tool still completes its main work (e.g. takes the screenshot) and returns the error alongside the result. When not set, failures abort the tool entirely.
- **`force`** (boolean, default: `false`, `click` and `hover` only) — Skip Playwright's actionability checks (visible, enabled, stable) and act immediately. Useful for clicking disabled buttons or elements obscured by overlays.

```json
{
  "actions": [
    { "action": "click", "selector": "#dismiss-modal", "optional": true },
    { "action": "click", "selector": "#dismiss-modal", "optional": true, "timeout": 2000 },
    { "action": "click", "selector": "#required-btn", "timeout": 10000 },
    { "action": "click", "selector": ".next-slide", "force": true }
  ]
}
```

## BrowserStack

To use BrowserStack for remote browser testing:

1. Set environment variables:
   ```
   BROWSERSTACK_USERNAME=your_username
   BROWSERSTACK_ACCESS_KEY=your_key
   ```

2. Pass `useBrowserStack: true` to any tool. BrowserStack is never used unless explicitly requested.

## Output

Screenshots and files are saved to the configured output directory (default: `.screenshots/`). Override the default with the `SCREENSHOT_MCP_OUTPUT_DIR` environment variable, or per-call with the `outputDir` parameter. Each file is named with a timestamp and metadata (browser, viewport size) for easy identification.

## Plugins

The plugin system extends screenshot-mcp with domain-specific tools. Enable plugins via the `SCREENSHOT_MCP_PLUGINS` environment variable.

### Gutenberg Plugin

Tools for testing WordPress Gutenberg blocks. Handles WordPress authentication, editor navigation, block insertion via `wp.data`, and visual verification.

#### Setup

```json
{
  "mcpServers": {
    "screenshot": {
      "command": "node",
      "args": ["path/to/screenshot-mcp/dist/index.js"],
      "env": {
        "SCREENSHOT_MCP_PLUGINS": "gutenberg",
        "WP_URL": "https://mysite.com",
        "WP_USERNAME": "admin",
        "WP_PASSWORD": "your-password"
      }
    }
  }
}
```

#### Configuration

| Environment Variable | Required | Default | Description |
|---|---|---|---|
| `WP_URL` | Yes | — | WordPress site URL |
| `WP_USERNAME` | Yes | — | WordPress username |
| `WP_PASSWORD` | Yes | — | WordPress password |
| `WP_LOGIN_URL` | No | `{WP_URL}/wp-login.php` | Custom login URL (for sites with non-standard login pages) |
| `WP_SESSION_TTL` | No | `3600` | Max seconds to cache the login session before re-authenticating |

Authentication is handled automatically: the plugin logs in via `wp-login.php` on the first tool call and caches the session cookies for subsequent calls.

#### Per-block anchors on multi-block test pages

When a test page contains multiple blocks of the same type (e.g. four `wp-block-takt-text` sections in a single demo container), Playwright's strict-mode selector matching will complain that a descendant combinator matches more than one element. The fix is to give each block a unique `anchor` attribute in the editor — this writes a stable `id="..."` on the rendered element that works as a selector without descendant ambiguity:

```json
{ "action": "gutenberg_set_attribute", "block_index": 0, "attributes": { "anchor": "cta-primary" } }
```

You can then pass `block_anchor: "cta-primary"` to `gutenberg_compare_block`, or use `#cta-primary` as a direct CSS selector in core tools like `compare_element`.

#### Tools

##### `gutenberg_insert_block`

Insert a block into the WordPress editor and optionally screenshot the result.

```json
{
  "post_id": 42,
  "block_name": "my-plugin/my-block",
  "attributes": { "text": "Hello", "color": "red" },
  "screenshot": true
}
```

Returns: block registration status, clientId, validity, attributes, and an editor screenshot.

##### `gutenberg_get_blocks`

Get the list of all blocks in a post's editor.

```json
{
  "post_id": 42
}
```

Returns: array of blocks with clientId, name, attributes, isValid, and inner block count.

##### `gutenberg_screenshot_block`

Screenshot a specific block in the editor and/or its frontend rendering.

```json
{
  "post_id": 42,
  "block_index": 0,
  "context": "both"
}
```

Target by `block_index` (0-based) or `client_id`. Context: `"editor"`, `"frontend"`, or `"both"`.

Frontend context options (new):

- **`frontend_crop: true`** (default) — locate the block on the frontend and clip the screenshot to its bounding box. Set to `false` for a full-page capture.
- **`frontend_padding: <px>`** — extra padding around the block bbox (default: 0).
- **`frontend_selector: "..."`** — custom CSS selector to locate the block on the frontend. Overrides the automatic `wp-block-*` detection when the block uses custom classes or is tricky to locate.

##### `gutenberg_check_block`

Comprehensive block validation in one call. Inserts a block, checks registration, validity, console errors, takes editor + frontend screenshots, extracts the frontend HTML, and runs an accessibility check.

```json
{
  "post_id": 42,
  "block_name": "my-plugin/my-block",
  "attributes": { "heading": "Test" }
}
```

Returns a JSON report with: `is_registered`, `is_valid`, `console_errors`, `editor_screenshot`, `frontend_screenshot`, `frontend_html` (array of all matches), `frontend_matched_by` (the selector that matched), and `accessibility_snapshot`.

**Frontend block detection:** Uses `wp.blocks.getBlockDefaultClassName`, the block's custom className attribute, and the actual editor DOM classes (filtered to `wp-block-*`) to locate the rendered block. If auto-detection fails, pass `frontend_selector` to override:

```json
{
  "post_id": 42,
  "block_name": "my-plugin/my-block",
  "frontend_selector": "[data-my-block]"
}
```

When detection fails, the response includes `frontend_lookup_failed: true`, `frontend_tried_selectors` (what was attempted), and `frontend_hints` (what wp.blocks knows about the block) for diagnostics.

##### `gutenberg_inspect_toolbar`

Select a block in the editor and return its block toolbar as a structured list — label, aria-label, pressed/expanded state, disabled state, and whether each button has an icon. Use this instead of a pixel screenshot for "did I register N toolbar buttons" assertions.

```json
{
  "post_id": 42,
  "block_index": 0
}
```

Returns `{ client_id, toolbar_found, group_count, groups, button_count, buttons: [...] }`.

##### `gutenberg_compare_block`

Composite: resolves a block on the frontend, scrolls it into view, clips to its bounding box, and pixel-compares against a reference image. Accepts the same block identifiers as other Gutenberg tools, plus `block_anchor` for stable identification on multi-block test pages.

```json
{
  "post_id": 42,
  "referenceImage": "./figma/cta-desktop.png",
  "block_anchor": "cta-primary",
  "frontend_padding": 0,
  "maxDiffPercent": 2
}
```

Returns `{ match, score, diff_percentage, diff_clusters, frontend_png, diff_png, ... }`. Collapses what was previously a `gutenberg_screenshot_block` + `visual_diff` (+ manual scroll/clip) sequence into one call.

##### `gutenberg_publish`

Save or publish a post via the Gutenberg editor.

```json
{
  "post_id": 42,
  "status": "publish"
}
```

#### Custom Actions

The Gutenberg plugin registers custom action types that can be used in any screenshot-mcp tool's `actions` array (e.g. inside a regular `screenshot` call):

| Action | Params | Description |
|---|---|---|
| `gutenberg_insert` | `block_name`, `attributes?` | Insert a block via `wp.data` |
| `gutenberg_set_attribute` | `client_id` or `block_index`, `attributes` | Update block attributes |
| `gutenberg_select_block` | `client_id` or `block_index` | Select a block (opens toolbar/inspector) |

These actions require the page to already be on the Gutenberg editor with `wp.data` available. They will wait up to 10 seconds for `wp.data` to load.

```json
{
  "url": "https://mysite.com/wp-admin/post.php?post=42&action=edit",
  "actions": [
    { "action": "type", "selector": "#user_login", "text": "admin" },
    { "action": "type", "selector": "#user_pass", "text": "password" },
    { "action": "click", "selector": "#wp-submit" },
    { "action": "wait", "ms": 3000 },
    { "action": "gutenberg_insert", "block_name": "core/paragraph", "attributes": { "content": "Hello" } },
    { "action": "wait", "ms": 500 }
  ]
}
```

### Writing a Plugin

Plugins implement the `ScreenshotPlugin` interface and are registered in `src/plugins/loader.ts`. A plugin can:

- **Register tools** — new MCP tools prefixed with the plugin name
- **Register custom actions** — new action types usable in any tool's `actions` array
- **Register session hooks** — run code after browser context creation (e.g. authentication)

See `src/plugins/gutenberg/index.ts` for a complete example.

### Running Plugin Tools via CLI

Plugin tools are accessible via the same CLI as core tools. Set the plugin env vars and run:

```bash
SCREENSHOT_MCP_PLUGINS=gutenberg \
WP_URL=https://mysite.com \
WP_USERNAME=admin \
WP_PASSWORD=your-password \
node dist/index.js gutenberg_insert_block --post_id=42 --block_name=core/paragraph
```

`node dist/index.js --help` lists all available tools including loaded plugin tools.

## License

[PolyForm Strict License 1.0.0](LICENSE.md)

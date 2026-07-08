import { z } from "zod";

// Shared schema fragments used by core tools (src/server.ts) and by plugin
// tools (src/plugins/*/index.ts). Keeping them in one place keeps the
// `actions[]` surface + `use` param identical across every entry point.

export const optionalDesc =
  "If true, skip this action silently when the element is not found instead of failing (default: false)";

export const timeoutDesc =
  "Timeout in ms. When set and the action fails, remaining actions are skipped but the tool still completes and returns the error alongside the result. When optional is true, defaults to 5000. Otherwise uses the context default (30s) and failures abort the tool entirely";

export const coreActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("click"),
    selector: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
    force: z.boolean().optional().describe(
      "Skip actionability checks (visible, enabled, stable) and click immediately (default: false)",
    ),
  }),
  z.object({
    action: z.literal("type"),
    selector: z.string(),
    text: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
  }),
  z.object({
    action: z.literal("wait_for_selector"),
    selector: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
  }),
  z.object({ action: z.literal("wait"), ms: z.number() }),
  z.object({
    action: z.literal("scroll_to"),
    selector: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
  }),
  z.object({
    action: z.literal("evaluate"),
    script: z.string().describe(
      "JS to run in page context. Wrapped in an IIFE under the hood — use `return` to yield a value (value is discarded by the action; use the evaluate_script tool to get it back)",
    ),
  }),
  z.object({
    action: z.literal("assert_visible"),
    selector: z.string(),
    timeout: z.number().optional().describe("How long to wait for the element to become visible (default: 3000ms)"),
  }),
  z.object({
    action: z.literal("assert_hidden"),
    selector: z.string(),
    timeout: z.number().optional().describe("How long to wait for the element to become hidden (default: 3000ms)"),
  }),
  z.object({
    action: z.literal("assert_attribute"),
    selector: z.string(),
    attribute: z.string(),
    equals: z.string().optional().describe("Expected attribute value. Omit to assert presence regardless of value"),
    absent: z.boolean().optional().describe("When true, assert the attribute is NOT set. Mutually exclusive with equals"),
  }),
  z.object({
    action: z.literal("assert_text"),
    selector: z.string(),
    contains: z.string().optional().describe("Expected substring within the element's trimmed textContent"),
    equals: z.string().optional().describe("Expected exact trimmed textContent"),
  }),
  z.object({
    action: z.literal("assert_count"),
    selector: z.string(),
    equals: z.number().describe("Expected number of matching elements"),
  }),
  z.object({
    action: z.literal("hover"),
    selector: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
    force: z.boolean().optional().describe("Skip actionability checks and hover immediately (default: false)"),
  }),
  z.object({
    action: z.literal("select"),
    selector: z.string(),
    value: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
  }),
]);

// Plugin actions: any object with an "action" string field + arbitrary params.
// Validated at runtime by the custom action handler.
export const pluginActionSchema = z
  .object({
    action: z.string().describe("Plugin-provided action type (e.g. wp-gutenberg_insert, wp-gutenberg_select_block)"),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
  })
  .passthrough();

// Accept core actions OR plugin actions
export const actionSchema = z.union([coreActionSchema, pluginActionSchema]);

// `use` param shared across every tool. A plugin can register a named mode
// (e.g. the `wp` plugin registers "wordpress") whose session hooks get
// applied to the browser context before the tool runs.
export const useSchemaField = {
  use: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Opt into plugin-provided capabilities by mode name. E.g. use: "wordpress" applies the wp plugin\'s authenticated WP session cookie to this call, letting the tool reach /wp-admin/* and other login-gated URLs. Pass an array to stack multiple modes. Discover available modes via the list_modes tool.',
    ),
};

// BrowserStack targeting fields, shared across every tool that exposes
// `useBrowserStack`. They select which BrowserStack platform the remote browser
// runs on. Only meaningful when `useBrowserStack: true` on an ephemeral call
// (no session_id); ignored for local browsers and for existing sessions.
// Desktop default (no device) is Windows 11.
export const browserStackFields = {
  browserStackOs: z
    .string()
    .optional()
    .describe(
      'BrowserStack desktop OS when useBrowserStack is true and no browserStackDevice is set (e.g. "Windows", "OS X"). Default: "Windows". Ignored for local browsers and when targeting a real device. NOTE: even "OS X" runs Playwright-WebKit on a Mac host, NOT Apple Safari — for real Safari use browserStackDevice.',
    ),
  browserStackOsVersion: z
    .string()
    .optional()
    .describe(
      'BrowserStack OS/device version when useBrowserStack is true. Desktop: "11" (Windows) or "Sequoia"/"Sonoma"/"Ventura" (OS X). Real device: the iOS version, e.g. "17". Default desktop: "11". Ignored for local browsers.',
    ),
  browserStackDevice: z
    .string()
    .optional()
    .describe(
      'Target a REAL BrowserStack mobile device by name (e.g. "iPhone 15 Pro Max", "iPhone 14"). Requires useBrowserStack:true. When set, the session runs on a real device — real iOS Safari — and browserStackOsVersion is the iOS version (default "17"). Real devices boot slowly (allow ~60-90s). NOTE: only real iOS (Apple Safari) is supported today; real Android is not yet wired.',
    ),
  browserStackLocal: z
    .preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean())
    .optional()
    .describe(
      'Route a BrowserStack session through a BrowserStack Local tunnel so the remote browser or REAL device can ' +
        'reach localhost and private URLs served from THIS machine (e.g. "http://clw.localhost/"). Requires ' +
        'useBrowserStack:true. The tunnel auto-starts on the first tunneled session and stops when the last closes. ' +
        'Ignored when useBrowserStack is false. NOTE: the URL must resolve from the host running this MCP server — ' +
        'on WSL that is the WSL box, not Windows.',
    ),
};

export const sessionIdField = {
  session_id: z
    .string()
    .optional()
    .describe(
      "Attach this call to an existing persistent session opened via open_session. When omitted, the tool launches an ephemeral browser context, runs, and closes it. When provided, the tool reuses the session's page (or the tab named by tab_id if supported), and the context stays open for the next call.",
    ),
};

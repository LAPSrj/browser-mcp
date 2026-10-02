import { z } from "zod";

// Shared schema fragments used by core tools (src/server.ts) and by plugin
// tools (src/plugins/*/index.ts). Keeping them in one place keeps the
// `actions[]` surface + `use` param identical across every entry point.

// The optional/timeout semantics are described once on the `actions` array
// (actionsDesc) instead of on every action variant.
export const actionsDesc =
  "Steps run on the page after load. optional: skip the step if it fails (e.g. element missing). " +
  "timeout (ms): if set, a failing step stops the remaining steps and the tool returns its result plus the error; " +
  "if unset, a failure aborts the tool. Default timeout 5000 when optional, else 30000. " +
  "assert_* steps report pass/fail and never abort.";

export const coreActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("click"),
    selector: z.string(),
    optional: z.boolean().optional(),
    timeout: z.number().optional(),
    force: z.boolean().optional().describe("Skip actionability checks"),
  }),
  z.object({
    action: z.literal("type"),
    selector: z.string(),
    text: z.string(),
    optional: z.boolean().optional(),
    timeout: z.number().optional(),
  }),
  z.object({
    action: z.literal("wait_for_selector"),
    selector: z.string(),
    optional: z.boolean().optional(),
    timeout: z.number().optional(),
  }),
  z.object({ action: z.literal("wait"), ms: z.number() }),
  z.object({
    action: z.literal("scroll_to"),
    selector: z.string(),
    optional: z.boolean().optional(),
    timeout: z.number().optional(),
  }),
  z.object({
    action: z.literal("evaluate"),
    script: z.string().describe(
      "Runs in an IIFE; the return value is discarded (use evaluate_script to get it)",
    ),
  }),
  z.object({
    action: z.literal("assert_visible"),
    selector: z.string(),
    timeout: z.number().optional().describe("ms (default 3000)"),
  }),
  z.object({
    action: z.literal("assert_hidden"),
    selector: z.string(),
    timeout: z.number().optional().describe("ms (default 3000)"),
  }),
  z.object({
    action: z.literal("assert_attribute"),
    selector: z.string(),
    attribute: z.string(),
    equals: z.string().optional().describe("Omit to assert presence only"),
    absent: z.boolean().optional().describe("Exclusive with equals"),
  }),
  z.object({
    action: z.literal("assert_text"),
    selector: z.string(),
    contains: z.string().optional().describe("Substring of trimmed textContent"),
    equals: z.string().optional().describe("Exact trimmed textContent"),
  }),
  z.object({
    action: z.literal("assert_count"),
    selector: z.string(),
    equals: z.number(),
  }),
  z.object({
    action: z.literal("hover"),
    selector: z.string(),
    optional: z.boolean().optional(),
    timeout: z.number().optional(),
    force: z.boolean().optional().describe("Skip actionability checks"),
  }),
  z.object({
    action: z.literal("select"),
    selector: z.string(),
    value: z.string(),
    optional: z.boolean().optional(),
    timeout: z.number().optional(),
  }),
]);

// Plugin actions: any object with an "action" string field + arbitrary params.
// Validated at runtime by the custom action handler.
export const pluginActionSchema = z
  .object({
    action: z.string().describe("Plugin action, e.g. gutenberg_insert"),
    optional: z.boolean().optional(),
    timeout: z.number().optional(),
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
      'Plugin mode(s); see list_modes. "wordpress" injects the WP login cookie for the site of the full url (first site for a relative url); "wordpress:<site>" picks one. Array stacks modes. Not applied with session_id.',
    ),
};

// `result_path` param for tools whose results are large enough that an agent
// should be able to keep them out of its context. Added by the server to
// every plugin tool registered with `resultFile: true`; applied by
// applyResultPath (utils/result-file.ts).
export function resultPathField(outputDir: string) {
  return {
    result_path: z
      .string()
      .optional()
      .describe(
        `Write the text result to this file (relative to "${outputDir}", overwrites) instead of inline. ` +
          "The response becomes \"Result written to <path> (<bytes> bytes, sha256 <hex>).\" plus a short summary. " +
          "Images and errors stay inline.",
      ),
  };
}

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
      'Desktop OS with useBrowserStack and no device: "Windows" (default) or "OS X". "OS X" runs Playwright WebKit, not real Safari (use browserStackDevice).',
    ),
  browserStackOsVersion: z
    .string()
    .optional()
    .describe(
      'Desktop: "11" (default, Windows) or "Sequoia"/"Sonoma"/"Ventura" (OS X). Real device: iOS version (default "17").',
    ),
  browserStackDevice: z
    .string()
    .optional()
    .describe(
      'Real iOS device with real Safari (e.g. "iPhone 15 Pro Max"); needs useBrowserStack. iOS only, no Android. Boots in ~60-90s.',
    ),
  browserStackLocal: z
    .preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean())
    .optional()
    .describe(
      "Tunnel so BrowserStack can reach localhost/private URLs of the host running this server (on WSL, the WSL side). Needs useBrowserStack.",
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

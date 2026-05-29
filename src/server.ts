import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { screenshotTool } from "./core/screenshot.js";
import { elementScreenshotTool } from "./core/element-screenshot.js";
import type { ServerConfig } from "./config.js";
import { resolveUrl } from "./utils/url.js";
import {
  setLaunchConfig,
  toolContextStorage,
  createToolContext,
  abortToolContext,
} from "./utils/browser.js";
import type { PluginRegistry } from "./plugins/registry.js";
import { resolveModes, stripUse, type UseParam } from "./utils/resolve-modes.js";
import { actionSchema, useSchemaField } from "./utils/schemas.js";
import { allPrimitives } from "./core/primitives.js";
import { sessionManager } from "./core/sessions.js";

/**
 * Append a non-fatal warning to a tool result when a `use:` mode was resolved
 * but never applied. Mutating the result's content array (rather than throwing)
 * keeps the tool's output intact while making the dropped-mode visible to the
 * agent. Returns the result unchanged if it isn't the standard MCP content shape.
 */
function appendModeWarning(result: any, use: UseParam): any {
  const names = Array.isArray(use) ? use : use ? [use] : [];
  const list = names.map((n) => `"${n}"`).join(", ");
  const warning =
    `⚠️ use: ${list} had no effect on this call. Session modes are applied only ` +
    `to per-call tools (e.g. screenshot/capture without a session_id, and plugin ` +
    `tools like wp-gutenberg) — NOT to open_session, session_id tools ` +
    `(navigate/evaluate_script/click/…), or attach_cdp sessions. Any auth/cookie ` +
    `the mode would inject was NOT applied. For a credentialed attach_cdp profile, ` +
    `authenticate the profile directly instead of passing use:.`;
  if (result && Array.isArray(result.content)) {
    return { ...result, content: [...result.content, { type: "text" as const, text: warning }] };
  }
  return result;
}

function withTimeout<T extends { use?: UseParam }>(
  timeoutMs: number,
  fn: (params: Omit<T, "use">) => Promise<any>,
  registry?: PluginRegistry,
): (params: T) => Promise<any> {
  return async (params: T) => {
    let sessionHooks;
    try {
      sessionHooks = resolveModes(params.use, registry);
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
    const ctx = createToolContext(sessionHooks);
    const toolParams = stripUse(params);

    return toolContextStorage.run(ctx, async () => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            abortToolContext(ctx).catch(() => {
              // ignore — best-effort cleanup
            });
            reject(new Error(`Tool timed out after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
        });

        const result = await Promise.race([fn(toolParams), timeoutPromise]);
        // Fail-loud on a dropped mode: `use:` resolved hooks but no code path
        // consumed them (e.g. a mode passed to open_session / a session_id
        // tool / an attach_cdp session — those don't apply session hooks).
        // Surface a warning rather than silently no-op'ing a recognized param.
        if (sessionHooks.length > 0 && !ctx.hooksConsumed) {
          return appendModeWarning(result, params.use);
        }
        return result;
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    });
  };
}

export function createServer(config: ServerConfig = {}, registry?: PluginRegistry): McpServer {
  setLaunchConfig({
    launchTimeout: config.launchTimeout,
    launchRetries: config.launchRetries,
  });

  const toolTimeout = config.toolTimeout ?? 90000;

  const server = new McpServer({
    name: "browser-mcp",
    version: "0.1.1",
  });

  const wrap = <T extends { use?: UseParam }>(fn: (params: Omit<T, "use">) => Promise<any>) =>
    withTimeout<T>(toolTimeout, fn, registry);

  const defaultOutputDir = config.outputDir ?? ".browser";

  const urlDescription = config.baseUrl
    ? `URL to screenshot (absolute or relative path — base: ${config.baseUrl})`
    : "URL to screenshot (absolute URL required)";

  const urlVisitDescription = config.baseUrl
    ? `URL to visit (absolute or relative path — base: ${config.baseUrl})`
    : "URL to visit (absolute URL required)";

  function resolveParams<T extends { url: string; outputDir?: string }>(params: T): T {
    return {
      ...params,
      url: resolveUrl(params.url, config.baseUrl),
      outputDir: params.outputDir ?? defaultOutputDir,
    };
  }

  // ---------- screenshot ----------
  server.tool(
    "screenshot",
    "Take screenshots of a URL across multiple browsers and viewports. Returns images and file paths. Supports pre-screenshot actions, console capture, and full-page capture." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlDescription),
      browsers: z
        .array(z.enum(["chromium", "firefox", "webkit"]))
        .optional()
        .describe('Browsers to use (default: ["chromium"])'),
      viewports: z
        .array(
          z.object({
            width: z.number(),
            height: z.number(),
            label: z.string().optional(),
          }),
        )
        .optional()
        .describe("Viewport sizes (default: [{width:1280, height:720}])"),
      fullPage: z.boolean().optional().describe("Capture full scrollable page (default: false)"),
      outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      actions: z.array(actionSchema).optional().describe(
        "Actions to run before screenshot. Selector-based actions (click, type, hover, scroll_to, select, wait_for_selector) support optional (skip if element missing) and timeout (ms) params",
      ),
      captureConsole: z.boolean().optional().describe("Also return console logs (default: false)"),
      consoleToFile: z.boolean().optional().describe("Write console logs to file (default: false)"),
      waitForNetworkIdle: z.boolean().optional().describe("Wait for network idle before screenshot (default: true)"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack instead of local browsers (default: false)"),
      delay: z.number().optional().describe("Extra delay in ms before capture (default: 0)"),
      startY: z.number().optional().describe("Y coordinate to start the screenshot clip from (pixels from top)"),
      endY: z.number().optional().describe("Y coordinate to end the screenshot clip at (pixels from top)"),
      startX: z.number().optional().describe("X coordinate to start the screenshot clip from (pixels from left). Defaults to 0. For a center crop of width W, pass startX = (viewport.width - W) / 2"),
      endX: z.number().optional().describe("X coordinate to end the screenshot clip at (pixels from left). Defaults to viewport width"),
      ...useSchemaField,
    },
    wrap(async (params) => screenshotTool(resolveParams(params)) as any),
  );

  // ---------- element_screenshot ----------
  server.tool(
    "element_screenshot",
    "Take a screenshot of a specific element on a page identified by CSS selector." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      selector: z.string().describe("CSS selector of the element to screenshot"),
      browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Browser to use (default: "chromium")'),
      viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size (default: {width:1280, height:720})"),
      actions: z.array(actionSchema).optional().describe(
        "Actions to run before screenshot. Selector-based actions support optional and timeout params",
      ),
      outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => elementScreenshotTool(resolveParams(params)) as any),
  );

  // ---------- list_modes ----------
  server.tool(
    "list_modes",
    'List named modes registered by loaded plugins. Pass a mode name via a tool\'s `use` param to opt into its session hooks (e.g. use: "wordpress" attaches the wp plugin\'s auth cookie to a core tool call, unlocking /wp-admin/ URLs).',
    {},
    async () => {
      const modes = registry?.listModes() ?? [];
      if (modes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No modes registered. Load plugins via BROWSER_MCP_PLUGINS to enable modes (e.g. BROWSER_MCP_PLUGINS=wp registers the \"wordpress\" mode).",
            },
          ],
        };
      }
      const payload = modes.map((m) => ({
        name: m.name,
        plugin: m.pluginName,
        description: m.description,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  // ---------- Core primitives (sessions, navigation, interaction, waits, reads, tabs, cookies/storage, capture, save, dialogs) ----------
  const primitives = allPrimitives();
  for (const [name, def] of Object.entries(primitives)) {
    server.tool(name, def.description, def.schema, wrap(def.handler));
  }

  // Sessions outlive a single tool call; make sure process exit closes them.
  sessionManager.bindShutdownSignals();

  // ---------- Plugin-registered tools ----------
  if (registry) {
    for (const tool of registry.getTools()) {
      server.tool(tool.name, tool.description, tool.schema, wrap(tool.handler));
    }
  }

  return server;
}

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
import { actionSchema, actionsDesc, useSchemaField, browserStackFields, resultPathField } from "./utils/schemas.js";
import { applyResultPath } from "./utils/result-file.js";
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
  outputDir: string,
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
    const rawUrl = (params as { url?: unknown }).url;
    const ctx = createToolContext(sessionHooks, typeof rawUrl === "string" ? rawUrl : undefined);
    // result_path only reaches here for tools registered with resultFile
    // (zod drops it from every other schema); the tool itself never sees it.
    // stripUse returns a copy, so deleting from it leaves `params` intact.
    const toolParams = stripUse(params) as Omit<T, "use"> & { result_path?: string };
    const resultPath = toolParams.result_path;
    delete toolParams.result_path;

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

        const result = await applyResultPath(
          await Promise.race([fn(toolParams), timeoutPromise]),
          resultPath,
          outputDir,
        );
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

  const defaultOutputDir = config.outputDir ?? ".browser";

  const wrap = <T extends { use?: UseParam }>(fn: (params: Omit<T, "use">) => Promise<any>) =>
    withTimeout<T>(toolTimeout, defaultOutputDir, fn, registry);

  const urlDescription = config.baseUrl
    ? `Absolute URL or path relative to ${config.baseUrl}`
    : "Absolute URL";

  const urlVisitDescription = urlDescription;

  function resolveParams<T extends { url: string; outputDir?: string }>(params: T): T {
    return {
      ...params,
      url: resolveUrl(params.url, config.baseUrl),
      outputDir: params.outputDir ?? defaultOutputDir,
    };
  }

  // ---------- multi_screenshot ----------
  server.tool(
    "multi_screenshot",
    "Screenshot a URL across several browsers and viewports in one call, in fresh ephemeral browsers (no cookies, auth, or state). " +
      "For a page in an existing session use screenshot({session_id}); for one element use element_screenshot. " +
      "Errors if the page can't load (TLS, DNS, refused, HTTP 5xx).",
    {
      url: z.string().describe(urlDescription),
      browsers: z
        .array(z.enum(["chromium", "firefox", "webkit"]))
        .optional()
        .describe('Default ["chromium"]'),
      viewports: z
        .array(
          z.object({
            width: z.number(),
            height: z.number(),
            label: z.string().optional(),
          }),
        )
        .optional()
        .describe("Default [{width:1280, height:720}]"),
      fullPage: z.boolean().optional().describe("Full scrollable page (default false)"),
      outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
      actions: z.array(actionSchema).optional().describe(actionsDesc),
      captureConsole: z.boolean().optional().describe("Also return console logs (default false)"),
      consoleToFile: z.boolean().optional().describe("Write console logs to a file (default false)"),
      waitForNetworkIdle: z.boolean().optional().describe("Default true"),
      useBrowserStack: z.boolean().optional().describe("Default false"),
      ...browserStackFields,
      delay: z.number().optional().describe("Extra ms before capture (default 0)"),
      startY: z.number().optional().describe("Clip top, px from page top"),
      endY: z.number().optional().describe("Clip bottom, px from page top"),
      startX: z.number().optional().describe("Clip left, px (default 0). Center crop of width W: (viewport.width - W) / 2"),
      endX: z.number().optional().describe("Clip right, px (default viewport width)"),
      ...useSchemaField,
    },
    wrap(async (params) => screenshotTool(resolveParams(params)) as any),
  );

  // ---------- element_screenshot ----------
  server.tool(
    "element_screenshot",
    "Screenshot one element (CSS selector) of a URL in a fresh ephemeral browser (no cookies or auth). " +
      "For an element in an existing session use screenshot({session_id, selector}). " +
      "Errors if the page can't load (TLS, DNS, refused).",
    {
      url: z.string().describe(urlVisitDescription),
      selector: z.string().describe("CSS selector"),
      browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Default "chromium"'),
      viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Default {width:1280, height:720}"),
      actions: z.array(actionSchema).optional().describe(actionsDesc),
      outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
      useBrowserStack: z.boolean().optional().describe("Default false"),
      ...browserStackFields,
      ...useSchemaField,
    },
    wrap(async (params) => elementScreenshotTool(resolveParams(params)) as any),
  );

  // ---------- list_modes ----------
  server.tool(
    "list_modes",
    "List the modes loaded plugins register, for a tool's `use` param.",
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
      const schema = tool.resultFile
        ? { ...tool.schema, ...resultPathField(defaultOutputDir) }
        : tool.schema;
      server.tool(tool.name, tool.description, schema, wrap(tool.handler));
    }
  }

  return server;
}

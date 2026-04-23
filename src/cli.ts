import { screenshotTool } from "./core/screenshot.js";
import { elementScreenshotTool } from "./core/element-screenshot.js";
import { consoleCaptureTool } from "./core/console-capture.js";
import { domSnapshotTool } from "./core/dom-snapshot.js";
import { accessibilitySnapshotTool } from "./core/accessibility.js";
import { visualDiffTool } from "./core/visual-diff.js";
import { compareScreenshotTool } from "./core/compare-screenshot.js";
import { compareElementTool } from "./core/compare-element.js";
import { networkLogTool } from "./core/network-log.js";
import { pageMetadataTool } from "./core/page-metadata.js";
import { performanceMetricsTool } from "./core/performance.js";
import { computedStylesTool } from "./core/computed-styles.js";
import { evaluateScriptTool } from "./core/evaluate-script.js";
import { schemaExtractTool } from "./core/schema-extract.js";
import type { PluginRegistry } from "./plugins/registry.js";
import { resolveModes, stripUse, type UseParam } from "./utils/resolve-modes.js";
import { toolContextStorage, createToolContext } from "./utils/browser.js";

const CORE_TOOLS = [
  "screenshot",
  "element_screenshot",
  "console_capture",
  "dom_snapshot",
  "accessibility_snapshot",
  "visual_diff",
  "compare_screenshot",
  "compare_element",
  "network_log",
  "page_metadata",
  "performance_metrics",
  "computed_styles",
  "evaluate_script",
  "schema_extract",
  "list_modes",
] as const;

function printUsage(pluginTools: string[] = []): void {
  const pluginSection = pluginTools.length > 0
    ? `\nPlugin tools:\n${pluginTools.map((t) => `  ${t}`).join("\n")}\n`
    : "";

  console.log(`browser-mcp — Screenshot and web inspection tools

Usage:
  browser-mcp <tool> [options]     Run a tool directly
  browser-mcp                      Start as MCP server (stdio)

Tools:
  screenshot              Take screenshots of a URL
  element_screenshot      Screenshot a specific element
  console_capture         Capture browser console output
  dom_snapshot            Get simplified DOM tree
  accessibility_snapshot  Get accessibility tree
  visual_diff             Compare two images pixel-by-pixel
  compare_screenshot      Screenshot + compare against a reference image
  compare_element         Screenshot-and-compare a single CSS selector
  network_log             Capture network requests
  page_metadata           Extract page metadata and OG tags
  performance_metrics     Measure Core Web Vitals
  computed_styles         Get computed CSS styles of a DOM element
  evaluate_script         Run JS in page context and return the result
  schema_extract          Parse + validate JSON-LD structured data
  list_modes              List plugin-provided modes available via --use
${pluginSection}
Options are passed as --key=value or --key value. JSON values are supported.

Use plugin-provided capabilities with --use=<mode>. Example:
  browser-mcp screenshot --url=https://site.com/wp-admin/ --use=wordpress
  (requires BROWSER_MCP_PLUGINS to include a plugin registering the mode)

Examples:
  browser-mcp screenshot --url=https://example.com
  browser-mcp screenshot --url=https://example.com --fullPage=true
  browser-mcp screenshot --url=https://example.com --browsers='["chromium","firefox"]'
  browser-mcp screenshot --url=https://example.com --viewports='[{"width":375,"height":812,"label":"mobile"}]'
  browser-mcp element_screenshot --url=https://example.com --selector="h1"
  browser-mcp console_capture --url=https://example.com --toFile=true
  browser-mcp dom_snapshot --url=https://example.com --maxDepth=3
  browser-mcp visual_diff --imageA=a.png --imageB=b.png
  browser-mcp page_metadata --url=https://example.com
  browser-mcp performance_metrics --url=https://example.com
  browser-mcp computed_styles --url=https://example.com --selector=h1
`);
}

function parseArgs(args: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      i++;
      continue;
    }

    let key: string;
    let value: string;

    if (arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      key = arg.substring(2, eqIdx);
      value = arg.substring(eqIdx + 1);
    } else {
      key = arg.substring(2);
      // Next arg is the value, unless it's another flag or missing
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++;
        value = args[i];
      } else {
        // Boolean flag
        result[key] = true;
        i++;
        continue;
      }
    }

    // Try parsing as JSON for complex values (arrays, objects, numbers, booleans)
    try {
      result[key] = JSON.parse(value);
    } catch {
      result[key] = value;
    }

    i++;
  }

  return result;
}

export async function runCli(args: string[], registry?: PluginRegistry): Promise<void> {
  const toolName = args[0];
  const pluginToolNames = registry?.getTools().map((t) => t.name) ?? [];

  if (toolName === "--help" || toolName === "-h" || toolName === "help") {
    printUsage(pluginToolNames);
    return;
  }

  const isCore = CORE_TOOLS.includes(toolName as (typeof CORE_TOOLS)[number]);
  const isPlugin = pluginToolNames.includes(toolName);

  if (!isCore && !isPlugin) {
    console.error(`Unknown tool: ${toolName}`);
    const allTools = [...CORE_TOOLS, ...pluginToolNames].join(", ");
    console.error(`Available tools: ${allTools}`);
    console.error(`Run with --help for usage.`);
    process.exit(1);
  }

  const params = parseArgs(args.slice(1));

  // Resolve `--use=<mode>` into session hooks and stash them on the tool
  // context so launchSession can pick them up. Same pipeline the MCP
  // server uses for every tool call — lives in resolveModes for parity.
  let sessionHooks;
  try {
    sessionHooks = resolveModes(params.use as UseParam, registry);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
  const toolParams: Record<string, unknown> = stripUse(params as { use?: UseParam });
  // list_modes needs the registry; piggy-back on the params record rather than
  // plumbing it through every tool's signature.
  if (toolName === "list_modes") toolParams._registry = registry;
  const ctx = createToolContext(sessionHooks);

  try {
    const result = await toolContextStorage.run(ctx, () =>
      isCore
        ? runCoreTool(toolName, toolParams)
        : runPluginTool(toolName, toolParams, registry!),
    );

    for (const item of result.content) {
      if (item.type === "text") {
        console.log(item.text);
      } else if (item.type === "image") {
        console.log(`[Image saved — base64 length: ${(item as unknown as { data: string }).data.length}]`);
      }
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function runCoreTool(
  name: string,
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: string; [key: string]: unknown }> }> {
  switch (name) {
    case "screenshot":
      return await screenshotTool(params as any);
    case "element_screenshot":
      return await elementScreenshotTool(params as any);
    case "console_capture":
      return await consoleCaptureTool(params as any);
    case "dom_snapshot":
      return await domSnapshotTool(params as any);
    case "accessibility_snapshot":
      return await accessibilitySnapshotTool(params as any);
    case "visual_diff":
      return await visualDiffTool(params as any);
    case "compare_screenshot":
      return await compareScreenshotTool(params as any);
    case "compare_element":
      return await compareElementTool(params as any);
    case "network_log":
      return await networkLogTool(params as any);
    case "page_metadata":
      return await pageMetadataTool(params as any);
    case "performance_metrics":
      return await performanceMetricsTool(params as any);
    case "computed_styles":
      return await computedStylesTool(params as any);
    case "evaluate_script":
      return await evaluateScriptTool(params as any);
    case "schema_extract":
      return await schemaExtractTool(params as any);
    case "list_modes": {
      // Read-only introspection; the registry is passed down through runCli.
      // Renders the same payload shape as the MCP tool so CLI + MCP stay in sync.
      const registry = (params as { _registry?: PluginRegistry })._registry;
      const modes = registry?.listModes() ?? [];
      if (modes.length === 0) {
        return { content: [{ type: "text", text: "No modes registered. Load plugins via BROWSER_MCP_PLUGINS." }] };
      }
      const payload = modes.map((m) => ({
        name: m.name,
        plugin: m.pluginName,
        description: m.description,
      }));
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
    default:
      throw new Error(`Unknown core tool: ${name}`);
  }
}

async function runPluginTool(
  name: string,
  params: Record<string, unknown>,
  registry: PluginRegistry,
): Promise<{ content: Array<{ type: string; [key: string]: unknown }> }> {
  const tool = registry.getTools().find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown plugin tool: ${name}`);
  }
  return await tool.handler(params);
}

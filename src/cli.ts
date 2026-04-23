import { screenshotTool } from "./core/screenshot.js";
import { elementScreenshotTool } from "./core/element-screenshot.js";
import type { PluginRegistry } from "./plugins/registry.js";
import { resolveModes, stripUse, type UseParam } from "./utils/resolve-modes.js";
import { toolContextStorage, createToolContext } from "./utils/browser.js";

const CORE_TOOLS = ["screenshot", "element_screenshot", "list_modes"] as const;

function printUsage(pluginTools: string[] = []): void {
  const pluginSection =
    pluginTools.length > 0
      ? `\nPlugin tools (enabled via BROWSER_MCP_PLUGINS):\n${pluginTools.map((t) => `  ${t}`).join("\n")}\n`
      : "";

  console.log(`browser-mcp — A real browser for AI agents

Usage:
  browser-mcp <tool> [options]     Run a tool directly
  browser-mcp                      Start as MCP server (stdio)

Core tools:
  screenshot              Take screenshots of a URL
  element_screenshot      Screenshot a specific element
  list_modes              List plugin-provided modes available via --use
${pluginSection}
Options are passed as --key=value or --key value. JSON values are supported.

Plugins:
  dev                   Enables dev tools (evaluate_script, console_capture,
                        network_log, dom_snapshot, accessibility_snapshot,
                        computed_styles, performance_metrics, visual_diff,
                        compare_screenshot, compare_element, schema_extract,
                        page_metadata).
  wp                    WordPress login session; registers the "wordpress" mode
                        for use= in any tool.
  wp-gutenberg          Gutenberg editor workflows (depends on wp).
                        Tools: wp-gutenberg_insert_block, wp-gutenberg_get_blocks, ...

Use plugin-provided modes with --use=<mode>. Example:
  BROWSER_MCP_PLUGINS=wp browser-mcp screenshot --url=https://site.com/wp-admin/ --use=wordpress

Examples:
  browser-mcp screenshot --url=https://example.com
  browser-mcp screenshot --url=https://example.com --fullPage=true
  browser-mcp element_screenshot --url=https://example.com --selector=h1
  BROWSER_MCP_PLUGINS=dev browser-mcp evaluate_script --url=https://example.com --script="return document.title"
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
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i++;
        value = args[i];
      } else {
        result[key] = true;
        i++;
        continue;
      }
    }

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

  let sessionHooks;
  try {
    sessionHooks = resolveModes(params.use as UseParam, registry);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
  const toolParams: Record<string, unknown> = stripUse(params as { use?: UseParam });
  if (toolName === "list_modes") toolParams._registry = registry;
  const ctx = createToolContext(sessionHooks);

  try {
    const result = await toolContextStorage.run(ctx, () =>
      isCore ? runCoreTool(toolName, toolParams) : runPluginTool(toolName, toolParams, registry!),
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
  params: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; [key: string]: unknown }> }> {
  switch (name) {
    case "screenshot":
      return await screenshotTool(params as any);
    case "element_screenshot":
      return await elementScreenshotTool(params as any);
    case "list_modes": {
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
  if (!tool) throw new Error(`Unknown plugin tool: ${name}`);
  return await tool.handler(params);
}

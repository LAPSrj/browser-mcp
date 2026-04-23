#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { runCli } from "./cli.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { loadPlugins } from "./plugins/loader.js";
import { launchSession, closeSession } from "./utils/browser.js";
import { navigateTo } from "./utils/navigate.js";
import { runActions, setCustomActionHandlers } from "./utils/actions.js";
import { saveFile, generateFilename } from "./utils/file.js";
import { resolveUrl } from "./utils/url.js";
import { createPreviewBuffer } from "./utils/resize.js";
import type { CoreUtils } from "./plugins/types.js";
import type { PluginRegistry } from "./plugins/registry.js";

/** Shared bootstrap: load config, load plugins, wire custom action handlers. */
async function bootstrap(): Promise<{ config: ServerConfig; registry: PluginRegistry }> {
  const config = loadConfig();

  const coreUtils: CoreUtils = {
    launchSession,
    closeSession,
    navigateTo,
    runActions,
    saveFile,
    generateFilename,
    resolveUrl,
    createPreviewBuffer,
  };

  const registry = await loadPlugins(config, coreUtils);

  // Make plugin custom actions available to all tools (including core tools)
  const actionHandlers = registry.getActionHandlers();
  if (actionHandlers.size > 0) {
    setCustomActionHandlers(actionHandlers);
  }

  return { config, registry };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    // Direct CLI usage: node dist/index.js <tool> [options]
    // Load plugins so plugin tools (e.g. gutenberg_*) are also runnable via CLI.
    const { registry } = await bootstrap();
    try {
      await runCli(args, registry);
    } finally {
      await registry.destroyAll();
    }
  } else {
    // MCP server mode (default)
    const { config, registry } = await bootstrap();
    const server = createServer(config, registry);

    // Clean up plugins on shutdown
    const cleanup = async () => {
      await registry.destroyAll();
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

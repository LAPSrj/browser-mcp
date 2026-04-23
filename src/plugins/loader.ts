import type { ScreenshotPlugin } from "./types.js";
import type { CoreUtils } from "./types.js";
import type { ServerConfig } from "../config.js";
import { PluginRegistry } from "./registry.js";

/** Built-in plugin map: name → lazy import function. */
const BUILTIN_PLUGINS: Record<string, () => Promise<ScreenshotPlugin>> = {
  gutenberg: async () => {
    const mod = await import("./gutenberg/index.js");
    return mod.default;
  },
};

/**
 * Parse BROWSER_MCP_PLUGINS env var, load each plugin, and return a
 * sealed PluginRegistry ready for use by the server.
 */
export async function loadPlugins(
  serverConfig: ServerConfig,
  coreUtils: CoreUtils,
): Promise<PluginRegistry> {
  const registry = new PluginRegistry();
  const pluginNames = parsePluginEnv();

  for (const name of pluginNames) {
    const factory = BUILTIN_PLUGINS[name];
    if (!factory) {
      const available = Object.keys(BUILTIN_PLUGINS).join(", ");
      throw new Error(
        `Unknown plugin: "${name}". Available plugins: ${available}`
      );
    }

    const plugin = await factory();
    await registry.load(plugin, serverConfig, coreUtils);
  }

  registry.seal();
  return registry;
}

function parsePluginEnv(): string[] {
  const raw = process.env.BROWSER_MCP_PLUGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

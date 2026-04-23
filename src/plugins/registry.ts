import type {
  ScreenshotPlugin,
  PluginToolDefinition,
  CustomActionHandler,
  SessionHook,
  PluginContext,
  CoreUtils,
  ResolvedPluginConfig,
} from "./types.js";
import type { ServerConfig } from "../config.js";

const CORE_ACTION_TYPES = new Set([
  "click", "type", "wait_for_selector", "wait",
  "scroll_to", "evaluate", "hover", "select",
]);

interface LoadedPlugin {
  plugin: ScreenshotPlugin;
  config: ResolvedPluginConfig;
}

export interface ModeInfo {
  name: string;
  pluginName: string;
  description: string | null;
  hooks: SessionHook[];
}

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();
  private tools = new Map<string, PluginToolDefinition>();
  private actions = new Map<string, CustomActionHandler>();
  private sessionHooks: SessionHook[] = [];
  private modes = new Map<string, ModeInfo>();
  private skipped = new Map<string, string>();
  private sealed = false;

  /**
   * Load, validate, and register a single plugin. Plugins missing required
   * env vars are skipped (warning to stderr) instead of throwing — one
   * mis-configured optional plugin shouldn't take down the whole server.
   */
  async load(
    plugin: ScreenshotPlugin,
    serverConfig: ServerConfig,
    coreUtils: CoreUtils,
  ): Promise<void> {
    if (this.sealed) {
      throw new Error("Cannot load plugins after the registry has been sealed.");
    }

    const { name } = plugin;

    if (this.plugins.has(name)) {
      throw new Error(`Plugin name collision: "${name}" is already registered.`);
    }

    if (plugin.dependencies && plugin.dependencies.length > 0) {
      // Cascade skip: a dependency that was skipped (e.g. missing env vars)
      // should propagate, not error out.
      const skippedDeps = plugin.dependencies.filter((dep) => this.skipped.has(dep));
      if (skippedDeps.length > 0) {
        const reason = `dependency skipped: ${skippedDeps.map((d) => `"${d}"`).join(", ")}`;
        this.skipped.set(name, reason);
        console.error(`[browser-mcp] Skipping plugin "${name}" — ${reason}`);
        return;
      }
      // Hard error: dependency was never declared in BROWSER_MCP_PLUGINS.
      const missingDeps = plugin.dependencies.filter((dep) => !this.plugins.has(dep));
      if (missingDeps.length > 0) {
        throw new Error(
          `Plugin "${name}" depends on plugin(s) that haven't been loaded: ` +
          missingDeps.map((m) => `"${m}"`).join(", ") +
          `. Add them to BROWSER_MCP_PLUGINS before "${name}" ` +
          `(e.g. BROWSER_MCP_PLUGINS=${[...missingDeps, name].join(",")}).`
        );
      }
    }

    // Resolve and validate config from env vars
    const schema = plugin.getConfigSchema();
    const resolved: ResolvedPluginConfig = {};
    const missingEnv: string[] = [];

    for (const [key, entry] of Object.entries(schema)) {
      const value = process.env[entry.envVar] ?? entry.default;
      if (value !== undefined) {
        resolved[key] = value;
      } else if (entry.required) {
        missingEnv.push(`${entry.envVar} (${entry.description})`);
      }
    }

    if (missingEnv.length > 0) {
      const varList = missingEnv.map((m) => m.split(" ")[0]).join(", ");
      this.skipped.set(name, `missing env: ${varList}`);
      console.error(
        `[browser-mcp] Skipping plugin "${name}" — missing required environment variables:\n` +
        missingEnv.map((m) => `  - ${m}`).join("\n") +
        `\nSet them or remove "${name}" from BROWSER_MCP_PLUGINS to silence this warning.`
      );
      return;
    }

    const prefixTools = plugin.prefixTools !== false;

    // Build the plugin context with scoped registration methods
    const ctx: PluginContext = {
      registerTool: (def) => this.addTool(name, def, prefixTools),
      registerAction: (type, handler) => this.addAction(name, type, handler),
      registerSessionHook: (hook) => this.addSessionHook(hook),
      registerMode: (modeName, hooks, description) => this.addMode(name, modeName, hooks, description),
      core: coreUtils,
      config: serverConfig,
    };

    await plugin.register(ctx, resolved);
    this.plugins.set(name, { plugin, config: resolved });
  }

  /** Seal the registry — no more registrations allowed. */
  seal(): void {
    this.sealed = true;
  }

  /** Get all registered plugin tools (namespaced). */
  getTools(): PluginToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Look up a custom action handler by type. Returns undefined for core types. */
  getActionHandler(type: string): CustomActionHandler | undefined {
    return this.actions.get(type);
  }

  /** Get all custom action handlers as a Map (for passing to runActions). */
  getActionHandlers(): Map<string, CustomActionHandler> {
    return new Map(this.actions);
  }

  /** Get all registered session hooks. */
  getSessionHooks(): SessionHook[] {
    return [...this.sessionHooks];
  }

  /** Look up a mode by name. */
  getMode(name: string): ModeInfo | undefined {
    return this.modes.get(name);
  }

  /** Get all registered modes (for discovery via list_modes). */
  listModes(): ModeInfo[] {
    return Array.from(this.modes.values());
  }

  /** Call destroy() on all plugins. */
  async destroyAll(): Promise<void> {
    for (const { plugin } of this.plugins.values()) {
      if (plugin.destroy) {
        try {
          await plugin.destroy();
        } catch {
          // ignore cleanup errors
        }
      }
    }
    this.plugins.clear();
    this.tools.clear();
    this.actions.clear();
    this.sessionHooks = [];
    this.modes.clear();
    this.skipped.clear();
    this.sealed = false;
  }

  // ----- private registration helpers -----

  private addTool(pluginName: string, def: PluginToolDefinition, prefix: boolean): void {
    const finalName = prefix ? `${pluginName}_${def.name}` : def.name;
    if (this.tools.has(finalName)) {
      throw new Error(
        `Plugin "${pluginName}" tried to register tool "${def.name}" ` +
        `but "${finalName}" is already registered.`
      );
    }
    this.tools.set(finalName, {
      ...def,
      name: finalName,
    });
  }

  private addAction(pluginName: string, type: string, handler: CustomActionHandler): void {
    if (CORE_ACTION_TYPES.has(type)) {
      throw new Error(
        `Plugin "${pluginName}" tried to register action "${type}" ` +
        `which conflicts with a core action type.`
      );
    }
    if (this.actions.has(type)) {
      throw new Error(
        `Plugin "${pluginName}" tried to register action "${type}" ` +
        `which is already registered by another plugin.`
      );
    }
    this.actions.set(type, handler);
  }

  private addSessionHook(hook: SessionHook): void {
    this.sessionHooks.push(hook);
  }

  private addMode(
    pluginName: string,
    modeName: string,
    hooks: SessionHook[],
    description?: string,
  ): void {
    if (this.modes.has(modeName)) {
      const existing = this.modes.get(modeName)!;
      throw new Error(
        `Plugin "${pluginName}" tried to register mode "${modeName}" ` +
        `which is already registered by plugin "${existing.pluginName}".`
      );
    }
    this.modes.set(modeName, {
      name: modeName,
      pluginName,
      description: description ?? null,
      hooks: [...hooks],
    });
  }
}

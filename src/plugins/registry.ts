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
  private sealed = false;

  /**
   * Load, validate, and register a single plugin.
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

    // Resolve and validate config from env vars
    const schema = plugin.getConfigSchema();
    const resolved: ResolvedPluginConfig = {};
    const missing: string[] = [];

    for (const [key, entry] of Object.entries(schema)) {
      const value = process.env[entry.envVar] ?? entry.default;
      if (value !== undefined) {
        resolved[key] = value;
      } else if (entry.required) {
        missing.push(`${entry.envVar} (${entry.description})`);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Plugin "${name}" requires missing environment variables:\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        `\nSet them or remove "${name}" from BROWSER_MCP_PLUGINS.`
      );
    }

    // Build the plugin context with scoped registration methods
    const ctx: PluginContext = {
      registerTool: (def) => this.addTool(name, def),
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
    this.sealed = false;
  }

  // ----- private registration helpers -----

  private addTool(pluginName: string, def: PluginToolDefinition): void {
    const namespacedName = `${pluginName}_${def.name}`;
    if (this.tools.has(namespacedName)) {
      throw new Error(
        `Plugin "${pluginName}" tried to register tool "${def.name}" ` +
        `but "${namespacedName}" is already registered.`
      );
    }
    this.tools.set(namespacedName, {
      ...def,
      name: namespacedName,
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

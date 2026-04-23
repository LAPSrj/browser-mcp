import type { BrowserContext, Page } from "playwright";
import type { ServerConfig } from "../config.js";
import type { BrowserSession, LaunchOptions } from "../utils/browser.js";
import type { AnyAction, ActionStopResult } from "../utils/actions.js";

// ---------------------------------------------------------------------------
// Tool response — matches the MCP content format used by all core tools
// ---------------------------------------------------------------------------

export interface ToolContent {
  type: string;
  [key: string]: unknown;
}

export interface ToolResponse {
  content: ToolContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Plugin tool definition — what a plugin registers as a new MCP tool
// ---------------------------------------------------------------------------

export interface PluginToolDefinition {
  /** Tool name without plugin prefix (prefix is added automatically). */
  name: string;
  description: string;
  /** Zod shape object: Record<string, ZodType> — same format as core tool schemas. */
  schema: Record<string, unknown>;
  handler: (params: any) => Promise<ToolResponse>;
}

// ---------------------------------------------------------------------------
// Custom action handler — extends the actions system
// ---------------------------------------------------------------------------

export type CustomActionHandler = (
  page: Page,
  params: Record<string, unknown>,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Session hook — runs after browser context + page are created
// ---------------------------------------------------------------------------

export type SessionHook = (
  context: BrowserContext,
  page: Page,
  toolName: string,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Core utilities exposed to plugins via PluginContext
// ---------------------------------------------------------------------------

export interface CoreUtils {
  launchSession(opts: LaunchOptions & {
    storageState?: object;
    sessionHooks?: SessionHook[];
    toolName?: string;
  }): Promise<BrowserSession>;
  closeSession(session: BrowserSession): Promise<void>;
  navigateTo(page: Page, url: string, waitForNetworkIdle?: boolean): Promise<void>;
  runActions(
    page: Page,
    actions: AnyAction[],
    customActionHandlers?: Map<string, CustomActionHandler>,
  ): Promise<{ stoppedAt?: ActionStopResult }>;
  saveFile(path: string, data: Buffer | string): Promise<string>;
  generateFilename(parts: {
    prefix?: string;
    browser?: string;
    viewport?: string;
    extension: string;
  }): string;
  resolveUrl(url: string, baseUrl?: string): string;
  createPreviewBuffer(pngBuffer: Buffer): Buffer;
}

// ---------------------------------------------------------------------------
// PluginContext — what a plugin receives in register() to declare its features
// ---------------------------------------------------------------------------

export interface PluginContext {
  /** Register a new MCP tool. Name will be prefixed with the plugin name. */
  registerTool(def: PluginToolDefinition): void;

  /** Register a custom action type usable in any tool's actions[] array. */
  registerAction(type: string, handler: CustomActionHandler): void;

  /** Register a session hook that runs after context creation, before navigation. */
  registerSessionHook(hook: SessionHook): void;

  /**
   * Register a named mode: a bundle of session hooks that any core tool can
   * opt into via the `use` param (e.g. `use: "wordpress"` applies the
   * Gutenberg plugin's WP auth cookie to a core tool call).
   *
   * `description` is surfaced by the `list_modes` tool so agents can
   * discover what each mode does without consulting the README.
   */
  registerMode(name: string, hooks: SessionHook[], description?: string): void;

  /** Core utilities the plugin can use to launch browsers, save files, etc. */
  core: CoreUtils;

  /** The server configuration (baseUrl, outputDir, etc.). */
  config: ServerConfig;
}

// ---------------------------------------------------------------------------
// ScreenshotPlugin — the interface every plugin must implement
// ---------------------------------------------------------------------------

export interface ScreenshotPlugin {
  /** Unique plugin name, used as the tool prefix (e.g. "gutenberg"). */
  name: string;
  version: string;

  /**
   * Return the env var requirements for this plugin.
   * Keys are friendly config names, values describe the env var binding.
   */
  getConfigSchema(): PluginConfigSchema;

  /**
   * Called once after config is validated and resolved.
   * The plugin uses ctx to register tools, actions, and session hooks.
   */
  register(ctx: PluginContext, resolvedConfig: ResolvedPluginConfig): void | Promise<void>;

  /** Called on server shutdown. Clean up any cached state. */
  destroy?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Plugin configuration
// ---------------------------------------------------------------------------

export interface PluginConfigEntry {
  envVar: string;
  required: boolean;
  description: string;
  default?: string;
}

export type PluginConfigSchema = Record<string, PluginConfigEntry>;

/** The resolved config: same keys as the schema, but with actual string values. */
export type ResolvedPluginConfig = Record<string, string>;

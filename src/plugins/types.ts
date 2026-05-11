import type { BrowserContext, Page } from "playwright";
import type { ServerConfig } from "../config.js";
import type { BrowserSession, LaunchOptions } from "../utils/browser.js";
import type { AnyAction, ActionStopResult } from "../utils/actions.js";
import type { SessionInfo } from "../core/sessions.js";

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
  /**
   * Optional in-band warnings surfaced to the caller without changing the
   * primary content stream. Plugins use this to nudge agents toward better
   * usage patterns (e.g. wp-gutenberg flags ephemeral runs when persistent
   * sessions are open) without breaking response parsers.
   */
  _warnings?: string[];
}

// ---------------------------------------------------------------------------
// Plugin tool definition — what a plugin registers as a new MCP tool
// ---------------------------------------------------------------------------

export interface PluginToolDefinition {
  /**
   * Tool name. By default the plugin name is prepended automatically
   * (e.g. plugin "wp-gutenberg" + name "insert_block" → "wp-gutenberg_insert_block").
   * A plugin can set ScreenshotPlugin.prefixTools = false to register
   * unprefixed tool names (used by the built-in `dev` plugin so agents
   * call e.g. `evaluate_script` rather than `dev_evaluate_script`).
   */
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
  /**
   * Look up the active page for a persistent session opened via the
   * top-level `open_session` tool. Plugins use this to opt into the
   * sessionManager-owned lifecycle when a caller passes session_id, rather
   * than spinning a per-call ephemeral browser via launchSession. Throws if
   * the session isn't found or has been closed. Touches the session so its
   * idle TTL doesn't expire mid-call.
   */
  getSessionPage(session_id: string, tab_id?: string): Page;
  /** List currently-open persistent sessions (sessionManager-owned). */
  listSessions(): SessionInfo[];
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
  /** Unique plugin name, used as the tool prefix (e.g. "wp-gutenberg"). */
  name: string;
  version: string;

  /**
   * Other plugins that must be loaded first. Loader enforces this — if a
   * user enables wp-gutenberg without wp, load fails with a clear error.
   */
  dependencies?: string[];

  /**
   * When false, tools registered through ctx.registerTool() keep their
   * declared names instead of being namespaced by plugin name. Used by
   * the built-in `dev` plugin to preserve short, well-known tool names
   * (evaluate_script, console_capture, …) without the `dev_` prefix.
   * Default: true.
   */
  prefixTools?: boolean;

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

import type {
  ScreenshotPlugin,
  PluginContext,
  PluginConfigSchema,
  ResolvedPluginConfig,
} from "../types.js";
import { WP_CONFIG_SCHEMA } from "./config.js";
import { WpAuth, setSharedWpAuth } from "./auth.js";
import type { BrowserContext, Page } from "playwright";

// wp: foundation plugin for any WordPress-backed workflow. Owns the
// wp-login.php session: caches it, injects it into contexts that opt in
// via use:"wordpress". Exposes no tools itself — site-specific workflows
// live in sibling plugins (wp-gutenberg, etc.) that depend on wp.
const wpPlugin: ScreenshotPlugin = {
  name: "wp",
  version: "0.1.0",

  getConfigSchema(): PluginConfigSchema {
    return WP_CONFIG_SCHEMA;
  },

  async register(ctx: PluginContext, resolvedConfig: ResolvedPluginConfig): Promise<void> {
    const auth = new WpAuth(resolvedConfig);
    setSharedWpAuth(auth);

    // Session hook: inject cached auth cookies into the new browser context.
    // If no cache exists (first use), perform a fresh login — but only when
    // credentials are configured. Otherwise we trust whatever cookies the
    // context already carries (e.g. a manually-authenticated persistent session).
    const authHook = async (context: BrowserContext, page: Page, _toolName: string) => {
      const injected = await auth.injectAuth(context);
      if (!injected && auth.canAutoLogin()) {
        await auth.getStorageState(page);
        await auth.injectAuth(context);
      }
    };

    ctx.registerMode(
      "wordpress",
      [authHook],
      "Authenticated WordPress session — injects the cached wp-admin cookie " +
        "into the browser context. Unlocks /wp-admin/* pages, authenticated " +
        "REST endpoints, and post preview URLs for any tool. Requires WP_URL / " +
        "WP_USERNAME / WP_PASSWORD env vars.",
    );
  },

  async destroy(): Promise<void> {
    // No persistent state to clean up — WpAuth caches in-memory only.
  },
};

export default wpPlugin;

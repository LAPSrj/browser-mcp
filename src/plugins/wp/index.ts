import type {
  ScreenshotPlugin,
  PluginContext,
  PluginConfigSchema,
  SessionHook,
} from "../types.js";
import { WP_CONFIG_SCHEMA, loadWpSiteConfigs } from "./config.js";
import { WpSites, createWpSite, setSharedWpSites, siteAuthHook } from "./sites.js";

// wp: foundation plugin for any WordPress-backed workflow. Owns the
// wp-login.php sessions (one per configured site): caches them, injects them
// into contexts that opt in via use:"wordpress" or use:"wordpress:<site>".
// Exposes no tools itself — site-specific workflows live in sibling plugins
// (wp-gutenberg, etc.) that depend on wp.
const wpPlugin: ScreenshotPlugin = {
  name: "wp",
  version: "0.1.0",

  getConfigSchema(): PluginConfigSchema {
    return WP_CONFIG_SCHEMA;
  },

  checkConfig(): string | null {
    try {
      loadWpSiteConfigs(process.env);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  },

  async register(ctx: PluginContext): Promise<void> {
    if (process.env.WP_SITES?.trim() && process.env.WP_URL?.trim()) {
      console.error(
        "[browser-mcp] WP_SITES is set, so WP_URL / WP_USERNAME / WP_PASSWORD are ignored. " +
        "Configure each site with WP_URL_<NAME> etc.",
      );
    }
    const sites = new WpSites(loadWpSiteConfigs(process.env).map(createWpSite));
    setSharedWpSites(sites);

    const siteList = sites.list.map((s) => `${s.name} (${s.url})`).join(", ");

    // Default mode: the site comes from the call's url param — the site a
    // full URL belongs to, or the first site for a relative URL / no URL.
    const autoSiteHook: SessionHook = async (context, page, toolName, targetUrl) =>
      siteAuthHook(sites.forCallUrl(targetUrl))(context, page, toolName, targetUrl);

    ctx.registerMode(
      "wordpress",
      [autoSiteHook],
      "Authenticated WordPress session — injects the cached wp-admin cookie " +
        "into the browser context. Unlocks /wp-admin/* pages, authenticated " +
        "REST endpoints, and post preview URLs for any tool. Picks the site the " +
        "call's full url belongs to, or the first site for a relative url. " +
        `Sites: ${siteList}.`,
    );

    for (const site of sites.list) {
      ctx.registerMode(
        `wordpress:${site.name}`,
        [siteAuthHook(site)],
        `Authenticated WordPress session for ${site.name} (${site.url}), whatever the call's url.`,
      );
    }
  },

  async destroy(): Promise<void> {
    // No persistent state to clean up — WpAuth caches in-memory only.
  },
};

export default wpPlugin;

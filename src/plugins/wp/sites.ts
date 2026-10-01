import type { SessionHook } from "../types.js";
import { isAbsoluteUrl } from "../../utils/url.js";
import { WpAuth } from "./auth.js";
import type { WpSiteConfig } from "./config.js";

/** A configured WordPress site with its own cached login. */
export interface WpSite {
  /** Name as written in WP_SITES, or "default" for the unsuffixed WP_URL site. */
  name: string;
  /** Site URL without a trailing slash. */
  url: string;
  auth: WpAuth;
  /** WP_REQUIRE_ALLOW_WRITE<suffix>: saving needs allow_write: true. */
  requireAllowWrite: boolean;
  /** Suffix on this site's env var names ("_PROD", or "" for WP_URL). */
  envSuffix: string;
}

export function createWpSite(config: WpSiteConfig): WpSite {
  return {
    name: config.name,
    url: config.wpUrl,
    auth: new WpAuth(config),
    requireAllowWrite: config.requireAllowWrite,
    envSuffix: config.envSuffix,
  };
}

export class WpSites {
  constructor(readonly list: WpSite[]) {
    if (list.length === 0) throw new Error("WpSites needs at least one site.");
  }

  /** The first site in WP_SITES (or the only site). */
  get first(): WpSite {
    return this.list[0];
  }

  private names(): string {
    return this.list.map((s) => s.name).join(", ");
  }

  /** Look up a site by name, ignoring case. Throws listing the configured names. */
  byName(name: string): WpSite {
    const site = this.list.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!site) {
      throw new Error(`Unknown WordPress site "${name}". Configured sites: ${this.names()}.`);
    }
    return site;
  }

  /**
   * The site an absolute URL belongs to: same host (and port), with the URL's
   * path at or under the site's path. When sites share a host (subdirectory
   * installs), the longest site path wins. Undefined when no site matches.
   */
  forUrl(url: string): WpSite | undefined {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return undefined;
    }
    let best: WpSite | undefined;
    let bestLength = -1;
    for (const site of this.list) {
      const siteUrl = new URL(site.url);
      if (siteUrl.host !== target.host) continue;
      const base = siteUrl.pathname.replace(/\/+$/, "");
      if (target.pathname !== base && !target.pathname.startsWith(`${base}/`)) continue;
      if (base.length > bestLength) {
        best = site;
        bestLength = base.length;
      }
    }
    return best;
  }

  /**
   * The site for a call's raw `url` param: the site a full URL belongs to,
   * or the first site for a relative URL or no URL. Throws when a full URL
   * belongs to no configured site.
   */
  forCallUrl(url?: string): WpSite {
    if (!url || !isAbsoluteUrl(url)) return this.first;
    const site = this.forUrl(url);
    if (!site) {
      throw new Error(
        `use: "wordpress" can't pick a site for ${url}: it isn't under any configured WordPress site ` +
        `(${this.list.map((s) => `${s.name} = ${s.url}`).join(", ")}).`,
      );
    }
    return site;
  }
}

/**
 * Session hook that injects the site's cached login cookies, logging in
 * first when nothing is cached. Without credentials it trusts whatever
 * cookies the context already carries (e.g. a manually-authenticated
 * persistent session).
 */
export function siteAuthHook(site: WpSite): SessionHook {
  return async (context, page) => {
    const injected = await site.auth.injectAuth(context);
    if (!injected && site.auth.canAutoLogin()) {
      await site.auth.getStorageState(page);
      await site.auth.injectAuth(context);
    }
  };
}

/**
 * Throw when the site requires allow_write and the call didn't pass it.
 * `action` completes "requires allow_write: true to …".
 */
export function assertCanWrite(site: WpSite, allowWrite: boolean | undefined, action: string): void {
  if (site.requireAllowWrite && allowWrite !== true) {
    throw new Error(
      `WordPress site "${site.name}" (${site.url}) requires allow_write: true to ${action}, ` +
      `because WP_REQUIRE_ALLOW_WRITE${site.envSuffix} is set. Nothing was saved.`,
    );
  }
}

// Shared site list. The wp plugin installs it on register() so wp-gutenberg
// (and any future wp-* plugin) reuses the same cached logins without
// logging in twice.
let sharedSites: WpSites | null = null;

export function setSharedWpSites(sites: WpSites): void {
  sharedSites = sites;
}

export function getSharedWpSites(): WpSites {
  if (!sharedSites) {
    throw new Error(
      "WordPress sites are not initialized. Ensure BROWSER_MCP_PLUGINS includes " +
      '"wp" before any plugin that depends on it (e.g. wp-gutenberg).',
    );
  }
  return sharedSites;
}

/** The configured site an absolute URL belongs to; undefined if none or wp isn't loaded. */
export function findWpSiteForUrl(url: string): WpSite | undefined {
  return sharedSites?.forUrl(url);
}

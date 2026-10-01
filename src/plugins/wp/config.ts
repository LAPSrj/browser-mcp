import type { PluginConfigSchema } from "../types.js";

export const WP_CONFIG_SCHEMA: PluginConfigSchema = {
  wpSites: {
    envVar: "WP_SITES",
    required: false,
    description:
      "Comma-separated site names for several WordPress sites (e.g. LOCAL,PROD). Each name reads " +
      "WP_URL_<NAME>, WP_USERNAME_<NAME>, WP_PASSWORD_<NAME>, and optionally WP_LOGIN_URL_<NAME>, " +
      "WP_SESSION_TTL_<NAME>, WP_REQUIRE_ALLOW_WRITE_<NAME>. When set, the unsuffixed WP_URL set is ignored.",
  },
  wpUrl: {
    envVar: "WP_URL",
    required: false,
    description: "WordPress site URL (e.g. https://mysite.com). Single-site setup; set this or WP_SITES",
  },
  wpUsername: {
    envVar: "WP_USERNAME",
    required: false,
    description: "WordPress username for auto-login (omit if relying on a manually-authenticated persistent session)",
  },
  wpPassword: {
    envVar: "WP_PASSWORD",
    required: false,
    description: "WordPress password for auto-login (omit if relying on a manually-authenticated persistent session)",
  },
  wpLoginUrl: {
    envVar: "WP_LOGIN_URL",
    required: false,
    description: "Custom login URL (default: {WP_URL}/wp-login.php)",
  },
  wpSessionTtl: {
    envVar: "WP_SESSION_TTL",
    required: false,
    description: "Max seconds to cache the login session (default: 3600). Also the default for WP_SESSION_TTL_<NAME>",
    default: "3600",
  },
  wpRequireAllowWrite: {
    envVar: "WP_REQUIRE_ALLOW_WRITE",
    required: false,
    description:
      "When true, wp-gutenberg tools refuse to save posts on this site unless the call passes " +
      "allow_write: true (default: false). Per site: WP_REQUIRE_ALLOW_WRITE_<NAME>",
  },
};

/** One WordPress site's settings, read from the env. */
export interface WpSiteConfig {
  /** Name as written in WP_SITES, or "default" for the unsuffixed WP_URL site. */
  name: string;
  /** Suffix on this site's env var names: "_PROD", or "" for the WP_URL site. */
  envSuffix: string;
  wpUrl: string;
  wpUsername?: string;
  wpPassword?: string;
  wpLoginUrl?: string;
  wpSessionTtl: string;
  requireAllowWrite: boolean;
}

const SITE_NAME = /^[A-Za-z0-9_]+$/;

function isTrue(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function readSite(env: NodeJS.ProcessEnv, name: string, envSuffix: string): WpSiteConfig {
  const urlVar = `WP_URL${envSuffix}`;
  const rawUrl = env[urlVar]?.trim();
  if (!rawUrl) {
    throw new Error(`${urlVar} is not set${envSuffix ? ` (WP_SITES lists "${name}")` : ""}.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${urlVar} is not a valid URL: "${rawUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${urlVar} must be an http(s) URL: "${rawUrl}".`);
  }
  return {
    name,
    envSuffix,
    wpUrl: rawUrl.replace(/\/+$/, ""),
    wpUsername: env[`WP_USERNAME${envSuffix}`],
    wpPassword: env[`WP_PASSWORD${envSuffix}`],
    wpLoginUrl: env[`WP_LOGIN_URL${envSuffix}`],
    wpSessionTtl: env[`WP_SESSION_TTL${envSuffix}`] ?? env.WP_SESSION_TTL ?? "3600",
    requireAllowWrite: isTrue(env[`WP_REQUIRE_ALLOW_WRITE${envSuffix}`]),
  };
}

/**
 * Read the configured WordPress sites from the env. With WP_SITES=LOCAL,PROD
 * each site reads its own suffixed vars (WP_URL_LOCAL, WP_PASSWORD_PROD, …),
 * so passwords never have to be split out of a shared list. Without WP_SITES,
 * the unsuffixed WP_URL set is the only site, named "default".
 *
 * Throws with a message naming the bad or missing var.
 */
export function loadWpSiteConfigs(env: NodeJS.ProcessEnv): WpSiteConfig[] {
  const rawSites = env.WP_SITES?.trim();
  if (!rawSites) {
    if (!env.WP_URL?.trim()) {
      throw new Error("Set WP_URL for one WordPress site, or WP_SITES for several.");
    }
    return [readSite(env, "default", "")];
  }

  const names = rawSites.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const seen = new Set<string>();
  for (const name of names) {
    if (!SITE_NAME.test(name)) {
      throw new Error(`WP_SITES name "${name}" may only contain letters, digits and underscores.`);
    }
    if (seen.has(name.toLowerCase())) {
      throw new Error(`WP_SITES lists "${name}" more than once.`);
    }
    seen.add(name.toLowerCase());
  }

  const sites = names.map((name) => readSite(env, name, `_${name}`));
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      if (sites[i].wpUrl === sites[j].wpUrl) {
        throw new Error(`WP_SITES "${sites[i].name}" and "${sites[j].name}" have the same URL (${sites[i].wpUrl}).`);
      }
    }
  }
  return sites;
}

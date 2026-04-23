import type { PluginConfigSchema } from "../types.js";

export const GUTENBERG_CONFIG_SCHEMA: PluginConfigSchema = {
  wpUrl: {
    envVar: "WP_URL",
    required: true,
    description: "WordPress site URL (e.g. https://mysite.com)",
  },
  wpUsername: {
    envVar: "WP_USERNAME",
    required: true,
    description: "WordPress username for login",
  },
  wpPassword: {
    envVar: "WP_PASSWORD",
    required: true,
    description: "WordPress password for login",
  },
  wpLoginUrl: {
    envVar: "WP_LOGIN_URL",
    required: false,
    description: "Custom login URL (default: {WP_URL}/wp-login.php)",
  },
  wpSessionTtl: {
    envVar: "WP_SESSION_TTL",
    required: false,
    description: "Max seconds to cache the login session (default: 3600)",
    default: "3600",
  },
};

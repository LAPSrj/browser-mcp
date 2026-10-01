import type { CoreUtils } from "../../types.js";
import type { WpSite, WpSites } from "../../wp/sites.js";

/**
 * Pick the WordPress site for a wp-gutenberg tool call: the `site` param
 * when given; otherwise the site of the persistent session's current page;
 * otherwise the first configured site.
 */
export function resolveToolSite(
  core: CoreUtils,
  sites: WpSites,
  params: { site?: string; session_id?: string },
): WpSite {
  if (params.site) return sites.byName(params.site);
  if (params.session_id) {
    const site = sites.forUrl(core.getSessionPage(params.session_id).url());
    if (site) return site;
  }
  return sites.first;
}

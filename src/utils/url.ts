/**
 * True when the URL has a scheme (http:, data:, file:, about:, chrome:, blob:…).
 * A digit after the colon means host:port (e.g. "localhost:3000/x"), not a scheme.
 */
export function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(url);
}

/**
 * Resolve a URL that may be relative against a base URL.
 * If the URL is already absolute (has a protocol), it is returned as-is.
 * If a baseUrl is configured and the URL is relative, it is resolved against the base.
 * Throws if the URL is relative and no baseUrl is configured.
 */
export function resolveUrl(url: string, baseUrl?: string): string {
  if (isAbsoluteUrl(url)) {
    return url;
  }

  if (!baseUrl) {
    throw new Error(
      `Relative URL "${url}" was provided but no base URL is configured. ` +
      `Set the BROWSER_MCP_BASE_URL environment variable or provide an absolute URL.`
    );
  }

  // Ensure the relative path starts with /
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${baseUrl}${path}`;
}

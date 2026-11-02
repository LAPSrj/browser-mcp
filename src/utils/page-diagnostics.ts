import type { Page } from "playwright";

export interface PageDiagnostic {
  type: "browser-error" | "http-error" | "blank-page";
  message: string;
  errorCode?: string;
}

const CHROMIUM_ERROR_HINTS: Record<string, string> = {
  ERR_CERT_AUTHORITY_INVALID:
    "Self-signed or untrusted certificate. For local dev servers, use HTTP instead of HTTPS, or open a persistent session with ignore_https_errors:true.",
  ERR_CERT_COMMON_NAME_INVALID:
    "Certificate hostname mismatch. Verify the URL matches the certificate's domain, or use ignore_https_errors:true.",
  ERR_SSL_PROTOCOL_ERROR:
    "SSL/TLS protocol error. The server may not support HTTPS — try HTTP.",
  ERR_NAME_NOT_RESOLVED:
    "DNS lookup failed — the hostname does not resolve. Check the URL for typos or verify the DNS entry exists.",
  ERR_CONNECTION_REFUSED:
    "Connection refused — no server is listening on this host:port. Verify the server is running and the port is correct.",
  ERR_CONNECTION_TIMED_OUT:
    "Connection timed out — the server did not respond. Check that it is reachable from this machine.",
  ERR_INTERNET_DISCONNECTED:
    "No internet connection available.",
  ERR_ADDRESS_UNREACHABLE:
    "Address unreachable from this network.",
  ERR_ABORTED:
    "Navigation aborted — the page load was cancelled (redirect loop, mixed-content block, or extension interference).",
  ERR_TOO_MANY_REDIRECTS:
    "Too many redirects — the server is stuck in a redirect loop.",
  ERR_HTTP2_PROTOCOL_ERROR:
    "The server reset the HTTP/2 connection before sending a response. Some CDN bot protection does this to headless browsers; compare with curl from this machine.",
  ERR_CONNECTION_RESET:
    "The server reset the connection before sending a response.",
};

function errorCodeIn(text: string | null | undefined): string | undefined {
  return text?.match(/\b(ERR_[A-Z0-9_]+)\b/)?.[1];
}

function messageFor(errorCode: string): string {
  return `${errorCode}: ${CHROMIUM_ERROR_HINTS[errorCode] ?? "browser navigation error."}`;
}

/** gotoError is page.goto's error message; headless Chromium's error page has an empty body, so it's often the only source of the net::ERR_* code. */
export async function diagnosePageErrors(
  page: Page,
  httpStatus: number | null = null,
  gotoError?: string,
): Promise<PageDiagnostic | null> {
  const url = page.url();

  if (url === "chrome-error://chromewebdata/" || url.startsWith("chrome-error://")) {
    let errorCode = errorCodeIn(gotoError);
    if (!errorCode) {
      try {
        errorCode = errorCodeIn(await page.textContent("body", { timeout: 2000 }));
      } catch {
        // page may not be ready
      }
    }
    const message = errorCode
      ? messageFor(errorCode)
      : "The browser could not load this page (Chrome error screen).";
    return { type: "browser-error", message, errorCode };
  }

  if (url.startsWith("about:neterror")) {
    return {
      type: "browser-error",
      message: "Firefox could not load this page — check the URL and server availability.",
    };
  }

  if (url === "about:blank") {
    const errorCode = errorCodeIn(gotoError);
    if (errorCode) return { type: "browser-error", message: messageFor(errorCode), errorCode };
    return {
      type: "blank-page",
      message: gotoError
        ? `Page is about:blank — navigation failed: ${gotoError.split("\n")[0]}`
        : "Page is about:blank — navigation may have failed silently.",
    };
  }

  if (httpStatus !== null && httpStatus >= 500) {
    return {
      type: "http-error",
      message: `HTTP ${httpStatus} — server error. The server returned an internal error.`,
    };
  }

  if (httpStatus !== null && httpStatus >= 400) {
    return {
      type: "http-error",
      message: `HTTP ${httpStatus} — client error. The requested resource was not found or access was denied.`,
    };
  }

  return null;
}

export function formatDiagnostic(d: PageDiagnostic): string {
  return `⚠ PAGE ERROR: ${d.message}`;
}

import type { Page, Request, Response } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, pickBrowserStack, type BrowserStackTarget, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { formatDiagnostic } from "../../../utils/page-diagnostics.js";
import { sessionManager } from "../../../core/sessions.js";

export interface NetworkLogParams extends BrowserStackTarget {
  url?: string;
  session_id?: string;
  tab_id?: string;
  actions?: AnyAction[];
  filterUrl?: string;
  useBrowserStack?: boolean;
  summaryOnly?: boolean;
}

interface NetworkEntry {
  url: string;
  method: string;
  status: number | null;
  contentType: string | null;
  duration: number | null;
  /** Set when no response arrived, e.g. "net::ERR_HTTP2_PROTOCOL_ERROR". */
  failure?: string;
}

export async function networkLogTool(params: NetworkLogParams) {
  const {
    url,
    session_id,
    tab_id,
    actions = [],
    filterUrl,
    useBrowserStack = false,
    summaryOnly = false,
  } = params;

  if (!session_id && !url) {
    return {
      content: [{ type: "text" as const, text: "url is required when session_id is not provided" }],
      isError: true,
    };
  }

  let urlFilter: RegExp | null = null;
  if (filterUrl) {
    try {
      urlFilter = new RegExp(filterUrl);
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Invalid filterUrl regex: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }

  let page: Page;
  let cleanup: (() => Promise<void>) | null = null;

  if (session_id) {
    sessionManager.touch(session_id);
    page = sessionManager.getPage(session_id, tab_id);
  } else {
    const session = await launchSession({
      browser: "chromium" as BrowserName,
      viewport: { width: 1280, height: 720 },
      useBrowserStack,
      ...pickBrowserStack(params),
    });
    page = session.page;
    cleanup = () => closeSession(session);
  }

  const entries: NetworkEntry[] = [];
  const requestTimings = new Map<string, number>();

  // Listeners attached now — capture window starts from this point. When
  // reusing a session, requests from prior tool calls / the initial page
  // load are NOT captured (Playwright only delivers events emitted while a
  // listener is registered). To capture a fresh load, pass url to navigate.
  // Removed in finally, or each call on a session would leave its listeners
  // on the page for the session's lifetime.
  const onRequest = (request: Request) => {
    requestTimings.set(request.url(), Date.now());
  };
  const durationOf = (reqUrl: string) => {
    const startTime = requestTimings.get(reqUrl);
    return startTime ? Date.now() - startTime : null;
  };
  const onResponse = (response: Response) => {
    const reqUrl = response.url();
    if (urlFilter && !urlFilter.test(reqUrl)) return;
    entries.push({
      url: reqUrl,
      method: response.request().method(),
      status: response.status(),
      contentType: response.headers()["content-type"] || null,
      duration: durationOf(reqUrl),
    });
  };
  const onRequestFailed = (request: Request) => {
    const reqUrl = request.url();
    if (urlFilter && !urlFilter.test(reqUrl)) return;
    entries.push({
      url: reqUrl,
      method: request.method(),
      status: null,
      contentType: null,
      duration: durationOf(reqUrl),
      failure: request.failure()?.errorText ?? "failed",
    });
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  try {
    const nav = url ? await navigateTo(page, url) : null;

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
      await page.waitForTimeout(1000);
    }

    const content: Array<{ type: string; text: string }> = [];
    if (nav?.diagnostic) {
      content.push({ type: "text", text: formatDiagnostic(nav.diagnostic) });
    }
    if (actionStopMsg) {
      content.push({ type: "text", text: actionStopMsg });
    }
    if (assertionsMsg) {
      content.push({ type: "text", text: assertionsMsg });
    }
    if (entries.length === 0) {
      content.push({ type: "text", text: "No network requests captured." });
      return { content };
    }

    if (summaryOnly) {
      const byStatus: Record<string, number> = {};
      const byContentType: Record<string, number> = {};
      let errorCount = 0;
      let totalDuration = 0;
      let durationSamples = 0;
      const slowest: NetworkEntry[] = [];

      const isError = (e: NetworkEntry) => e.failure !== undefined || (e.status !== null && e.status >= 400);
      for (const e of entries) {
        const statusKey = e.failure !== undefined ? "failed" : e.status === null ? "pending" : String(e.status);
        byStatus[statusKey] = (byStatus[statusKey] ?? 0) + 1;
        if (isError(e)) errorCount++;
        const ct = (e.contentType ?? "unknown").split(";")[0];
        byContentType[ct] = (byContentType[ct] ?? 0) + 1;
        if (e.duration !== null) {
          totalDuration += e.duration;
          durationSamples++;
        }
      }

      const sorted = entries
        .filter((e) => e.duration !== null)
        .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
        .slice(0, 5);
      slowest.push(...sorted);

      const errorEntries = entries.filter(isError).slice(0, 5);

      content.push({
        type: "text",
        text: JSON.stringify({
          totalRequests: entries.length,
          errorCount,
          byStatus,
          byContentType,
          avgDurationMs: durationSamples > 0 ? Math.round(totalDuration / durationSamples) : null,
          slowestN: slowest.map((e) => ({ url: e.url, status: e.status, duration: e.duration })),
          errorsTopN: errorEntries.map((e) => ({ url: e.url, status: e.status, ...(e.failure ? { failure: e.failure } : {}) })),
        }, null, 2),
      });
    } else {
      content.push({
        type: "text",
        text: `Network log (${entries.length} requests):\n${JSON.stringify(entries, null, 2)}`,
      });
    }

    return { content };
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onRequestFailed);
    if (cleanup) await cleanup();
  }
}

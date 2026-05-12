import type { Page } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { sessionManager } from "../../../core/sessions.js";

export interface NetworkLogParams {
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
  page.on("request", (request) => {
    requestTimings.set(request.url(), Date.now());
  });

  page.on("response", (response) => {
    const reqUrl = response.url();
    const startTime = requestTimings.get(reqUrl);
    const duration = startTime ? Date.now() - startTime : null;

    if (filterUrl) {
      const regex = new RegExp(filterUrl);
      if (!regex.test(reqUrl)) return;
    }

    entries.push({
      url: reqUrl,
      method: response.request().method(),
      status: response.status(),
      contentType: response.headers()["content-type"] || null,
      duration,
    });
  });

  try {
    if (url) await navigateTo(page, url);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
      await page.waitForTimeout(1000);
    }

    const content: Array<{ type: string; text: string }> = [];
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

      for (const e of entries) {
        const statusKey = e.status === null ? "pending" : String(e.status);
        byStatus[statusKey] = (byStatus[statusKey] ?? 0) + 1;
        if (e.status !== null && e.status >= 400) errorCount++;
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

      const errorEntries = entries.filter((e) => e.status !== null && e.status >= 400).slice(0, 5);

      content.push({
        type: "text",
        text: JSON.stringify({
          totalRequests: entries.length,
          errorCount,
          byStatus,
          byContentType,
          avgDurationMs: durationSamples > 0 ? Math.round(totalDuration / durationSamples) : null,
          slowestN: slowest.map((e) => ({ url: e.url, status: e.status, duration: e.duration })),
          errorsTopN: errorEntries.map((e) => ({ url: e.url, status: e.status })),
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
    if (cleanup) await cleanup();
  }
}

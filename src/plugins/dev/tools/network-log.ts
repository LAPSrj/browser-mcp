import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";

export interface NetworkLogParams {
  url: string;
  actions?: AnyAction[];
  filterUrl?: string;
  useBrowserStack?: boolean;
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
    actions = [],
    filterUrl,
    useBrowserStack = false,
  } = params;

  const session = await launchSession({
    browser: "chromium" as BrowserName,
    viewport: { width: 1280, height: 720 },
    useBrowserStack,
  });

  const entries: NetworkEntry[] = [];
  const requestTimings = new Map<string, number>();

  try {
    session.page.on("request", (request) => {
      requestTimings.set(request.url(), Date.now());
    });

    session.page.on("response", (response) => {
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

    await navigateTo(session.page, url);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(session.page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
      await session.page.waitForTimeout(1000);
    }

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) {
      content.push({ type: "text", text: actionStopMsg });
    }
    if (assertionsMsg) {
      content.push({ type: "text", text: assertionsMsg });
    }
    content.push({
      type: "text",
      text: entries.length > 0
        ? `Network log (${entries.length} requests):\n${JSON.stringify(entries, null, 2)}`
        : "No network requests captured.",
    });

    return { content };
  } finally {
    await closeSession(session);
  }
}

import type { BrowserContext, Page } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, pickBrowserStack, type BrowserStackTarget, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { sessionManager } from "../../../core/sessions.js";

export interface PerformanceMetricsParams extends BrowserStackTarget {
  url?: string;
  session_id?: string;
  tab_id?: string;
  browser?: string;
  actions?: AnyAction[];
  useBrowserStack?: boolean;
  summaryOnly?: boolean;
}

export async function performanceMetricsTool(params: PerformanceMetricsParams) {
  const {
    url,
    session_id,
    tab_id,
    browser = "chromium",
    actions = [],
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
  let context: BrowserContext;
  let cleanup: (() => Promise<void>) | null = null;

  if (session_id) {
    sessionManager.touch(session_id);
    page = sessionManager.getPage(session_id, tab_id);
    context = sessionManager.getContext(session_id);
  } else {
    const session = await launchSession({
      browser: browser as BrowserName,
      viewport: { width: 1280, height: 720 },
      useBrowserStack,
      ...pickBrowserStack(params),
    });
    page = session.page;
    context = session.context;
    cleanup = () => closeSession(session);
  }

  try {
    if (url) await navigateTo(page, url);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    const metrics = await page.evaluate(() => {
      const perf = performance;
      const navigation = perf.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const paint = perf.getEntriesByType("paint");

      const firstPaint = paint.find((e) => e.name === "first-paint")?.startTime ?? null;
      const firstContentfulPaint =
        paint.find((e) => e.name === "first-contentful-paint")?.startTime ?? null;

      let largestContentfulPaint: number | null = null;
      let cumulativeLayoutShift: number | null = null;

      // LCP and CLS need PerformanceObserver data that may already exist
      const lcpEntries = perf.getEntriesByType("largest-contentful-paint");
      if (lcpEntries.length > 0) {
        largestContentfulPaint = lcpEntries[lcpEntries.length - 1].startTime;
      }

      const layoutShiftEntries = perf.getEntriesByType("layout-shift") as Array<
        PerformanceEntry & { value: number; hadRecentInput: boolean }
      >;
      if (layoutShiftEntries.length > 0) {
        cumulativeLayoutShift = layoutShiftEntries
          .filter((e) => !e.hadRecentInput)
          .reduce((sum, e) => sum + e.value, 0);
      }

      return {
        loadTime: navigation ? navigation.loadEventEnd - navigation.fetchStart : null,
        domContentLoaded: navigation
          ? navigation.domContentLoadedEventEnd - navigation.fetchStart
          : null,
        firstPaint,
        firstContentfulPaint,
        largestContentfulPaint,
        cumulativeLayoutShift,
        totalBlockingTime: null as number | null, // TBT requires long-task observer
        domInteractive: navigation ? navigation.domInteractive - navigation.fetchStart : null,
        timeToFirstByte: navigation ? navigation.responseStart - navigation.fetchStart : null,
        transferSize: navigation ? navigation.transferSize : null,
      };
    });

    // Attempt to get TBT via CDP on Chromium
    if (browser === "chromium" && !useBrowserStack) {
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");
        const cdpMetrics = await cdp.send("Performance.getMetrics");
        const tbt = cdpMetrics.metrics.find(
          (m: { name: string; value: number }) => m.name === "TotalBlockingTime"
        );
        if (tbt) {
          metrics.totalBlockingTime = tbt.value;
        }
      } catch {
        // CDP not available or TBT not found
      }
    }

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) {
      content.push({ type: "text", text: actionStopMsg });
    }
    if (assertionsMsg) {
      content.push({ type: "text", text: assertionsMsg });
    }
    if (summaryOnly) {
      const fmt = (v: number | null) => v === null ? "?" : `${Math.round(v)}ms`;
      content.push({
        type: "text",
        text: [
          `LCP=${fmt(metrics.largestContentfulPaint)}`,
          `FCP=${fmt(metrics.firstContentfulPaint)}`,
          `TTFB=${fmt(metrics.timeToFirstByte)}`,
          `DCL=${fmt(metrics.domContentLoaded)}`,
          `Load=${fmt(metrics.loadTime)}`,
          `CLS=${metrics.cumulativeLayoutShift === null ? "?" : metrics.cumulativeLayoutShift.toFixed(3)}`,
          `TBT=${fmt(metrics.totalBlockingTime)}`,
          `transfer=${metrics.transferSize === null ? "?" : `${metrics.transferSize}B`}`,
        ].join(" | "),
      });
    } else {
      content.push({ type: "text", text: JSON.stringify(metrics, null, 2) });
    }

    return { content };
  } finally {
    if (cleanup) await cleanup();
  }
}

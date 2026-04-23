import type { AnyAction } from "../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../utils/browser.js";
import { navigateTo } from "../utils/navigate.js";

export interface PerformanceMetricsParams {
  url: string;
  browser?: string;
  actions?: AnyAction[];
  useBrowserStack?: boolean;
}

export async function performanceMetricsTool(params: PerformanceMetricsParams) {
  const {
    url,
    browser = "chromium",
    actions = [],
    useBrowserStack = false,
  } = params;

  const session = await launchSession({
    browser: browser as BrowserName,
    viewport: { width: 1280, height: 720 },
    useBrowserStack,
  });

  try {
    await navigateTo(session.page, url);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(session.page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    const metrics = await session.page.evaluate(() => {
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
        const cdp = await session.context.newCDPSession(session.page);
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
    content.push({ type: "text", text: JSON.stringify(metrics, null, 2) });

    return { content };
  } finally {
    await closeSession(session);
  }
}

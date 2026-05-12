import path from "node:path";
import type { Page } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { saveFile, generateFilename } from "../../../utils/file.js";
import { sessionManager } from "../../../core/sessions.js";

export interface ConsoleCaptureParams {
  url?: string;
  session_id?: string;
  tab_id?: string;
  browser?: string;
  actions?: AnyAction[];
  outputDir?: string;
  toFile?: boolean;
  useBrowserStack?: boolean;
  summaryOnly?: boolean;
}

interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}

export async function consoleCaptureTool(params: ConsoleCaptureParams) {
  const {
    url,
    session_id,
    tab_id,
    browser = "chromium",
    actions = [],
    outputDir = ".browser",
    toFile = false,
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
      browser: browser as BrowserName,
      viewport: { width: 1280, height: 720 },
      useBrowserStack,
    });
    page = session.page;
    cleanup = () => closeSession(session);
  }

  const consoleLogs: ConsoleEntry[] = [];
  const pageErrors: string[] = [];

  // Listeners attached now — capture window starts from this point. When
  // reusing a session, any console events emitted during prior tool calls
  // or the initial page load are NOT captured (Playwright only delivers
  // events emitted while a listener is registered on the Page).
  page.on("console", (msg) => {
    consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      timestamp: Date.now(),
    });
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  try {
    if (url) await navigateTo(page, url);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    // Small delay to capture any deferred logs
    await page.waitForTimeout(500);

    const logText = consoleLogs
      .map((l) => `[${l.type}] ${l.text}`)
      .join("\n");

    const content: Array<{ type: string; text: string }> = [];

    if (actionStopMsg) {
      content.push({ type: "text", text: actionStopMsg });
    }
    if (assertionsMsg) {
      content.push({ type: "text", text: assertionsMsg });
    }

    if (consoleLogs.length > 0) {
      if (summaryOnly) {
        const byType: Record<string, number> = {};
        for (const l of consoleLogs) byType[l.type] = (byType[l.type] ?? 0) + 1;
        const errorPreviews = consoleLogs
          .filter((l) => l.type === "error" || l.type === "warning")
          .slice(0, 5)
          .map((l) => ({ type: l.type, text: l.text.slice(0, 200) }));
        content.push({
          type: "text",
          text: JSON.stringify({
            totalLogs: consoleLogs.length,
            byType,
            errorPreviews,
          }, null, 2),
        });
      } else {
        content.push({
          type: "text",
          text: `Console logs (${consoleLogs.length} entries):\n${logText}`,
        });
      }
    } else {
      content.push({
        type: "text",
        text: "No console logs captured.",
      });
    }

    if (pageErrors.length > 0) {
      if (summaryOnly) {
        content.push({
          type: "text",
          text: JSON.stringify({
            pageErrors: pageErrors.length,
            previews: pageErrors.slice(0, 5).map((e) => e.slice(0, 200)),
          }, null, 2),
        });
      } else {
        content.push({
          type: "text",
          text: `Page errors (${pageErrors.length}):\n${pageErrors.join("\n")}`,
        });
      }
    }

    if (toFile && consoleLogs.length > 0) {
      const filename = generateFilename({ prefix: "console", extension: "log" });
      const filePath = await saveFile(path.join(outputDir, filename), logText);
      content.push({
        type: "text",
        text: `Console log saved to: ${filePath}`,
      });
    }

    return { content };
  } finally {
    if (cleanup) await cleanup();
  }
}

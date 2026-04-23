import path from "node:path";
import type { AnyAction } from "../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../utils/browser.js";
import { navigateTo } from "../utils/navigate.js";
import { saveFile, generateFilename } from "../utils/file.js";

export interface ConsoleCaptureParams {
  url: string;
  browser?: string;
  actions?: AnyAction[];
  outputDir?: string;
  toFile?: boolean;
  useBrowserStack?: boolean;
}

interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
}

export async function consoleCaptureTool(params: ConsoleCaptureParams) {
  const {
    url,
    browser = "chromium",
    actions = [],
    outputDir = ".browser",
    toFile = false,
    useBrowserStack = false,
  } = params;

  const session = await launchSession({
    browser: browser as BrowserName,
    viewport: { width: 1280, height: 720 },
    useBrowserStack,
  });

  const consoleLogs: ConsoleEntry[] = [];
  const pageErrors: string[] = [];

  try {
    session.page.on("console", (msg) => {
      consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
    });

    session.page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await navigateTo(session.page, url);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(session.page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    // Small delay to capture any deferred logs
    await session.page.waitForTimeout(500);

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
      content.push({
        type: "text",
        text: `Console logs (${consoleLogs.length} entries):\n${logText}`,
      });
    } else {
      content.push({
        type: "text",
        text: "No console logs captured.",
      });
    }

    if (pageErrors.length > 0) {
      content.push({
        type: "text",
        text: `Page errors (${pageErrors.length}):\n${pageErrors.join("\n")}`,
      });
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
    await closeSession(session);
  }
}

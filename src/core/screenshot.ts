import path from "node:path";
import type { AnyAction } from "../utils/actions.js";
import { runActions, formatActionStop, formatAssertions, type ActionStopResult, type AssertionResult } from "../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../utils/browser.js";
import { navigateTo } from "../utils/navigate.js";
import { saveFile, generateFilename } from "../utils/file.js";
import { createPreviewBuffer } from "../utils/resize.js";

export interface ScreenshotParams {
  url: string;
  browsers?: string[];
  viewports?: { width: number; height: number; label?: string }[];
  fullPage?: boolean;
  outputDir?: string;
  actions?: AnyAction[];
  captureConsole?: boolean;
  consoleToFile?: boolean;
  waitForNetworkIdle?: boolean;
  useBrowserStack?: boolean;
  delay?: number;
  startY?: number;
  endY?: number;
}

interface ScreenshotResult {
  browser: string;
  viewport: string;
  filePath: string;
  previewPath: string;
}

interface ConsoleEntry {
  type: string;
  text: string;
}

export async function screenshotTool(params: ScreenshotParams) {
  const {
    url,
    browsers = ["chromium"],
    viewports = [{ width: 1280, height: 720 }],
    fullPage = false,
    outputDir = ".browser",
    actions = [],
    captureConsole = false,
    consoleToFile = false,
    waitForNetworkIdle = true,
    useBrowserStack = false,
    delay = 0,
    startY,
    endY,
  } = params;

  const tasks: Promise<{ result: ScreenshotResult; consoleLogs: ConsoleEntry[]; actionStop?: ActionStopResult; assertions: AssertionResult[] }>[] = [];

  for (const browserName of browsers) {
    for (const vp of viewports) {
      tasks.push(
        (async () => {
          const consoleLogs: ConsoleEntry[] = [];
          const session = await launchSession({
            browser: browserName as BrowserName,
            viewport: { width: vp.width, height: vp.height },
            useBrowserStack,
          });

          try {
            if (captureConsole) {
              session.page.on("console", (msg) => {
                consoleLogs.push({ type: msg.type(), text: msg.text() });
              });
            }

            await navigateTo(session.page, url, waitForNetworkIdle);

            let actionStop: ActionStopResult | undefined;
            let assertions: AssertionResult[] = [];
            if (actions.length > 0) {
              const result = await runActions(session.page, actions);
              actionStop = result.stoppedAt;
              assertions = result.assertions;
            }

            if (delay > 0) {
              await session.page.waitForTimeout(delay);
            }

            const screenshotOptions: Record<string, unknown> = {
              fullPage,
              type: "png",
            };

            if (startY !== undefined || endY !== undefined) {
              const clipX = 0;
              const clipY = startY ?? 0;
              const clipWidth = vp.width;
              const clipHeight = (endY ?? vp.height) - clipY;
              screenshotOptions.clip = { x: clipX, y: clipY, width: clipWidth, height: clipHeight };
              screenshotOptions.fullPage = false;
            }

            const screenshotBuffer = await session.page.screenshot(screenshotOptions);

            const vpLabel = vp.label || `${vp.width}x${vp.height}`;
            const filename = generateFilename({
              prefix: "screenshot",
              browser: browserName,
              viewport: vpLabel,
              extension: "png",
            });
            const filePath = await saveFile(path.join(outputDir, filename), screenshotBuffer);

            const previewFilename = generateFilename({
              prefix: "screenshot-preview",
              browser: browserName,
              viewport: vpLabel,
              extension: "png",
            });
            const previewPath = await saveFile(path.join(outputDir, previewFilename), createPreviewBuffer(screenshotBuffer));

            return {
              result: {
                browser: browserName,
                viewport: vpLabel,
                filePath,
                previewPath,
              },
              consoleLogs,
              actionStop,
              assertions,
            };
          } finally {
            await closeSession(session);
          }
        })()
      );
    }
  }

  const results = await Promise.all(tasks);

  const screenshots = results.map((r) => r.result);
  const allConsoleLogs = results.flatMap((r) => r.consoleLogs);
  const actionStop = results.find((r) => r.actionStop)?.actionStop;
  const allAssertions = results.flatMap((r) => r.assertions);

  if (consoleToFile && allConsoleLogs.length > 0) {
    const logContent = allConsoleLogs
      .map((l) => `[${l.type}] ${l.text}`)
      .join("\n");
    const logFilename = generateFilename({ prefix: "console", extension: "log" });
    await saveFile(path.join(outputDir, logFilename), logContent);
  }

  // Build MCP response content
  const content: Array<{ type: string; [key: string]: unknown }> = [];

  if (actionStop) {
    content.push({ type: "text", text: formatActionStop(actionStop) });
  }

  const assertionsMsg = formatAssertions(allAssertions);
  if (assertionsMsg) {
    content.push({ type: "text", text: assertionsMsg });
  }

  for (const s of screenshots) {
    content.push({
      type: "text",
      text: `Browser: ${s.browser} | Viewport: ${s.viewport} | Saved: ${s.filePath} | Preview (small): ${s.previewPath}`,
    });
  }

  if (captureConsole && allConsoleLogs.length > 0) {
    content.push({
      type: "text",
      text: `Console logs:\n${allConsoleLogs.map((l) => `[${l.type}] ${l.text}`).join("\n")}`,
    });
  }

  return { content };
}

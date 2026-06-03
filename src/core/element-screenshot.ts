import path from "node:path";
import type { AnyAction } from "../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../utils/actions.js";
import { launchSession, closeSession, pickBrowserStack, type BrowserStackTarget, type BrowserName } from "../utils/browser.js";
import { navigateTo } from "../utils/navigate.js";
import { saveFile, generateFilename } from "../utils/file.js";

export interface ElementScreenshotParams extends BrowserStackTarget {
  url: string;
  selector: string;
  browser?: string;
  viewport?: { width: number; height: number };
  actions?: AnyAction[];
  outputDir?: string;
  useBrowserStack?: boolean;
}

export async function elementScreenshotTool(params: ElementScreenshotParams) {
  const {
    url,
    selector,
    browser = "chromium",
    viewport = { width: 1280, height: 720 },
    actions = [],
    outputDir = ".browser",
    useBrowserStack = false,
  } = params;

  const session = await launchSession({
    browser: browser as BrowserName,
    viewport,
    useBrowserStack,
    ...pickBrowserStack(params),
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

    const element = session.page.locator(selector);
    await element.waitFor({ state: "visible", timeout: 10000 });

    const screenshotBuffer = await element.screenshot({ type: "png" });

    const filename = generateFilename({
      prefix: "element",
      browser,
      extension: "png",
    });
    const filePath = await saveFile(path.join(outputDir, filename), screenshotBuffer);

    const content: Array<{ type: string; [key: string]: unknown }> = [];
    if (actionStopMsg) {
      content.push({ type: "text", text: actionStopMsg });
    }
    if (assertionsMsg) {
      content.push({ type: "text", text: assertionsMsg });
    }
    content.push(
      {
        type: "image",
        data: screenshotBuffer.toString("base64"),
        mimeType: "image/png",
      },
      {
        type: "text",
        text: `Element: ${selector} | Browser: ${browser} | Saved: ${filePath}`,
      },
    );

    return { content };
  } finally {
    await closeSession(session);
  }
}

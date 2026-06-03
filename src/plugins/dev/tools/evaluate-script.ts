import type { Page } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions, evaluateScript } from "../../../utils/actions.js";
import { launchSession, closeSession, pickBrowserStack, type BrowserStackTarget, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { sessionManager } from "../../../core/sessions.js";

export interface EvaluateScriptParams extends BrowserStackTarget {
  url?: string;
  session_id?: string;
  tab_id?: string;
  script: string;
  browser?: string;
  viewport?: { width: number; height: number };
  actions?: AnyAction[];
  waitForNetworkIdle?: boolean;
  useBrowserStack?: boolean;
}

export async function evaluateScriptTool(params: EvaluateScriptParams) {
  const {
    url,
    session_id,
    tab_id,
    script,
    browser = "chromium",
    viewport = { width: 1280, height: 720 },
    actions = [],
    waitForNetworkIdle = true,
    useBrowserStack = false,
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
      viewport,
      useBrowserStack,
      ...pickBrowserStack(params),
    });
    page = session.page;
    cleanup = () => closeSession(session);
  }

  try {
    if (url) {
      await navigateTo(page, url, waitForNetworkIdle);
    }

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    let resultText: string;
    let errorText: string | undefined;
    try {
      const raw = await evaluateScript(page, script);
      try {
        resultText = JSON.stringify(raw, null, 2);
      } catch {
        resultText = String(raw);
      }
    } catch (error) {
      errorText = (error as Error).message;
      resultText = "";
    }

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });
    if (errorText !== undefined) {
      content.push({ type: "text", text: `Script error: ${errorText}` });
      return { content, isError: true };
    }
    content.push({ type: "text", text: resultText });
    return { content };
  } finally {
    if (cleanup) await cleanup();
  }
}

import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions, evaluateScript } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";

export interface EvaluateScriptParams {
  url: string;
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
    script,
    browser = "chromium",
    viewport = { width: 1280, height: 720 },
    actions = [],
    waitForNetworkIdle = true,
    useBrowserStack = false,
  } = params;

  const session = await launchSession({
    browser: browser as BrowserName,
    viewport,
    useBrowserStack,
  });

  try {
    await navigateTo(session.page, url, waitForNetworkIdle);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(session.page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    let resultText: string;
    let errorText: string | undefined;
    try {
      const raw = await evaluateScript(session.page, script);
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
    await closeSession(session);
  }
}

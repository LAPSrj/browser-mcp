import type { AnyAction } from "../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../utils/browser.js";
import { navigateTo } from "../utils/navigate.js";

export interface PageMetadataParams {
  url: string;
  actions?: AnyAction[];
  useBrowserStack?: boolean;
}

export async function pageMetadataTool(params: PageMetadataParams) {
  const {
    url,
    actions = [],
    useBrowserStack = false,
  } = params;

  const session = await launchSession({
    browser: "chromium" as BrowserName,
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

    const metadata = await session.page.evaluate(() => {
      const getMeta = (name: string): string | null => {
        const el =
          document.querySelector(`meta[name="${name}"]`) ||
          document.querySelector(`meta[property="${name}"]`);
        return el?.getAttribute("content") || null;
      };

      const ogTags: Record<string, string> = {};
      document.querySelectorAll('meta[property^="og:"]').forEach((el) => {
        const prop = el.getAttribute("property");
        const content = el.getAttribute("content");
        if (prop && content) ogTags[prop] = content;
      });

      const metaTags: Record<string, string> = {};
      document.querySelectorAll("meta[name]").forEach((el) => {
        const name = el.getAttribute("name");
        const content = el.getAttribute("content");
        if (name && content) metaTags[name] = content;
      });

      const favicon =
        (document.querySelector('link[rel="icon"]') as HTMLLinkElement)?.href ||
        (document.querySelector('link[rel="shortcut icon"]') as HTMLLinkElement)?.href ||
        null;

      return {
        title: document.title || null,
        description: getMeta("description"),
        ogTags,
        metaTags,
        favicon,
        lang: document.documentElement.lang || null,
        charset:
          document.characterSet ||
          document.querySelector("meta[charset]")?.getAttribute("charset") ||
          null,
      };
    });

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) {
      content.push({ type: "text", text: actionStopMsg });
    }
    if (assertionsMsg) {
      content.push({ type: "text", text: assertionsMsg });
    }
    content.push({ type: "text", text: JSON.stringify(metadata, null, 2) });

    return { content };
  } finally {
    await closeSession(session);
  }
}

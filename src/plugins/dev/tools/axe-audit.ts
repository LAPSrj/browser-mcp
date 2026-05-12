import type { Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { sessionManager } from "../../../core/sessions.js";

export type AxeTag =
  | "wcag2a"
  | "wcag2aa"
  | "wcag2aaa"
  | "wcag21a"
  | "wcag21aa"
  | "wcag22aa"
  | "best-practice"
  | "ACT"
  | "section508"
  | "experimental";

export interface AxeAuditParams {
  url?: string;
  session_id?: string;
  tab_id?: string;
  browser?: string;
  viewport?: { width: number; height: number };
  actions?: AnyAction[];
  waitForNetworkIdle?: boolean;
  useBrowserStack?: boolean;
  include?: string[];
  exclude?: string[];
  tags?: AxeTag[];
  rules?: string[];
  disableRules?: string[];
  resultTypes?: Array<"violations" | "passes" | "incomplete" | "inapplicable">;
  summaryOnly?: boolean;
}

export async function axeAuditTool(params: AxeAuditParams) {
  const {
    url,
    session_id,
    tab_id,
    browser = "chromium",
    viewport = { width: 1280, height: 720 },
    actions = [],
    waitForNetworkIdle = true,
    useBrowserStack = false,
    include,
    exclude,
    tags,
    rules,
    disableRules,
    resultTypes,
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
      viewport,
      useBrowserStack,
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

    let axe = new AxeBuilder({ page });
    if (include && include.length > 0) axe = axe.include(include);
    if (exclude && exclude.length > 0) axe = axe.exclude(exclude);
    if (rules && rules.length > 0) {
      axe = axe.options({ runOnly: { type: "rule", values: rules } });
    } else if (tags && tags.length > 0) {
      axe = axe.withTags(tags);
    }
    if (disableRules && disableRules.length > 0) axe = axe.disableRules(disableRules);

    const raw = await axe.analyze();

    const summary = {
      url: raw.url,
      timestamp: raw.timestamp,
      counts: {
        violations: raw.violations.length,
        passes: raw.passes.length,
        incomplete: raw.incomplete.length,
        inapplicable: raw.inapplicable.length,
      },
      violationsByImpact: countByImpact(raw.violations),
      testEngine: raw.testEngine,
    };

    const wanted = new Set(resultTypes ?? ["violations", "incomplete"]);
    const body: Record<string, unknown> = { summary };
    if (wanted.has("violations")) body.violations = compactResults(raw.violations);
    if (wanted.has("incomplete")) body.incomplete = compactResults(raw.incomplete);
    if (wanted.has("passes")) body.passes = compactResults(raw.passes);
    if (wanted.has("inapplicable")) body.inapplicable = compactResults(raw.inapplicable);

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });
    content.push({
      type: "text",
      text: JSON.stringify(summaryOnly ? summary : body, null, 2),
    });
    return { content };
  } finally {
    if (cleanup) await cleanup();
  }
}

type AxeResult = Awaited<ReturnType<InstanceType<typeof AxeBuilder>["analyze"]>>;
type AxeRuleResult = AxeResult["violations"][number];

function countByImpact(results: AxeRuleResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) {
    const k = r.impact ?? "none";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function compactResults(results: AxeRuleResult[]): Array<Record<string, unknown>> {
  return results.map((r) => ({
    id: r.id,
    impact: r.impact ?? null,
    tags: r.tags,
    help: r.help,
    helpUrl: r.helpUrl,
    nodes: r.nodes.map((n) => ({
      target: n.target,
      html: n.html,
      failureSummary: n.failureSummary ?? null,
    })),
  }));
}

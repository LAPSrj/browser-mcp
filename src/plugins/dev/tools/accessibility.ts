import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { walkAccessibilityTree } from "../../../utils/a11y-walker.js";

export type A11yRuleName =
  | "section-has-name"
  | "details-summary-has-heading"
  | "region-has-roledescription"
  | "button-has-name"
  | "img-has-alt"
  | "form-control-has-label";

const ALL_RULES: A11yRuleName[] = [
  "section-has-name",
  "details-summary-has-heading",
  "region-has-roledescription",
  "button-has-name",
  "img-has-alt",
  "form-control-has-label",
];

export interface AccessibilitySnapshotParams {
  url: string;
  actions?: AnyAction[];
  useBrowserStack?: boolean;
  /** Selector to scope the snapshot + asserts (default: document.body). */
  scope?: string;
  /** When provided, run these a11y rule checks and return pass/fail per rule. */
  assertRules?: A11yRuleName[];
  /** If true, omit the full tree output (useful when you only want assert results). */
  skipTree?: boolean;
  /** Replace the full tree with a role/depth aggregate. Findings still surface in full. */
  summaryOnly?: boolean;
}

interface A11yRuleFinding {
  rule: A11yRuleName;
  passed: boolean;
  failures: Array<{ selector: string; reason: string }>;
}

export async function accessibilitySnapshotTool(params: AccessibilitySnapshotParams) {
  const {
    url,
    actions = [],
    useBrowserStack = false,
    scope,
    assertRules,
    skipTree = false,
    summaryOnly = false,
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

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });

    if (assertRules && assertRules.length > 0) {
      const findings = await runA11yRules(session.page, assertRules, scope);
      content.push({ type: "text", text: formatFindings(findings) });
    }

    if (!skipTree) {
      const snapshot = await walkAccessibilityTree(session.page, scope);
      if (!snapshot) {
        content.push({ type: "text", text: "No accessibility tree available for this page." });
      } else if (summaryOnly) {
        const stats = summarizeA11yTree(snapshot as Record<string, unknown>);
        content.push({
          type: "text",
          text: JSON.stringify({
            rootRole: (snapshot as { role?: string }).role ?? null,
            totalNodes: stats.totalNodes,
            maxDepth: stats.maxDepth,
            byRole: stats.byRole,
            headingCount: stats.headingCount,
            landmarkCount: stats.landmarkCount,
            namedNodeCount: stats.namedNodeCount,
          }, null, 2),
        });
      } else {
        content.push({ type: "text", text: JSON.stringify(snapshot, null, 2) });
      }
    }

    return { content };
  } finally {
    await closeSession(session);
  }
}

async function runA11yRules(
  page: import("playwright").Page,
  rules: A11yRuleName[],
  scope?: string,
): Promise<A11yRuleFinding[]> {
  return page.evaluate(
    ({ rules, scope }) => {
      const root: Element | Document = scope ? (document.querySelector(scope) ?? document) : document;

      function shortId(el: Element): string {
        const tag = el.tagName.toLowerCase();
        if (el.id) return `${tag}#${el.id}`;
        const cls = el.getAttribute("class");
        if (cls) {
          const first = cls.split(/\s+/).find(Boolean);
          if (first) return `${tag}.${first}`;
        }
        return tag;
      }

      function hasAccessibleName(el: Element): boolean {
        if (el.getAttribute("aria-label")?.trim()) return true;
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          for (const id of labelledby.split(/\s+/)) {
            const ref = document.getElementById(id);
            if (ref && (ref.textContent ?? "").trim()) return true;
          }
        }
        return false;
      }

      function hasHeadingChild(el: Element): boolean {
        return !!el.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > [role=\"heading\"]");
      }

      function matchAll(selector: string): Element[] {
        return Array.from((root as Element | Document).querySelectorAll(selector));
      }

      const results: Array<{ rule: string; passed: boolean; failures: Array<{ selector: string; reason: string }> }> = [];

      for (const rule of rules) {
        const failures: Array<{ selector: string; reason: string }> = [];
        switch (rule) {
          case "section-has-name": {
            for (const el of matchAll("section, [role=\"region\"]")) {
              if (!hasAccessibleName(el)) {
                failures.push({ selector: shortId(el), reason: "missing aria-label / aria-labelledby" });
              }
            }
            break;
          }
          case "details-summary-has-heading": {
            for (const el of matchAll("details > summary")) {
              if (!hasHeadingChild(el)) {
                failures.push({ selector: shortId(el), reason: "no heading child (h1-h6 or role=heading)" });
              }
            }
            break;
          }
          case "region-has-roledescription": {
            for (const el of matchAll("[role=\"region\"]")) {
              if (!el.getAttribute("aria-roledescription")?.trim()) {
                failures.push({ selector: shortId(el), reason: "missing aria-roledescription" });
              }
            }
            break;
          }
          case "button-has-name": {
            for (const el of matchAll("button, [role=\"button\"]")) {
              const txt = (el.textContent ?? "").trim();
              if (!txt && !hasAccessibleName(el)) {
                failures.push({ selector: shortId(el), reason: "empty textContent and no aria-label" });
              }
            }
            break;
          }
          case "img-has-alt": {
            for (const el of matchAll("img")) {
              if (el.getAttribute("alt") === null) {
                failures.push({ selector: shortId(el), reason: "missing alt attribute" });
              }
            }
            break;
          }
          case "form-control-has-label": {
            for (const el of matchAll("input:not([type=\"hidden\"]):not([type=\"submit\"]):not([type=\"button\"]), select, textarea")) {
              if (hasAccessibleName(el)) continue;
              const id = el.getAttribute("id");
              if (id && document.querySelector(`label[for="${id}"]`)) continue;
              if (el.closest("label")) continue;
              failures.push({ selector: shortId(el), reason: "no associated <label> and no aria-label" });
            }
            break;
          }
        }
        results.push({ rule, passed: failures.length === 0, failures });
      }
      return results;
    },
    { rules, scope },
  ) as Promise<A11yRuleFinding[]>;
}

function formatFindings(findings: A11yRuleFinding[]): string {
  const passed = findings.filter((f) => f.passed).length;
  const failed = findings.length - passed;
  const lines = [`A11y rule asserts: ${passed} passed, ${failed} failed`];
  for (const f of findings) {
    const tag = f.passed ? "✓" : "✗";
    lines.push(`  ${tag} ${f.rule}`);
    for (const fail of f.failures) {
      lines.push(`      ${fail.selector} — ${fail.reason}`);
    }
  }
  return lines.join("\n");
}

export const A11Y_RULE_NAMES = ALL_RULES;

const LANDMARK_ROLES = new Set([
  "banner", "complementary", "contentinfo", "form",
  "main", "navigation", "region", "search",
]);

function summarizeA11yTree(node: Record<string, unknown>): {
  totalNodes: number;
  maxDepth: number;
  byRole: Record<string, number>;
  headingCount: number;
  landmarkCount: number;
  namedNodeCount: number;
} {
  const byRole: Record<string, number> = {};
  let totalNodes = 0;
  let maxDepth = 0;
  let headingCount = 0;
  let landmarkCount = 0;
  let namedNodeCount = 0;

  function walk(n: Record<string, unknown>, depth: number) {
    totalNodes++;
    if (depth > maxDepth) maxDepth = depth;
    const role = typeof n.role === "string" ? n.role : "?";
    byRole[role] = (byRole[role] ?? 0) + 1;
    if (role === "heading") headingCount++;
    if (LANDMARK_ROLES.has(role)) landmarkCount++;
    if (typeof n.name === "string" && n.name.length > 0) namedNodeCount++;
    const children = n.children;
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c && typeof c === "object") walk(c as Record<string, unknown>, depth + 1);
      }
    }
  }

  walk(node, 0);
  return { totalNodes, maxDepth, byRole, headingCount, landmarkCount, namedNodeCount };
}

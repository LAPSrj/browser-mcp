import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";

export interface DomSnapshotParams {
  url: string;
  selector?: string;
  maxDepth?: number;
  actions?: AnyAction[];
  useBrowserStack?: boolean;
  summaryOnly?: boolean;
}

interface DomNode {
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  children?: DomNode[];
}

export async function domSnapshotTool(params: DomSnapshotParams) {
  const {
    url,
    selector = "body",
    maxDepth = 5,
    actions = [],
    useBrowserStack = false,
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

    const tree = await session.page.evaluate(
      ({ sel, depth }) => {
        function walk(el: Element, currentDepth: number): unknown {
          const node: Record<string, unknown> = {
            tag: el.tagName.toLowerCase(),
          };

          if (el.id) node.id = el.id;

          const classes = Array.from(el.classList);
          if (classes.length > 0) node.classes = classes;

          // Get direct text content (not from children)
          const textParts: string[] = [];
          for (const child of el.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              const text = (child.textContent || "").trim();
              if (text) textParts.push(text);
            }
          }
          if (textParts.length > 0) {
            node.text = textParts.join(" ").substring(0, 200);
          }

          if (currentDepth < depth) {
            const children: unknown[] = [];
            for (const child of el.children) {
              children.push(walk(child, currentDepth + 1));
            }
            if (children.length > 0) {
              node.children = children;
            }
          } else if (el.children.length > 0) {
            node.children = `[${el.children.length} children truncated]`;
          }

          return node;
        }

        const root = document.querySelector(sel);
        if (!root) return null;
        return walk(root, 0);
      },
      { sel: selector, depth: maxDepth }
    );

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) {
      content.push({ type: "text", text: actionStopMsg });
    }
    if (assertionsMsg) {
      content.push({ type: "text", text: assertionsMsg });
    }

    if (!tree) {
      content.push({ type: "text", text: `No element found matching selector: ${selector}` });
      return { content };
    }

    if (summaryOnly) {
      const stats = summarizeTree(tree as Record<string, unknown>);
      content.push({
        type: "text",
        text: JSON.stringify({
          rootTag: (tree as { tag?: string }).tag ?? null,
          totalNodes: stats.totalNodes,
          maxDepthReached: stats.maxDepth,
          truncatedBranches: stats.truncatedBranches,
          byTag: stats.byTag,
        }, null, 2),
      });
    } else {
      content.push({ type: "text", text: JSON.stringify(tree, null, 2) });
    }
    return { content };
  } finally {
    await closeSession(session);
  }
}

function summarizeTree(node: Record<string, unknown>): {
  totalNodes: number;
  maxDepth: number;
  truncatedBranches: number;
  byTag: Record<string, number>;
} {
  const byTag: Record<string, number> = {};
  let totalNodes = 0;
  let maxDepth = 0;
  let truncatedBranches = 0;

  function walk(n: Record<string, unknown>, depth: number) {
    totalNodes++;
    if (depth > maxDepth) maxDepth = depth;
    const tag = typeof n.tag === "string" ? n.tag : "?";
    byTag[tag] = (byTag[tag] ?? 0) + 1;
    const children = n.children;
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c && typeof c === "object") walk(c as Record<string, unknown>, depth + 1);
      }
    } else if (typeof children === "string") {
      // "[N children truncated]" sentinel from the in-page walker.
      truncatedBranches++;
    }
  }

  walk(node, 0);
  return { totalNodes, maxDepth, truncatedBranches, byTag };
}

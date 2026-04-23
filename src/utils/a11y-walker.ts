import type { Page, Frame } from "playwright";

/**
 * Walk the DOM and produce a structured accessibility tree. This is the
 * same algorithm used by the accessibility_snapshot core tool, extracted
 * for reuse. Does not rely on Playwright's accessibility API (which was
 * removed in Playwright 1.58+).
 *
 * When `selector` is provided, the walk is scoped to the matching element.
 * Otherwise it walks from document.body.
 */
export async function walkAccessibilityTree(
  page: Page | Frame,
  selector?: string,
  maxDepth = 10,
): Promise<unknown> {
  return page.evaluate(
    ({ sel, max }) => {
      function walk(el: Element, depth: number): unknown {
        if (depth > max) return null;

        const role = el.getAttribute("role") || el.tagName.toLowerCase();
        const ariaLabel = el.getAttribute("aria-label");
        const ariaDescribedBy = el.getAttribute("aria-describedby");
        const ariaExpanded = el.getAttribute("aria-expanded");
        const ariaHidden = el.getAttribute("aria-hidden");
        const tabIndex = el.getAttribute("tabindex");

        if (ariaHidden === "true") return null;

        const node: Record<string, unknown> = { role };

        if (ariaLabel) node.name = ariaLabel;
        if (ariaDescribedBy) node.describedBy = ariaDescribedBy;
        if (ariaExpanded != null) node.expanded = ariaExpanded === "true";
        if (tabIndex != null) node.focusable = true;

        // Direct text content
        const texts: string[] = [];
        for (const child of el.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const t = (child.textContent || "").trim();
            if (t) texts.push(t);
          }
        }
        if (texts.length > 0) node.text = texts.join(" ").substring(0, 200);

        const children: unknown[] = [];
        for (const child of el.children) {
          const c = walk(child, depth + 1);
          if (c) children.push(c);
        }
        if (children.length > 0) node.children = children;

        return node;
      }

      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return null;
      return walk(root, 0);
    },
    { sel: selector, max: maxDepth },
  );
}

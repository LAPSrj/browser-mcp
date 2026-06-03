import type { BrowserContext, Page } from "playwright";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, pickBrowserStack, type BrowserStackTarget, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { sessionManager } from "../../../core/sessions.js";

export interface ComputedStylesParams extends BrowserStackTarget {
  url?: string;
  session_id?: string;
  tab_id?: string;
  selector: string;
  filter?: "all" | "non-default";
  properties?: string[];
  includeSource?: boolean;
  includeInherited?: boolean;
  viewport?: { width: number; height: number };
  actions?: AnyAction[];
  useBrowserStack?: boolean;
}

interface StyleEntry {
  value: string;
  source?: string;
  selector?: string;
  inherited?: boolean;
}

interface StylesResult {
  selector: string;
  tag: string;
  propertyCount: number;
  totalComputed?: number;
  warning?: string;
  styles: Record<string, string> | Record<string, StyleEntry>;
  inheritedChain?: InheritedEntry[];
}

interface InheritedEntry {
  tag: string;
  selector: string;
  properties: Record<string, StyleEntry>;
}

export async function computedStylesTool(params: ComputedStylesParams) {
  const {
    url,
    session_id,
    tab_id,
    selector,
    filter = "non-default",
    properties,
    includeSource = false,
    includeInherited = false,
    viewport = { width: 1280, height: 720 },
    actions = [],
    useBrowserStack = false,
  } = params;

  if (!session_id && !url) {
    return {
      content: [{ type: "text" as const, text: "url is required when session_id is not provided" }],
      isError: true,
    };
  }

  let page: Page;
  let context: BrowserContext;
  let cleanup: (() => Promise<void>) | null = null;

  if (session_id) {
    sessionManager.touch(session_id);
    page = sessionManager.getPage(session_id, tab_id);
    context = sessionManager.getContext(session_id);
  } else {
    const session = await launchSession({
      browser: "chromium" as BrowserName,
      viewport,
      useBrowserStack,
      ...pickBrowserStack(params),
    });
    page = session.page;
    context = session.context;
    cleanup = () => closeSession(session);
  }

  try {
    if (url) await navigateTo(page, url);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    let result: StylesResult;

    if (includeSource && !useBrowserStack) {
      result = await getStylesWithSource(page, context, selector, filter, properties, includeInherited);
    } else {
      result = await getComputedStyles(page, selector, filter, properties);
      if (includeSource && useBrowserStack) {
        result.warning = "includeSource is not supported with BrowserStack — source info omitted";
      }
    }

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) {
      content.push({ type: "text", text: actionStopMsg });
    }
    if (assertionsMsg) {
      content.push({ type: "text", text: assertionsMsg });
    }
    content.push({ type: "text", text: JSON.stringify(result, null, 2) });
    return { content };
  } finally {
    if (cleanup) await cleanup();
  }
}

async function getComputedStyles(
  page: import("playwright").Page,
  selector: string,
  filter: "all" | "non-default",
  properties?: string[],
): Promise<StylesResult> {
  return page.evaluate(
    ({ sel, filterMode, props }) => {
      const el = document.querySelector(sel);
      if (!el) {
        return {
          selector: sel,
          tag: "",
          propertyCount: 0,
          styles: {},
          warning: `No element found matching selector: ${sel}`,
        };
      }

      const computed = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();

      // Specific properties requested — just return those
      if (props && props.length > 0) {
        const styles: Record<string, string> = {};
        for (const prop of props) {
          styles[prop] = computed.getPropertyValue(prop);
        }
        return { selector: sel, tag, propertyCount: props.length, styles };
      }

      // Collect all computed properties
      const allStyles: Record<string, string> = {};
      for (let i = 0; i < computed.length; i++) {
        const prop = computed[i];
        allStyles[prop] = computed.getPropertyValue(prop);
      }

      if (filterMode === "all") {
        return {
          selector: sel,
          tag,
          propertyCount: Object.keys(allStyles).length,
          styles: allStyles,
        };
      }

      // Non-default: diff against a fresh reference element of the same tag
      const container = document.createElement("div");
      container.style.cssText =
        "position:fixed;left:-99999px;top:-99999px;visibility:hidden;all:initial;";
      document.body.appendChild(container);

      const ref = document.createElement(tag);
      // Copy attributes that affect default styles
      for (const attr of ["type", "role", "contenteditable"]) {
        if (el.hasAttribute(attr)) ref.setAttribute(attr, el.getAttribute(attr)!);
      }
      container.appendChild(ref);

      const refComputed = getComputedStyle(ref);
      const nonDefault: Record<string, string> = {};

      for (const prop of Object.keys(allStyles)) {
        if (allStyles[prop] !== refComputed.getPropertyValue(prop)) {
          nonDefault[prop] = allStyles[prop];
        }
      }

      document.body.removeChild(container);

      return {
        selector: sel,
        tag,
        propertyCount: Object.keys(nonDefault).length,
        totalComputed: Object.keys(allStyles).length,
        styles: nonDefault,
      };
    },
    { sel: selector, filterMode: filter, props: properties },
  );
}

async function getStylesWithSource(
  page: Page,
  context: BrowserContext,
  selector: string,
  filter: "all" | "non-default",
  properties?: string[],
  includeInherited?: boolean,
): Promise<StylesResult> {
  const cdp = await context.newCDPSession(page);

  // Collect stylesheet headers as they are reported during CSS.enable
  const stylesheetHeaders = new Map<string, { sourceURL: string; startLine: number }>();
  cdp.on("CSS.styleSheetAdded", (event: any) => {
    const h = event.header;
    stylesheetHeaders.set(h.styleSheetId, {
      sourceURL: h.sourceURL || "",
      startLine: h.startLine ?? 0,
    });
  });

  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");

    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });

    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });

    if (!nodeId) {
      return {
        selector,
        tag: "",
        propertyCount: 0,
        styles: {},
        warning: `No element found matching selector: ${selector}`,
      };
    }

    // Get tag name
    const { node } = await cdp.send("DOM.describeNode", { nodeId });
    const tag = (node.localName as string) ?? "";

    // Get all computed properties (authoritative list for filtering)
    const { computedStyle } = await cdp.send("CSS.getComputedStyleForNode", { nodeId });
    const computedMap: Record<string, string> = {};
    for (const entry of computedStyle as Array<{ name: string; value: string }>) {
      computedMap[entry.name] = entry.value;
    }

    // Get matched rules for source tracing
    const matched = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });

    // Resolve a source string from a rule
    function resolveSource(rule: any): string {
      const origin: string = rule.origin ?? "regular";
      if (origin === "user-agent") return "(user-agent)";
      if (origin === "inspector") return "(inspector)";

      const sheetId: string | undefined = rule.styleSheetId ?? rule.style?.styleSheetId;
      if (!sheetId) return `(${origin})`;

      const header = stylesheetHeaders.get(sheetId);
      if (!header) return `(${origin})`;

      const range = rule.style?.range;
      if (!range) {
        return header.sourceURL ? header.sourceURL : `(${origin})`;
      }

      const line = header.startLine + (range.startLine as number) + 1;
      const col = (range.startColumn as number) + 1;
      const file = header.sourceURL || "(inline <style>)";
      return `${file}:${line}:${col}`;
    }

    // Build property -> best source mapping by walking the cascade
    // CDP returns matchedCSSRules from least to most specific, so later entries win
    const propertySource = new Map<string, StyleEntry>();

    // User-agent / inherited base
    if (matched.matchedCSSRules) {
      for (const ruleMatch of matched.matchedCSSRules as any[]) {
        const rule = ruleMatch.rule;
        const selectorText: string = rule.selectorList?.text ?? "";
        const source = resolveSource(rule);

        for (const prop of (rule.style?.cssProperties ?? []) as Array<{
          name: string;
          value: string;
          disabled?: boolean;
          parsedOk?: boolean;
          important?: boolean;
        }>) {
          if (!prop.name || prop.disabled || prop.parsedOk === false) continue;
          propertySource.set(prop.name, {
            value: prop.value,
            source,
            selector: selectorText,
          });
        }
      }
    }

    // Inline styles override everything
    if (matched.inlineStyle) {
      for (const prop of (matched.inlineStyle.cssProperties ?? []) as Array<{
        name: string;
        value: string;
        disabled?: boolean;
        parsedOk?: boolean;
      }>) {
        if (!prop.name || prop.disabled || prop.parsedOk === false) continue;
        propertySource.set(prop.name, {
          value: prop.value,
          source: "(inline style)",
          selector: "(inline)",
        });
      }
    }

    // Mark inherited properties from ancestor chain
    if (includeInherited && matched.inherited) {
      for (const entry of matched.inherited as any[]) {
        for (const ruleMatch of entry.matchedCSSRules ?? []) {
          const rule = ruleMatch.rule;
          const selectorText: string = rule.selectorList?.text ?? "";
          const source = resolveSource(rule);
          for (const prop of (rule.style?.cssProperties ?? []) as Array<{
            name: string;
            value: string;
            disabled?: boolean;
            parsedOk?: boolean;
          }>) {
            if (!prop.name || prop.disabled || prop.parsedOk === false) continue;
            if (!propertySource.has(prop.name)) {
              propertySource.set(prop.name, {
                value: prop.value,
                source,
                selector: selectorText,
                inherited: true,
              });
            }
          }
        }
      }
    }

    // Determine which properties to include
    let propsToInclude: string[];
    if (properties && properties.length > 0) {
      propsToInclude = properties;
    } else if (filter === "non-default") {
      // Use the page to compute defaults for this tag
      const defaults = await page.evaluate((tagName: string) => {
        const container = document.createElement("div");
        container.style.cssText =
          "position:fixed;left:-99999px;top:-99999px;visibility:hidden;all:initial;";
        document.body.appendChild(container);
        const ref = document.createElement(tagName);
        container.appendChild(ref);
        const refComputed = getComputedStyle(ref);
        const result: Record<string, string> = {};
        for (let i = 0; i < refComputed.length; i++) {
          const p = refComputed[i];
          result[p] = refComputed.getPropertyValue(p);
        }
        document.body.removeChild(container);
        return result;
      }, tag);

      propsToInclude = Object.keys(computedMap).filter(
        (p) => computedMap[p] !== (defaults[p] ?? ""),
      );
    } else {
      propsToInclude = Object.keys(computedMap);
    }

    // Build final styles object
    const styles: Record<string, StyleEntry> = {};
    for (const prop of propsToInclude) {
      const entry = propertySource.get(prop);
      if (entry) {
        styles[prop] = entry;
      } else {
        // Computed but no matched rule — browser default or inherited without a rule
        styles[prop] = { value: computedMap[prop] ?? "", source: "(user-agent)" };
      }
    }

    // Build inheritedChain if requested
    let inheritedChain: InheritedEntry[] | undefined;
    if (includeInherited && matched.inherited) {
      inheritedChain = [];
      for (const entry of matched.inherited as any[]) {
        const ancestorNodeId: number = entry.nodeId ?? 0;
        let ancestorTag = "";
        let ancestorSelector = "";
        if (ancestorNodeId) {
          try {
            const { node: ancestorNode } = await cdp.send("DOM.describeNode", {
              nodeId: ancestorNodeId,
            });
            ancestorTag = (ancestorNode.localName as string) ?? "";
            const idAttr = (ancestorNode.attributes as string[])?.indexOf("id");
            const classAttr = (ancestorNode.attributes as string[])?.indexOf("class");
            if (idAttr !== undefined && idAttr >= 0) {
              ancestorSelector = `${ancestorTag}#${(ancestorNode.attributes as string[])[idAttr + 1]}`;
            } else if (classAttr !== undefined && classAttr >= 0) {
              ancestorSelector = `${ancestorTag}.${(ancestorNode.attributes as string[])[classAttr + 1].split(" ").join(".")}`;
            } else {
              ancestorSelector = ancestorTag;
            }
          } catch {
            ancestorTag = "(unknown)";
            ancestorSelector = "(unknown)";
          }
        }

        const chainProps: Record<string, StyleEntry> = {};
        for (const ruleMatch of entry.matchedCSSRules ?? []) {
          const rule = ruleMatch.rule;
          const selectorText: string = rule.selectorList?.text ?? "";
          const source = resolveSource(rule);
          for (const prop of (rule.style?.cssProperties ?? []) as Array<{
            name: string;
            value: string;
            disabled?: boolean;
            parsedOk?: boolean;
          }>) {
            if (!prop.name || prop.disabled || prop.parsedOk === false) continue;
            chainProps[prop.name] = { value: prop.value, source, selector: selectorText };
          }
        }

        if (Object.keys(chainProps).length > 0) {
          inheritedChain.push({ tag: ancestorTag, selector: ancestorSelector, properties: chainProps });
        }
      }
    }

    const result: StylesResult = {
      selector,
      tag,
      propertyCount: Object.keys(styles).length,
      styles,
    };
    if (filter === "non-default" && !properties) {
      result.totalComputed = Object.keys(computedMap).length;
    }
    if (inheritedChain && inheritedChain.length > 0) {
      result.inheritedChain = inheritedChain;
    }

    return result;
  } finally {
    await cdp.send("CSS.disable").catch(() => {});
    await cdp.send("DOM.disable").catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

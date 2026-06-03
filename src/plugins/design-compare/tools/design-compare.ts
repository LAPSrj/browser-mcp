import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, pickBrowserStack, type BrowserStackTarget, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface PseudoElementExpected {
  "::before"?: Record<string, string>;
  "::after"?: Record<string, string>;
}

export interface DesignCompareElement {
  name: string;
  selector: string;
  expected: Record<string, string>;
  pseudoElements?: PseudoElementExpected;
  expectedTag?: string;
  expectedText?: string;
}

export interface GapCheck {
  between: [string, string];
  expected: string;
  axis: "vertical" | "horizontal";
}

export interface ContainmentCheck {
  child: string;
  parent: string;
  expectClipped: boolean;
}

export interface LayoutChecks {
  gaps?: GapCheck[];
  containment?: ContainmentCheck[];
}

export interface DesignCompareParams extends BrowserStackTarget {
  url: string;
  viewport?: { width: number; height: number };
  elements: DesignCompareElement[];
  layout?: LayoutChecks;
  tolerance?: number;
  freezeAnimations?: boolean;
  actions?: AnyAction[];
  useBrowserStack?: boolean;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

interface PropertyResult {
  property: string;
  expected: string;
  actual: string;
  match: boolean;
  delta?: string;
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PseudoElementResult {
  pseudo: string;
  found: boolean;
  results: PropertyResult[];
  matches: number;
  mismatches: number;
}

interface FontWarning {
  property: string;
  font: string;
  loaded: boolean;
}

interface ElementResult {
  name: string;
  selector: string;
  found: boolean;
  matchCount?: number;
  boundingBox?: BoundingBox;
  results: PropertyResult[];
  pseudoElements?: PseudoElementResult[];
  fontWarnings?: FontWarning[];
  tagMismatch?: { expected: string; actual: string };
  textMismatch?: { expected: string; actual: string };
  matches: number;
  mismatches: number;
}

interface GapResult {
  between: [string, string];
  axis: string;
  expected: string;
  actual: string;
  match: boolean;
  delta?: string;
  error?: string;
}

interface ContainmentResult {
  child: string;
  parent: string;
  contained: boolean;
  expectClipped: boolean;
  match: boolean;
  overflow?: { top?: number; right?: number; bottom?: number; left?: number };
}

interface OverlapResult {
  elementA: string;
  elementB: string;
  overlapArea: number;
  overlapBox: BoundingBox;
}

interface LayoutResult {
  gaps?: GapResult[];
  containment?: ContainmentResult[];
  overlaps?: OverlapResult[];
}

interface CompareResult {
  url: string;
  viewport: { width: number; height: number };
  tolerance: number;
  actions?: Array<{ action: string; hasEvaluate?: boolean }>;
  summary: {
    totalElements: number;
    elementsFound: number;
    totalProperties: number;
    matches: number;
    mismatches: number;
    layoutChecks?: number;
    layoutPassed?: number;
    layoutFailed?: number;
  };
  elements: ElementResult[];
  layout?: LayoutResult;
}

// ---------------------------------------------------------------------------
// Property classification
// ---------------------------------------------------------------------------

const COLOR_PROPERTIES = new Set([
  "color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "box-shadow",
  "fill",
  "stroke",
]);

const KEYWORD_PROPERTIES = new Set([
  "font-weight",
  "text-transform",
  "display",
  "position",
  "visibility",
  "overflow",
  "overflow-x",
  "overflow-y",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "align-self",
  "text-align",
  "white-space",
  "word-break",
  "box-sizing",
  "float",
  "clear",
  "cursor",
  "pointer-events",
  "font-style",
  "text-decoration-line",
  "text-decoration-style",
  "list-style-type",
  "border-style",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
]);

// ---------------------------------------------------------------------------
// Browser data types (returned from page.evaluate)
// ---------------------------------------------------------------------------

interface BrowserFontCheck {
  property: string;
  font: string;
  loaded: boolean;
}

interface BrowserElementData {
  found: boolean;
  matchCount: number;
  styles: Record<string, string>;
  resolvedExpected: Record<string, string>;
  boundingBox: BoundingBox | null;
  pseudoBefore: Record<string, string> | null;
  pseudoAfter: Record<string, string> | null;
  resolvedPseudoBefore: Record<string, string> | null;
  resolvedPseudoAfter: Record<string, string> | null;
  pseudoBeforeExists: boolean;
  pseudoAfterExists: boolean;
  fontChecks: BrowserFontCheck[];
  tag: string;
  textContent: string;
}

interface BrowserBboxData {
  found: boolean;
  bbox: BoundingBox | null;
}

// ---------------------------------------------------------------------------
// Main tool
// ---------------------------------------------------------------------------

export async function designCompareTool(params: DesignCompareParams) {
  const {
    url,
    viewport = { width: 1440, height: 900 },
    elements,
    layout,
    tolerance: rawTolerance = 0.5,
    freezeAnimations = false,
    actions = [],
    useBrowserStack = false,
  } = params;

  const MAX_TOLERANCE = 2;
  const tolerance = Math.min(rawTolerance, MAX_TOLERANCE);

  const session = await launchSession({
    browser: "chromium" as BrowserName,
    viewport,
    useBrowserStack,
    ...pickBrowserStack(params),
  });

  try {
    await navigateTo(session.page, url);

    if (freezeAnimations) {
      await session.page.evaluate(() => {
        const style = document.createElement("style");
        style.textContent = "*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }";
        document.head.appendChild(style);
      });
    }

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(session.page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    // ---- Batch-extract element styles, bounding boxes, and pseudo-elements ----
    const selectors = elements.map((el) => el.selector);
    const propertyLists = elements.map((el) => Object.keys(el.expected));
    const expectedValues = elements.map((el) => el.expected);
    const pseudoBeforeProps = elements.map((el) =>
      el.pseudoElements?.["::before"] ? Object.keys(el.pseudoElements["::before"]) : null,
    );
    const pseudoAfterProps = elements.map((el) =>
      el.pseudoElements?.["::after"] ? Object.keys(el.pseudoElements["::after"]) : null,
    );
    const pseudoBeforeValues = elements.map((el) =>
      el.pseudoElements?.["::before"] ?? null,
    );
    const pseudoAfterValues = elements.map((el) =>
      el.pseudoElements?.["::after"] ?? null,
    );

    const browserResults: BrowserElementData[] = await session.page.evaluate(
      ({ selectors, propertyLists, expectedValues, pseudoBeforeProps, pseudoAfterProps, pseudoBeforeValues, pseudoAfterValues }) => {
        function resolveExpectedValues(
          el: Element,
          expected: Record<string, string>,
          properties: string[],
        ): Record<string, string> {
          const parent = el.parentElement ?? document.body;
          const clone = document.createElement(el.tagName.toLowerCase());
          clone.style.cssText = "position:fixed;left:-99999px;top:-99999px;visibility:hidden;pointer-events:none;";
          const elFontSize = getComputedStyle(el).getPropertyValue("font-size");
          clone.style.setProperty("font-size", elFontSize);
          for (const [prop, val] of Object.entries(expected)) {
            clone.style.setProperty(prop, val);
          }
          parent.appendChild(clone);
          const resolved: Record<string, string> = {};
          const cloneComputed = getComputedStyle(clone);
          for (const prop of properties) {
            resolved[prop] = cloneComputed.getPropertyValue(prop);
          }
          parent.removeChild(clone);
          return resolved;
        }

        return selectors.map((sel, i) => {
          const empty = {
            found: false,
            matchCount: 0,
            styles: {},
            resolvedExpected: {},
            boundingBox: null,
            pseudoBefore: null,
            pseudoAfter: null,
            resolvedPseudoBefore: null,
            resolvedPseudoAfter: null,
            pseudoBeforeExists: false,
            pseudoAfterExists: false,
            fontChecks: [] as Array<{ property: string; font: string; loaded: boolean }>,
            tag: "",
            textContent: "",
          };

          let all: NodeListOf<Element>;
          try {
            all = document.querySelectorAll(sel);
          } catch {
            return empty;
          }
          if (all.length === 0) return empty;

          const el = all[0];
          const computed = getComputedStyle(el);
          const styles: Record<string, string> = {};
          for (const prop of propertyLists[i]) {
            styles[prop] = computed.getPropertyValue(prop);
          }

          const resolvedExpected = resolveExpectedValues(el, expectedValues[i], propertyLists[i]);

          const rect = el.getBoundingClientRect();
          const boundingBox = {
            x: Math.round(rect.x * 100) / 100,
            y: Math.round(rect.y * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          };

          const fontProps = ["font-family", "font"];
          const fontChecks: Array<{ property: string; font: string; loaded: boolean }> = [];
          for (const prop of fontProps) {
            if (propertyLists[i].includes(prop)) {
              const actualFamily = computed.getPropertyValue("font-family");
              const fontSize = computed.getPropertyValue("font-size");
              const families = actualFamily.split(",").map((f: string) => f.trim().replace(/^["']|["']$/g, ""));
              for (const family of families) {
                const loaded = document.fonts.check(`${fontSize} "${family}"`);
                if (!loaded) {
                  fontChecks.push({ property: prop, font: family, loaded: false });
                }
              }
            }
          }

          let pseudoBefore: Record<string, string> | null = null;
          let resolvedPseudoBefore: Record<string, string> | null = null;
          let pseudoBeforeExists = false;
          if (pseudoBeforeProps[i]) {
            const beforeComputed = getComputedStyle(el, "::before");
            const content = beforeComputed.getPropertyValue("content");
            pseudoBeforeExists = content !== "none" && content !== "";
            pseudoBefore = {};
            for (const prop of pseudoBeforeProps[i]!) {
              pseudoBefore[prop] = beforeComputed.getPropertyValue(prop);
            }
            if (pseudoBeforeValues[i]) {
              resolvedPseudoBefore = resolveExpectedValues(el, pseudoBeforeValues[i]!, pseudoBeforeProps[i]!);
            }
          }

          let pseudoAfter: Record<string, string> | null = null;
          let resolvedPseudoAfter: Record<string, string> | null = null;
          let pseudoAfterExists = false;
          if (pseudoAfterProps[i]) {
            const afterComputed = getComputedStyle(el, "::after");
            const content = afterComputed.getPropertyValue("content");
            pseudoAfterExists = content !== "none" && content !== "";
            pseudoAfter = {};
            for (const prop of pseudoAfterProps[i]!) {
              pseudoAfter[prop] = afterComputed.getPropertyValue(prop);
            }
            if (pseudoAfterValues[i]) {
              resolvedPseudoAfter = resolveExpectedValues(el, pseudoAfterValues[i]!, pseudoAfterProps[i]!);
            }
          }

          return {
            found: true,
            matchCount: all.length,
            styles,
            resolvedExpected,
            boundingBox,
            pseudoBefore,
            pseudoAfter,
            resolvedPseudoBefore,
            resolvedPseudoAfter,
            pseudoBeforeExists,
            pseudoAfterExists,
            fontChecks,
            tag: el.tagName.toLowerCase(),
            textContent: (el.textContent ?? "").trim().slice(0, 200),
          };
        });
      },
      { selectors, propertyLists, expectedValues, pseudoBeforeProps, pseudoAfterProps, pseudoBeforeValues, pseudoAfterValues },
    );

    // ---- Process element comparisons ----
    let totalMatches = 0;
    let totalMismatches = 0;
    let totalProperties = 0;
    let elementsFound = 0;

    const elementResults: ElementResult[] = elements.map((el, i) => {
      const browser = browserResults[i];

      if (!browser.found) {
        const propCount = countExpectedProperties(el);
        totalProperties += propCount;
        totalMismatches += propCount;
        return {
          name: el.name,
          selector: el.selector,
          found: false,
          matchCount: 0,
          results: Object.entries(el.expected).map(([prop, expected]) => ({
            property: prop,
            expected,
            actual: "(element not found)",
            match: false,
          })),
          matches: 0,
          mismatches: propCount,
        };
      }

      elementsFound++;
      let elMatches = 0;
      let elMismatches = 0;

      const results: PropertyResult[] = Object.entries(el.expected).map(
        ([property, expectedValue]) => {
          const actualValue = browser.styles[property] ?? "";
          const resolvedExpected = browser.resolvedExpected[property] ?? expectedValue;
          totalProperties++;
          const match = compareValues(property, resolvedExpected, actualValue, tolerance);
          if (match) {
            elMatches++;
            totalMatches++;
            return { property, expected: expectedValue, actual: actualValue, match: true };
          } else {
            elMismatches++;
            totalMismatches++;
            const delta = computeDelta(property, resolvedExpected, actualValue);
            return { property, expected: expectedValue, actual: actualValue, match: false, delta };
          }
        },
      );

      // ---- Pseudo-element comparisons ----
      const pseudoResults: PseudoElementResult[] = [];

      if (el.pseudoElements?.["::before"] && browser.pseudoBefore) {
        const pr = comparePseudoElement(
          "::before",
          el.pseudoElements["::before"],
          browser.pseudoBefore,
          browser.resolvedPseudoBefore,
          browser.pseudoBeforeExists,
          tolerance,
        );
        pseudoResults.push(pr);
        totalProperties += pr.results.length;
        totalMatches += pr.matches;
        totalMismatches += pr.mismatches;
        elMatches += pr.matches;
        elMismatches += pr.mismatches;
      }

      if (el.pseudoElements?.["::after"] && browser.pseudoAfter) {
        const pr = comparePseudoElement(
          "::after",
          el.pseudoElements["::after"],
          browser.pseudoAfter,
          browser.resolvedPseudoAfter,
          browser.pseudoAfterExists,
          tolerance,
        );
        pseudoResults.push(pr);
        totalProperties += pr.results.length;
        totalMatches += pr.matches;
        totalMismatches += pr.mismatches;
        elMatches += pr.matches;
        elMismatches += pr.mismatches;
      }

      const fontWarnings = browser.fontChecks.length > 0 ? browser.fontChecks : undefined;

      const tagMismatch = el.expectedTag && browser.tag !== el.expectedTag.toLowerCase()
        ? { expected: el.expectedTag.toLowerCase(), actual: browser.tag }
        : undefined;

      const textMismatch = el.expectedText !== undefined
        ? (() => {
            const actualText = browser.textContent;
            const expectedText = el.expectedText.trim().slice(0, 200);
            return actualText !== expectedText
              ? { expected: expectedText, actual: actualText }
              : undefined;
          })()
        : undefined;

      return {
        name: el.name,
        selector: el.selector,
        found: true,
        matchCount: browser.matchCount,
        boundingBox: browser.boundingBox ?? undefined,
        results,
        pseudoElements: pseudoResults.length > 0 ? pseudoResults : undefined,
        fontWarnings,
        ...(tagMismatch ? { tagMismatch } : {}),
        ...(textMismatch ? { textMismatch } : {}),
        matches: elMatches,
        mismatches: elMismatches,
      };
    });

    // ---- Layout checks ----
    let layoutResult: LayoutResult | undefined;
    let layoutChecks = 0;
    let layoutPassed = 0;
    let layoutFailed = 0;

    if (layout) {
      layoutResult = {};

      if (layout.gaps && layout.gaps.length > 0) {
        const gapSelectors = new Set<string>();
        for (const g of layout.gaps) {
          gapSelectors.add(g.between[0]);
          gapSelectors.add(g.between[1]);
        }
        const uniqueSelectors = [...gapSelectors];

        const bboxes: BrowserBboxData[] = await session.page.evaluate(
          (sels) => sels.map((sel) => {
            let el: Element | null;
            try { el = document.querySelector(sel); } catch { return { found: false, bbox: null }; }
            if (!el) return { found: false, bbox: null };
            const rect = el.getBoundingClientRect();
            return {
              found: true,
              bbox: {
                x: Math.round(rect.x * 100) / 100,
                y: Math.round(rect.y * 100) / 100,
                width: Math.round(rect.width * 100) / 100,
                height: Math.round(rect.height * 100) / 100,
              },
            };
          }),
          uniqueSelectors,
        );

        const bboxMap = new Map<string, BoundingBox>();
        uniqueSelectors.forEach((sel, i) => {
          if (bboxes[i].found && bboxes[i].bbox) {
            bboxMap.set(sel, bboxes[i].bbox!);
          }
        });

        layoutResult.gaps = layout.gaps.map((g) => {
          layoutChecks++;
          const bboxA = bboxMap.get(g.between[0]);
          const bboxB = bboxMap.get(g.between[1]);

          if (!bboxA || !bboxB) {
            layoutFailed++;
            const missing = !bboxA ? g.between[0] : g.between[1];
            return {
              between: g.between,
              axis: g.axis,
              expected: g.expected,
              actual: "(element not found)",
              match: false,
              error: `Selector not found: ${missing}`,
            };
          }

          let actualGap: number;
          if (g.axis === "vertical") {
            actualGap = bboxB.y - (bboxA.y + bboxA.height);
          } else {
            actualGap = bboxB.x - (bboxA.x + bboxA.width);
          }
          actualGap = Math.round(actualGap * 100) / 100;

          const expectedNum = parseNumericValue(g.expected.trim().toLowerCase());
          const match = expectedNum !== null && Math.abs(actualGap - expectedNum.value) <= tolerance;

          if (match) {
            layoutPassed++;
          } else {
            layoutFailed++;
          }

          const actualStr = `${actualGap}px`;
          return {
            between: g.between,
            axis: g.axis,
            expected: g.expected,
            actual: actualStr,
            match,
            delta: match ? undefined : computeDelta("gap", g.expected, actualStr),
          };
        });
      }

      if (layout.containment && layout.containment.length > 0) {
        const containSelectors = new Set<string>();
        for (const c of layout.containment) {
          containSelectors.add(c.child);
          containSelectors.add(c.parent);
        }
        const uniqueContainSelectors = [...containSelectors];

        const containBboxes: BrowserBboxData[] = await session.page.evaluate(
          (sels) => sels.map((sel) => {
            let el: Element | null;
            try { el = document.querySelector(sel); } catch { return { found: false, bbox: null }; }
            if (!el) return { found: false, bbox: null };
            const rect = el.getBoundingClientRect();
            return {
              found: true,
              bbox: {
                x: Math.round(rect.x * 100) / 100,
                y: Math.round(rect.y * 100) / 100,
                width: Math.round(rect.width * 100) / 100,
                height: Math.round(rect.height * 100) / 100,
              },
            };
          }),
          uniqueContainSelectors,
        );

        const containBboxMap = new Map<string, BoundingBox>();
        uniqueContainSelectors.forEach((sel, i) => {
          if (containBboxes[i].found && containBboxes[i].bbox) {
            containBboxMap.set(sel, containBboxes[i].bbox!);
          }
        });

        layoutResult.containment = layout.containment.map((c) => {
          layoutChecks++;
          const childBox = containBboxMap.get(c.child);
          const parentBox = containBboxMap.get(c.parent);

          if (!childBox || !parentBox) {
            layoutFailed++;
            return {
              child: c.child,
              parent: c.parent,
              contained: false,
              expectClipped: c.expectClipped,
              match: false,
            };
          }

          const overflow: { top?: number; right?: number; bottom?: number; left?: number } = {};
          const topOverflow = parentBox.y - childBox.y;
          const rightOverflow = (childBox.x + childBox.width) - (parentBox.x + parentBox.width);
          const bottomOverflow = (childBox.y + childBox.height) - (parentBox.y + parentBox.height);
          const leftOverflow = parentBox.x - childBox.x;

          if (topOverflow > tolerance) overflow.top = Math.round(topOverflow * 100) / 100;
          if (rightOverflow > tolerance) overflow.right = Math.round(rightOverflow * 100) / 100;
          if (bottomOverflow > tolerance) overflow.bottom = Math.round(bottomOverflow * 100) / 100;
          if (leftOverflow > tolerance) overflow.left = Math.round(leftOverflow * 100) / 100;

          const contained = Object.keys(overflow).length === 0;
          const match = c.expectClipped ? !contained : contained;

          if (match) {
            layoutPassed++;
          } else {
            layoutFailed++;
          }

          return {
            child: c.child,
            parent: c.parent,
            contained,
            expectClipped: c.expectClipped,
            match,
            overflow: Object.keys(overflow).length > 0 ? overflow : undefined,
          };
        });
      }
    }

    // ---- Build result ----
    const summaryBase = {
      totalElements: elements.length,
      elementsFound,
      totalProperties,
      matches: totalMatches,
      mismatches: totalMismatches,
    };

    const summary = layoutChecks > 0
      ? { ...summaryBase, layoutChecks, layoutPassed, layoutFailed }
      : summaryBase;

    const actionsSummary = actions.length > 0
      ? actions.map((a) => ({
          action: (a as any).action ?? "unknown",
          ...(((a as any).action === "evaluate") ? { hasEvaluate: true } : {}),
        }))
      : undefined;

    const result: CompareResult = {
      url,
      viewport,
      tolerance,
      ...(actionsSummary ? { actions: actionsSummary } : {}),
      summary,
      elements: elementResults,
      layout: layoutResult,
    };

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });
    content.push({ type: "text", text: JSON.stringify(result, null, 2) });
    return { content };
  } finally {
    await closeSession(session);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countExpectedProperties(el: DesignCompareElement): number {
  let count = Object.keys(el.expected).length;
  if (el.pseudoElements?.["::before"]) count += Object.keys(el.pseudoElements["::before"]).length;
  if (el.pseudoElements?.["::after"]) count += Object.keys(el.pseudoElements["::after"]).length;
  return count;
}

function comparePseudoElement(
  pseudo: string,
  expected: Record<string, string>,
  actual: Record<string, string>,
  resolved: Record<string, string> | null,
  exists: boolean,
  tolerance: number,
): PseudoElementResult {
  if (!exists) {
    return {
      pseudo,
      found: false,
      results: Object.entries(expected).map(([prop, exp]) => ({
        property: prop,
        expected: exp,
        actual: "(pseudo-element not rendered)",
        match: false,
      })),
      matches: 0,
      mismatches: Object.keys(expected).length,
    };
  }

  let matches = 0;
  let mismatches = 0;
  const results: PropertyResult[] = Object.entries(expected).map(([property, expectedValue]) => {
    const actualValue = actual[property] ?? "";
    const resolvedExpected = resolved?.[property] ?? expectedValue;
    const match = compareValues(property, resolvedExpected, actualValue, tolerance);
    if (match) {
      matches++;
      return { property, expected: expectedValue, actual: actualValue, match: true };
    } else {
      mismatches++;
      const delta = computeDelta(property, resolvedExpected, actualValue);
      return { property, expected: expectedValue, actual: actualValue, match: false, delta };
    }
  });

  return { pseudo, found: true, results, matches, mismatches };
}

function compareValues(
  property: string,
  expected: string,
  actual: string,
  tolerance: number,
): boolean {
  const normExpected = expected.trim().toLowerCase();
  const normActual = actual.trim().toLowerCase();

  if (normExpected === normActual) return true;

  if (property === "font-family" || property === "font") {
    return compareFontFamily(normExpected, normActual);
  }

  if (COLOR_PROPERTIES.has(property)) {
    return normalizeColor(normExpected) === normalizeColor(normActual);
  }

  if (KEYWORD_PROPERTIES.has(property)) {
    return normExpected === normActual;
  }

  const expNum = parseNumericValue(normExpected);
  const actNum = parseNumericValue(normActual);
  if (expNum !== null && actNum !== null && expNum.unit === actNum.unit) {
    return Math.abs(expNum.value - actNum.value) <= tolerance;
  }

  return false;
}

function computeDelta(
  property: string,
  expected: string,
  actual: string,
): string {
  const normExpected = expected.trim().toLowerCase();
  const normActual = actual.trim().toLowerCase();

  if (COLOR_PROPERTIES.has(property)) {
    return `expected '${expected}' got '${actual}'`;
  }

  const expNum = parseNumericValue(normExpected);
  const actNum = parseNumericValue(normActual);
  if (expNum !== null && actNum !== null && expNum.unit === actNum.unit) {
    const diff = actNum.value - expNum.value;
    const sign = diff > 0 ? "+" : "";
    const rounded = Math.round(diff * 100) / 100;
    return `${sign}${rounded}${actNum.unit}`;
  }

  return `expected '${expected}' got '${actual}'`;
}

function parseNumericValue(
  value: string,
): { value: number; unit: string } | null {
  const match = value.match(/^(-?\d+(?:\.\d+)?)\s*(px|em|rem|%|vh|vw|pt|cm|mm|in|deg|s|ms)?$/);
  if (!match) return null;
  return { value: parseFloat(match[1]), unit: match[2] ?? "" };
}

function normalizeColor(color: string): string {
  const hex = parseHexColor(color);
  if (hex) return hex;

  const rgb = parseRgbColor(color);
  if (rgb) return `rgb(${rgb.r},${rgb.g},${rgb.b})`;

  const named = NAMED_COLORS[color];
  if (named) return named;

  return color;
}

function parseHexColor(color: string): string | null {
  const match = color.match(/^#([0-9a-f]{3,8})$/);
  if (!match) return null;
  let hex = match[1];

  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  } else if (hex.length === 4) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgb(${r},${g},${b})`;
}

function parseRgbColor(color: string): { r: number; g: number; b: number } | null {
  const match = color.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/,
  );
  if (!match) return null;
  return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
}

const NAMED_COLORS: Record<string, string> = {
  white: "rgb(255,255,255)",
  black: "rgb(0,0,0)",
  red: "rgb(255,0,0)",
  green: "rgb(0,128,0)",
  blue: "rgb(0,0,255)",
  transparent: "rgba(0,0,0,0)",
};

function parseFontStack(value: string): string[] {
  return value.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase());
}

function compareFontFamily(expected: string, actual: string): boolean {
  const expFonts = parseFontStack(expected);
  const actFonts = parseFontStack(actual);
  if (expFonts.length === 0) return false;
  return expFonts[0] === actFonts[0];
}

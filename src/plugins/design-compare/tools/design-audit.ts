import fs from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";
import { saveFile, generateFilename } from "../../../utils/file.js";
import { createPreviewBuffer } from "../../../utils/resize.js";
import { findDiffClusters, type DiffCluster, type ElementHint } from "../../../utils/diff-clusters.js";
import { annotateClusters } from "../../../utils/cluster-dom-hints.js";
import type {
  DesignCompareElement,
  LayoutChecks,
} from "./design-compare.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface DesignAuditParams {
  url: string;
  referenceImage?: string;
  referenceUrl?: string;
  rootSelector: string;
  viewport?: { width: number; height: number };
  elements: DesignCompareElement[];
  layout?: LayoutChecks;
  tolerance?: number;
  freezeAnimations?: boolean;
  hideSelectors?: string[];
  knownExclusions?: string[];
  diffMode?: "precise" | "design";
  diffThreshold?: number;
  actions?: AnyAction[];
  outputDir?: string;
  useBrowserStack?: boolean;
  coverageManifest?: {
    nodeNames: string[];
    propertyCounts: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------
// Output types (reusing from design-compare where possible)
// ---------------------------------------------------------------------------

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PropertyResult {
  property: string;
  expected: string;
  actual: string;
  match: boolean;
  delta?: string;
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

interface ElementStyleResult {
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

interface CrossCheckCluster {
  cluster: BoundingBox;
  pixels: number;
  overlapsElements: string[];
  mismatches: string[];
  status: "explained" | "excluded" | "unexplained";
  /** elementsFromPoint at cluster center, top 5 stacked. Populated for unexplained clusters. */
  domHints?: ElementHint[];
  /** Bbox-intersection candidates ranked by impact. Populated for unexplained clusters. */
  intersecting?: ElementHint[];
  /**
   * Fallback element when domHints and intersecting are both empty — the
   * smallest fully-containing element plus the cluster's offset inside it.
   * Populated only when the primary hints come up empty.
   */
  containerHint?: ElementHint & { offsetWithin: { x: number; y: number } };
  note?: string;
}

interface AuditResult {
  url: string;
  viewport: { width: number; height: number };
  tolerance: number;
  actions?: Array<{ action: string; hasEvaluate?: boolean }>;
  hiddenArea?: number;
  summary: {
    totalElements: number;
    elementsFound: number;
    totalProperties: number;
    propertyMatches: number;
    propertyMismatches: number;
    layoutChecks?: number;
    layoutPassed?: number;
    layoutFailed?: number;
    visualDiffScore: number;
    visualDiffMatch: boolean;
    explainedClusters: number;
    excludedClusters: number;
    unexplainedClusters: number;
    /**
     * Populated when the captured element screenshot and the reference image
     * have different dimensions. The pixelmatch step auto-crops to the min
     * dimensions, so clusters may fall outside the comparable region; a
     * deltaPct over ~5 usually means the reference isn't comparable as-is.
     */
    dimensionMismatch?: {
      live: { width: number; height: number };
      ref: { width: number; height: number };
      deltaW: number;
      deltaH: number;
      deltaPctW: number;
      deltaPctH: number;
    };
  };
  designCompare: {
    elements: ElementStyleResult[];
    layout?: {
      gaps?: GapResult[];
      containment?: ContainmentResult[];
    };
  };
  visualDiff: {
    score: number;
    diffPercentage: number;
    mismatchedPixels: number;
    totalPixels: number;
    diffImagePath: string;
    diffPreviewPath: string;
    clusters: DiffCluster[];
  };
  crossCheck: CrossCheckCluster[];
  coverage?: {
    elementCoverage: { tested: number; total: number; percentage: number };
    propertyCoverage: { tested: number; total: number; percentage: number };
    unmappedNodes: Array<{ name: string; propertyCount: number }>;
    perElement?: Array<{ name: string; testedProperties: string[]; manifestCount: number }>;
  };
}

// ---------------------------------------------------------------------------
// Property classification (duplicated from design-compare to avoid coupling
// the two files' internal types — they share the same logic)
// ---------------------------------------------------------------------------

const COLOR_PROPERTIES = new Set([
  "color", "background-color", "border-color", "border-top-color",
  "border-right-color", "border-bottom-color", "border-left-color",
  "outline-color", "text-decoration-color", "box-shadow", "fill", "stroke",
]);

const KEYWORD_PROPERTIES = new Set([
  "font-weight", "text-transform", "display", "position", "visibility",
  "overflow", "overflow-x", "overflow-y", "flex-direction", "flex-wrap",
  "justify-content", "align-items", "align-self", "text-align", "white-space",
  "word-break", "box-sizing", "float", "clear", "cursor", "pointer-events",
  "font-style", "text-decoration-line", "text-decoration-style",
  "list-style-type", "border-style", "border-top-style", "border-right-style",
  "border-bottom-style", "border-left-style",
]);

// ---------------------------------------------------------------------------
// Browser data types
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
  boundingBox: BoundingBox | null;
  resolvedExpected: Record<string, string>;
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

export async function designAuditTool(params: DesignAuditParams) {
  const {
    url,
    referenceImage,
    referenceUrl,
    rootSelector,
    viewport = { width: 1440, height: 900 },
    elements,
    layout,
    tolerance: rawTolerance = 0.5,
    freezeAnimations = false,
    hideSelectors = [],
    knownExclusions = [],
    diffMode = "design",
    diffThreshold,
    actions = [],
    outputDir = ".browser",
    useBrowserStack = false,
    coverageManifest,
  } = params;

  const MAX_TOLERANCE = 2;
  const tolerance = Math.min(rawTolerance, MAX_TOLERANCE);

  const session = await launchSession({
    browser: "chromium" as BrowserName,
    viewport,
    useBrowserStack,
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

    // ==== PHASE 1: Design Compare (deterministic CSS checks) ====

    const selectors = elements.map((el) => el.selector);
    const propertyLists = elements.map((el) => Object.keys(el.expected));
    const expectedValues = elements.map((el) => el.expected);
    const pseudoBeforeProps = elements.map((el) =>
      el.pseudoElements?.["::before"] ? Object.keys(el.pseudoElements["::before"]) : null,
    );
    const pseudoAfterProps = elements.map((el) =>
      el.pseudoElements?.["::after"] ? Object.keys(el.pseudoElements["::after"]) : null,
    );
    const pseudoBeforeValues = elements.map((el) => el.pseudoElements?.["::before"] ?? null);
    const pseudoAfterValues = elements.map((el) => el.pseudoElements?.["::after"] ?? null);

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
            found: false, matchCount: 0, styles: {}, resolvedExpected: {}, boundingBox: null,
            pseudoBefore: null, pseudoAfter: null,
            resolvedPseudoBefore: null, resolvedPseudoAfter: null,
            pseudoBeforeExists: false, pseudoAfterExists: false,
            fontChecks: [] as Array<{ property: string; font: string; loaded: boolean }>,
            tag: "", textContent: "",
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
            const bc = getComputedStyle(el, "::before");
            const content = bc.getPropertyValue("content");
            pseudoBeforeExists = content !== "none" && content !== "";
            pseudoBefore = {};
            for (const prop of pseudoBeforeProps[i]!) pseudoBefore[prop] = bc.getPropertyValue(prop);
            if (pseudoBeforeValues[i]) {
              resolvedPseudoBefore = resolveExpectedValues(el, pseudoBeforeValues[i]!, pseudoBeforeProps[i]!);
            }
          }

          let pseudoAfter: Record<string, string> | null = null;
          let resolvedPseudoAfter: Record<string, string> | null = null;
          let pseudoAfterExists = false;
          if (pseudoAfterProps[i]) {
            const ac = getComputedStyle(el, "::after");
            const content = ac.getPropertyValue("content");
            pseudoAfterExists = content !== "none" && content !== "";
            pseudoAfter = {};
            for (const prop of pseudoAfterProps[i]!) pseudoAfter[prop] = ac.getPropertyValue(prop);
            if (pseudoAfterValues[i]) {
              resolvedPseudoAfter = resolveExpectedValues(el, pseudoAfterValues[i]!, pseudoAfterProps[i]!);
            }
          }

          return {
            found: true, matchCount: all.length, styles, resolvedExpected, boundingBox,
            pseudoBefore, pseudoAfter, resolvedPseudoBefore, resolvedPseudoAfter,
            pseudoBeforeExists, pseudoAfterExists, fontChecks,
            tag: el.tagName.toLowerCase(),
            textContent: (el.textContent ?? "").trim().slice(0, 200),
          };
        });
      },
      { selectors, propertyLists, expectedValues, pseudoBeforeProps, pseudoAfterProps, pseudoBeforeValues, pseudoAfterValues },
    );

    // Process element comparisons
    let totalMatches = 0;
    let totalMismatches = 0;
    let totalProperties = 0;
    let elementsFound = 0;

    const elementResults: ElementStyleResult[] = elements.map((el, i) => {
      const browser = browserResults[i];

      if (!browser.found) {
        const propCount = countExpectedProperties(el);
        totalProperties += propCount;
        totalMismatches += propCount;
        return {
          name: el.name, selector: el.selector, found: false, matchCount: 0,
          results: Object.entries(el.expected).map(([prop, exp]) => ({
            property: prop, expected: exp, actual: "(element not found)", match: false,
          })),
          matches: 0, mismatches: propCount,
        };
      }

      elementsFound++;
      let elMatches = 0;
      let elMismatches = 0;

      const results: PropertyResult[] = Object.entries(el.expected).map(([property, expectedValue]) => {
        const actualValue = browser.styles[property] ?? "";
        const resolvedExpected = browser.resolvedExpected[property] ?? expectedValue;
        totalProperties++;
        const match = compareValues(property, resolvedExpected, actualValue, tolerance);
        if (match) { elMatches++; totalMatches++; }
        else { elMismatches++; totalMismatches++; }
        return {
          property, expected: expectedValue, actual: actualValue, match,
          delta: match ? undefined : computeDelta(property, resolvedExpected, actualValue),
        };
      });

      const pseudoResults: PseudoElementResult[] = [];
      if (el.pseudoElements?.["::before"] && browser.pseudoBefore) {
        const pr = comparePseudoElement("::before", el.pseudoElements["::before"], browser.pseudoBefore, browser.resolvedPseudoBefore, browser.pseudoBeforeExists, tolerance);
        pseudoResults.push(pr);
        totalProperties += pr.results.length;
        totalMatches += pr.matches;
        totalMismatches += pr.mismatches;
        elMatches += pr.matches;
        elMismatches += pr.mismatches;
      }
      if (el.pseudoElements?.["::after"] && browser.pseudoAfter) {
        const pr = comparePseudoElement("::after", el.pseudoElements["::after"], browser.pseudoAfter, browser.resolvedPseudoAfter, browser.pseudoAfterExists, tolerance);
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
        name: el.name, selector: el.selector, found: true,
        matchCount: browser.matchCount,
        boundingBox: browser.boundingBox ?? undefined,
        results,
        pseudoElements: pseudoResults.length > 0 ? pseudoResults : undefined,
        fontWarnings,
        ...(tagMismatch ? { tagMismatch } : {}),
        ...(textMismatch ? { textMismatch } : {}),
        matches: elMatches, mismatches: elMismatches,
      };
    });

    // Layout checks
    let layoutResult: { gaps?: GapResult[]; containment?: ContainmentResult[] } | undefined;
    let layoutChecks = 0;
    let layoutPassed = 0;
    let layoutFailed = 0;

    if (layout) {
      layoutResult = {};

      if (layout.gaps && layout.gaps.length > 0) {
        const gapSelectors = new Set<string>();
        for (const g of layout.gaps) { gapSelectors.add(g.between[0]); gapSelectors.add(g.between[1]); }
        const uniqueSels = [...gapSelectors];

        const bboxes: BrowserBboxData[] = await session.page.evaluate(
          (sels) => sels.map((sel) => {
            let el: Element | null;
            try { el = document.querySelector(sel); } catch { return { found: false, bbox: null }; }
            if (!el) return { found: false, bbox: null };
            const rect = el.getBoundingClientRect();
            return { found: true, bbox: { x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 } };
          }),
          uniqueSels,
        );

        const bboxMap = new Map<string, BoundingBox>();
        uniqueSels.forEach((sel, i) => { if (bboxes[i].found && bboxes[i].bbox) bboxMap.set(sel, bboxes[i].bbox!); });

        layoutResult.gaps = layout.gaps.map((g) => {
          layoutChecks++;
          const bboxA = bboxMap.get(g.between[0]);
          const bboxB = bboxMap.get(g.between[1]);
          if (!bboxA || !bboxB) {
            layoutFailed++;
            return { between: g.between, axis: g.axis, expected: g.expected, actual: "(element not found)", match: false, error: `Selector not found: ${!bboxA ? g.between[0] : g.between[1]}` };
          }
          let actualGap = g.axis === "vertical"
            ? bboxB.y - (bboxA.y + bboxA.height)
            : bboxB.x - (bboxA.x + bboxA.width);
          actualGap = Math.round(actualGap * 100) / 100;
          const expectedNum = parseNumericValue(g.expected.trim().toLowerCase());
          const match = expectedNum !== null && Math.abs(actualGap - expectedNum.value) <= tolerance;
          if (match) layoutPassed++; else layoutFailed++;
          const actualStr = `${actualGap}px`;
          return { between: g.between, axis: g.axis, expected: g.expected, actual: actualStr, match, delta: match ? undefined : computeDelta("gap", g.expected, actualStr) };
        });
      }

      if (layout.containment && layout.containment.length > 0) {
        const cSels = new Set<string>();
        for (const c of layout.containment) { cSels.add(c.child); cSels.add(c.parent); }
        const uniqueCSels = [...cSels];

        const cBboxes: BrowserBboxData[] = await session.page.evaluate(
          (sels) => sels.map((sel) => {
            let el: Element | null;
            try { el = document.querySelector(sel); } catch { return { found: false, bbox: null }; }
            if (!el) return { found: false, bbox: null };
            const rect = el.getBoundingClientRect();
            return { found: true, bbox: { x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 } };
          }),
          uniqueCSels,
        );

        const cBboxMap = new Map<string, BoundingBox>();
        uniqueCSels.forEach((sel, i) => { if (cBboxes[i].found && cBboxes[i].bbox) cBboxMap.set(sel, cBboxes[i].bbox!); });

        layoutResult.containment = layout.containment.map((c) => {
          layoutChecks++;
          const childBox = cBboxMap.get(c.child);
          const parentBox = cBboxMap.get(c.parent);
          if (!childBox || !parentBox) { layoutFailed++; return { child: c.child, parent: c.parent, contained: false, expectClipped: c.expectClipped, match: false }; }

          const overflow: { top?: number; right?: number; bottom?: number; left?: number } = {};
          const topO = parentBox.y - childBox.y;
          const rightO = (childBox.x + childBox.width) - (parentBox.x + parentBox.width);
          const bottomO = (childBox.y + childBox.height) - (parentBox.y + parentBox.height);
          const leftO = parentBox.x - childBox.x;
          if (topO > tolerance) overflow.top = Math.round(topO * 100) / 100;
          if (rightO > tolerance) overflow.right = Math.round(rightO * 100) / 100;
          if (bottomO > tolerance) overflow.bottom = Math.round(bottomO * 100) / 100;
          if (leftO > tolerance) overflow.left = Math.round(leftO * 100) / 100;

          const contained = Object.keys(overflow).length === 0;
          const match = c.expectClipped ? !contained : contained;
          if (match) layoutPassed++; else layoutFailed++;
          return { child: c.child, parent: c.parent, contained, expectClipped: c.expectClipped, match, overflow: Object.keys(overflow).length > 0 ? overflow : undefined };
        });
      }
    }

    // ==== PHASE 2: Visual Diff (pixel-level safety net) ====

    // Get root element bbox for scoped screenshot
    const rootBbox: BoundingBox | null = await session.page.evaluate((sel) => {
      let el: Element | null;
      try { el = document.querySelector(sel); } catch { return null; }
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      };
    }, rootSelector);

    if (!rootBbox) {
      const content: Array<{ type: string; text: string }> = [];
      if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
      if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });
      content.push({ type: "text", text: JSON.stringify({
        error: `Root selector not found: ${rootSelector}`,
        designCompare: { elements: elementResults, layout: layoutResult },
      }, null, 2) });
      return { content };
    }

    // Gather exclusion bounding boxes BEFORE screenshot (same coordinate space as rootBbox)
    let exclusionBboxes: Array<{ selector: string; bbox: BoundingBox }> = [];
    if (knownExclusions.length > 0) {
      const exBboxes: Array<{ found: boolean; bbox: BoundingBox | null }> = await session.page.evaluate(
        (sels) => sels.map((sel) => {
          let el: Element | null;
          try { el = document.querySelector(sel); } catch { return { found: false, bbox: null }; }
          if (!el) return { found: false, bbox: null };
          const rect = el.getBoundingClientRect();
          return { found: true, bbox: { x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100, width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 } };
        }),
        knownExclusions,
      );
      for (let i = 0; i < knownExclusions.length; i++) {
        if (exBboxes[i].found && exBboxes[i].bbox) {
          const b = exBboxes[i].bbox!;
          exclusionBboxes.push({
            selector: knownExclusions[i],
            bbox: { x: Math.round((b.x - rootBbox.x) * 100) / 100, y: Math.round((b.y - rootBbox.y) * 100) / 100, width: b.width, height: b.height },
          });
        }
      }
    }

    let hiddenArea: number | undefined;
    if (hideSelectors.length > 0) {
      const hiddenPixels: number = await session.page.evaluate(
        ({ sels, rootArea }) => {
          let total = 0;
          for (const sel of sels) {
            try {
              document.querySelectorAll(sel).forEach((el) => {
                const rect = el.getBoundingClientRect();
                total += rect.width * rect.height;
                (el as HTMLElement).style.visibility = "hidden";
              });
            } catch { /* invalid selector — skip */ }
          }
          return rootArea > 0 ? Math.round((total / rootArea) * 1000) / 10 : 0;
        },
        { sels: hideSelectors, rootArea: rootBbox.width * rootBbox.height },
      );
      hiddenArea = hiddenPixels;
    }

    const rootElement = await session.page.$(rootSelector);
    const screenshotBuffer = rootElement
      ? await rootElement.screenshot({ type: "png" })
      : await session.page.screenshot({ type: "png", clip: rootBbox });

    let refBuffer: Buffer;
    if (referenceUrl) {
      const refSession = await launchSession({
        browser: "chromium" as BrowserName,
        viewport,
        useBrowserStack: false,
      });
      try {
        await navigateTo(refSession.page, referenceUrl);
        if (freezeAnimations) {
          await refSession.page.evaluate(() => {
            const style = document.createElement("style");
            style.textContent = "*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }";
            document.head.appendChild(style);
          });
        }
        refBuffer = Buffer.from(await refSession.page.screenshot({ type: "png", fullPage: true }));
      } finally {
        await closeSession(refSession);
      }
    } else if (referenceImage) {
      refBuffer = await fs.readFile(referenceImage);
    } else {
      const content: Array<{ type: string; text: string }> = [];
      content.push({ type: "text", text: JSON.stringify({
        error: "Either referenceImage or referenceUrl must be provided",
        designCompare: { elements: elementResults, layout: layoutResult },
      }, null, 2) });
      return { content };
    }

    const liveImg = PNG.sync.read(screenshotBuffer);
    const refImg = PNG.sync.read(refBuffer);

    let dimensionMismatch: AuditResult["summary"]["dimensionMismatch"];
    if (liveImg.width !== refImg.width || liveImg.height !== refImg.height) {
      const deltaW = liveImg.width - refImg.width;
      const deltaH = liveImg.height - refImg.height;
      const baseW = Math.max(liveImg.width, refImg.width);
      const baseH = Math.max(liveImg.height, refImg.height);
      dimensionMismatch = {
        live: { width: liveImg.width, height: liveImg.height },
        ref: { width: refImg.width, height: refImg.height },
        deltaW,
        deltaH,
        deltaPctW: baseW > 0 ? Math.round((Math.abs(deltaW) / baseW) * 1000) / 10 : 0,
        deltaPctH: baseH > 0 ? Math.round((Math.abs(deltaH) / baseH) * 1000) / 10 : 0,
      };
    }

    // Auto-crop to smaller dimensions
    let imgA: PNG = liveImg;
    let imgB: PNG = refImg;
    if (liveImg.width !== refImg.width || liveImg.height !== refImg.height) {
      const w = Math.min(liveImg.width, refImg.width);
      const h = Math.min(liveImg.height, refImg.height);
      imgA = cropPng(liveImg, w, h);
      imgB = cropPng(refImg, w, h);
    }

    const { width: diffW, height: diffH } = imgA;
    const diffPng = new PNG({ width: diffW, height: diffH });
    const modeThresholds = { precise: 0.1, design: 0.3 };
    const threshold = diffThreshold ?? modeThresholds[diffMode];

    const mismatchedPixels = pixelmatch(
      imgA.data, imgB.data, diffPng.data, diffW, diffH, { threshold },
    );

    const totalPixels = diffW * diffH;
    const diffPercentage = (mismatchedPixels / totalPixels) * 100;
    const visualScore = Math.round((1 - diffPercentage / 100) * 10000) / 10000;

    const clusters = findDiffClusters(diffPng, { topN: 10 });

    const diffBuf = PNG.sync.write(diffPng);
    const diffFilename = generateFilename({ prefix: "audit-diff", extension: "png" });
    const diffPath = await saveFile(path.join(outputDir, diffFilename), diffBuf);
    const previewFilename = generateFilename({ prefix: "audit-diff-preview", extension: "png" });
    const previewPath = await saveFile(path.join(outputDir, previewFilename), createPreviewBuffer(diffBuf));

    // ==== PHASE 3: Cross-check (map clusters to elements) ====

    const elementBboxes: Array<{ name: string; bbox: BoundingBox; mismatches: string[] }> = [];
    for (const er of elementResults) {
      if (er.found && er.boundingBox) {
        const mismatches = er.results.filter((r) => !r.match).map((r) => r.property);
        // Adjust element bbox relative to root
        const relBbox: BoundingBox = {
          x: Math.round((er.boundingBox.x - rootBbox.x) * 100) / 100,
          y: Math.round((er.boundingBox.y - rootBbox.y) * 100) / 100,
          width: er.boundingBox.width,
          height: er.boundingBox.height,
        };
        elementBboxes.push({ name: er.name, bbox: relBbox, mismatches });
      }
    }

    // Re-query root bbox for cluster annotation (screenshot may have scrolled the page)
    const postScrollRootBbox: BoundingBox | null = await session.page.evaluate((sel) => {
      let el: Element | null;
      try { el = document.querySelector(sel); } catch { return null; }
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      };
    }, rootSelector);
    const annotationRoot = postScrollRootBbox ?? rootBbox;

    const annotations = await annotateClusters(session.page, clusters, {
      offsetX: annotationRoot.x,
      offsetY: annotationRoot.y,
    });

    const crossCheck: CrossCheckCluster[] = clusters.map((cluster, ci) => {
      const clusterBox: BoundingBox = { x: cluster.x, y: cluster.y, width: cluster.width, height: cluster.height };
      const overlapping: Array<{ name: string; mismatches: string[] }> = [];

      for (const eb of elementBboxes) {
        if (bboxesOverlap(clusterBox, eb.bbox)) {
          overlapping.push({ name: eb.name, mismatches: eb.mismatches });
        }
      }

      const allMismatches = overlapping.flatMap((o) => o.mismatches);

      // Determine status
      let status: "explained" | "excluded" | "unexplained";
      if (allMismatches.length > 0) {
        status = "explained";
      } else if (exclusionBboxes.some((ex) => bboxesOverlap(clusterBox, ex.bbox))) {
        status = "excluded";
      } else {
        status = "unexplained";
      }

      const result: CrossCheckCluster = {
        cluster: clusterBox,
        pixels: cluster.pixels,
        overlapsElements: overlapping.map((o) => o.name),
        mismatches: allMismatches,
        status,
      };

      if (status === "unexplained") {
        const ann = annotations[ci];
        if (ann) {
          result.domHints = ann.centerStack;
          result.intersecting = ann.intersecting;
          if (ann.containerHint) result.containerHint = ann.containerHint;
        }
        result.note = overlapping.length > 0
          ? "Visual mismatch not explained by property comparison — investigate pseudo-element, cascade, or compositional issue"
          : "Visual mismatch in area with no compared elements — check for missing element in elements[] array";
      }

      return result;
    });

    const explainedClusters = crossCheck.filter((c) => c.status === "explained").length;
    const excludedClusters = crossCheck.filter((c) => c.status === "excluded").length;
    const unexplainedClusters = crossCheck.filter((c) => c.status === "unexplained").length;

    // ==== Build result ====

    // Coverage computation (if manifest provided)
    let coverage: AuditResult["coverage"];
    if (coverageManifest) {
      const testedNames = new Set(elements.map((el) => el.name));
      const manifestNames = coverageManifest.nodeNames;
      const unmappedNodes = manifestNames
        .filter((n) => !testedNames.has(n))
        .map((n) => ({ name: n, propertyCount: coverageManifest.propertyCounts[n] ?? 0 }));
      const testedCount = manifestNames.filter((n) => testedNames.has(n)).length;
      const totalNodes = manifestNames.length;

      let totalManifestProps = 0;
      let testedProps = 0;
      for (const [nodeName, count] of Object.entries(coverageManifest.propertyCounts)) {
        totalManifestProps += count;
        if (testedNames.has(nodeName)) {
          const el = elements.find((e) => e.name === nodeName);
          testedProps += el ? Object.keys(el.expected).length : 0;
        }
      }

      const perElement: Array<{ name: string; testedProperties: string[]; manifestCount: number }> = [];
      for (const el of elements) {
        if (manifestNames.includes(el.name)) {
          perElement.push({
            name: el.name,
            testedProperties: Object.keys(el.expected),
            manifestCount: coverageManifest.propertyCounts[el.name] ?? 0,
          });
        }
      }

      coverage = {
        elementCoverage: {
          tested: testedCount,
          total: totalNodes,
          percentage: totalNodes > 0 ? Math.round((testedCount / totalNodes) * 1000) / 10 : 0,
        },
        propertyCoverage: {
          tested: testedProps,
          total: totalManifestProps,
          percentage: totalManifestProps > 0 ? Math.round((testedProps / totalManifestProps) * 1000) / 10 : 0,
        },
        unmappedNodes,
        perElement: perElement.length > 0 ? perElement : undefined,
      };
    }

    const actionsSummary = actions.length > 0
      ? actions.map((a) => ({
          action: (a as any).action ?? "unknown",
          ...(((a as any).action === "evaluate") ? { hasEvaluate: true } : {}),
        }))
      : undefined;

    const result: AuditResult = {
      url,
      viewport,
      tolerance,
      ...(actionsSummary ? { actions: actionsSummary } : {}),
      ...(hiddenArea !== undefined ? { hiddenArea } : {}),
      summary: {
        totalElements: elements.length,
        elementsFound,
        totalProperties,
        propertyMatches: totalMatches,
        propertyMismatches: totalMismatches,
        ...(layoutChecks > 0 ? { layoutChecks, layoutPassed, layoutFailed } : {}),
        visualDiffScore: visualScore,
        visualDiffMatch: diffPercentage <= 5,
        explainedClusters,
        excludedClusters,
        unexplainedClusters,
        ...(dimensionMismatch ? { dimensionMismatch } : {}),
      },
      designCompare: {
        elements: elementResults,
        layout: layoutResult,
      },
      visualDiff: {
        score: visualScore,
        diffPercentage: Math.round(diffPercentage * 100) / 100,
        mismatchedPixels,
        totalPixels,
        diffImagePath: diffPath,
        diffPreviewPath: previewPath,
        clusters,
      },
      crossCheck,
      ...(coverage ? { coverage } : {}),
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

function bboxesOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function cropPng(src: PNG, w: number, h: number): PNG {
  const dst = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const srcOff = (y * src.width) << 2;
    const dstOff = (y * w) << 2;
    src.data.copy(dst.data, dstOff, srcOff, srcOff + (w << 2));
  }
  return dst;
}

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
      pseudo, found: false,
      results: Object.entries(expected).map(([prop, exp]) => ({
        property: prop, expected: exp, actual: "(pseudo-element not rendered)", match: false,
      })),
      matches: 0, mismatches: Object.keys(expected).length,
    };
  }
  let matches = 0;
  let mismatches = 0;
  const results: PropertyResult[] = Object.entries(expected).map(([property, expectedValue]) => {
    const actualValue = actual[property] ?? "";
    const resolvedExpected = resolved?.[property] ?? expectedValue;
    const match = compareValues(property, resolvedExpected, actualValue, tolerance);
    if (match) matches++; else mismatches++;
    return {
      property, expected: expectedValue, actual: actualValue, match,
      delta: match ? undefined : computeDelta(property, resolvedExpected, actualValue),
    };
  });
  return { pseudo, found: true, results, matches, mismatches };
}

function compareValues(property: string, expected: string, actual: string, tolerance: number): boolean {
  const normExpected = expected.trim().toLowerCase();
  const normActual = actual.trim().toLowerCase();
  if (normExpected === normActual) return true;
  if (property === "font-family" || property === "font") return compareFontFamily(normExpected, normActual);
  if (COLOR_PROPERTIES.has(property)) return normalizeColor(normExpected) === normalizeColor(normActual);
  if (KEYWORD_PROPERTIES.has(property)) return normExpected === normActual;
  const expNum = parseNumericValue(normExpected);
  const actNum = parseNumericValue(normActual);
  if (expNum !== null && actNum !== null && expNum.unit === actNum.unit) {
    return Math.abs(expNum.value - actNum.value) <= tolerance;
  }
  return false;
}

function computeDelta(property: string, expected: string, actual: string): string {
  const normExpected = expected.trim().toLowerCase();
  const normActual = actual.trim().toLowerCase();
  if (COLOR_PROPERTIES.has(property)) return `expected '${expected}' got '${actual}'`;
  const expNum = parseNumericValue(normExpected);
  const actNum = parseNumericValue(normActual);
  if (expNum !== null && actNum !== null && expNum.unit === actNum.unit) {
    const diff = actNum.value - expNum.value;
    const sign = diff > 0 ? "+" : "";
    return `${sign}${Math.round(diff * 100) / 100}${actNum.unit}`;
  }
  return `expected '${expected}' got '${actual}'`;
}

function parseNumericValue(value: string): { value: number; unit: string } | null {
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
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  else if (hex.length === 4) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  return `rgb(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)})`;
}

function parseRgbColor(color: string): { r: number; g: number; b: number } | null {
  const match = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/);
  if (!match) return null;
  return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
}

const NAMED_COLORS: Record<string, string> = {
  white: "rgb(255,255,255)", black: "rgb(0,0,0)", red: "rgb(255,0,0)",
  green: "rgb(0,128,0)", blue: "rgb(0,0,255)", transparent: "rgba(0,0,0,0)",
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

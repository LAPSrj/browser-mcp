import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import type {
  ScreenshotPlugin,
  PluginContext,
  PluginConfigSchema,
} from "../types.js";
import { actionSchema, actionsDesc, useSchemaField, browserStackFields } from "../../utils/schemas.js";
import { sessionManager } from "../../core/sessions.js";
import { consoleCaptureTool } from "./tools/console-capture.js";
import { domSnapshotTool } from "./tools/dom-snapshot.js";
import { accessibilitySnapshotTool } from "./tools/accessibility.js";
import { axeAuditTool } from "./tools/axe-audit.js";
import { visualDiffTool } from "./tools/visual-diff.js";
import { compareScreenshotTool } from "./tools/compare-screenshot.js";
import { compareElementTool } from "./tools/compare-element.js";
import { alignElementsTool } from "./tools/align-elements.js";
import { networkLogTool } from "./tools/network-log.js";
import { pageMetadataTool } from "./tools/page-metadata.js";
import { performanceMetricsTool } from "./tools/performance.js";
import { computedStylesTool } from "./tools/computed-styles.js";
import { evaluateScriptTool } from "./tools/evaluate-script.js";
import { schemaExtractTool } from "./tools/schema-extract.js";
import { listInteractiveElementsTool } from "./tools/list-interactive-elements.js";
import { domQueryTool } from "./tools/dom-query.js";
import { hitTestTool } from "./tools/hit-test.js";
import { styleCheckTool } from "./tools/style-check.js";

// Dev plugin: developer-inspection tools that a regular user can't perform
// in a browser without DevTools. Enable via BROWSER_MCP_PLUGINS=dev.
// Declares prefixTools: false so these keep their well-known short names.
const devPlugin: ScreenshotPlugin = {
  name: "dev",
  version: "0.1.0",
  prefixTools: false,

  getConfigSchema(): PluginConfigSchema {
    return {};
  },

  async register(ctx: PluginContext): Promise<void> {
    const { config } = ctx;
    const defaultOutputDir = config.outputDir ?? ".browser";
    const resolveUrl = ctx.core.resolveUrl;

    const urlCaptureDesc = config.baseUrl
      ? `Absolute URL or path relative to ${config.baseUrl}`
      : "Absolute URL";

    const withUrl = <T extends { url: string }>(p: T): T => ({
      ...p,
      url: resolveUrl(p.url, config.baseUrl),
    });
    const withUrlAndOut = <T extends { url: string; outputDir?: string }>(p: T): T => ({
      ...p,
      url: resolveUrl(p.url, config.baseUrl),
      outputDir: p.outputDir ?? defaultOutputDir,
    });
    // Variant for session-aware tools where url is optional (omitted when
    // session_id is provided — tool runs against the session's current page).
    const withOptionalUrl = <T extends { url?: string }>(p: T): T => ({
      ...p,
      url: p.url ? resolveUrl(p.url, config.baseUrl) : undefined,
    });

    const urlOptionalDesc =
      "Navigate here first. Required without session_id" +
      (config.baseUrl ? `; may be relative to ${config.baseUrl}` : "");
    const sessionIdDesc = "open_session id. Without url, runs on the session's current page (no navigation)";
    const tabIdDesc = "Session tab (default: active)";

    // ---------- console_capture ----------
    ctx.registerTool({
      name: "console_capture",
      description:
        "Capture console logs, warnings, errors, and page errors. Only events after this call starts are seen; pass url to capture a fresh load.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Ephemeral only (default "chromium")'),
        actions: z.array(actionSchema).optional().describe(actionsDesc + " Runs while capturing."),
        outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
        toFile: z.boolean().optional().describe("Write logs to a file (default false)"),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        summaryOnly: z.boolean().optional().describe("Return { totalLogs, byType, errorPreviews } (top 5, 200 chars each) instead of all logs; larger than full output below ~5 logs (default false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await consoleCaptureTool({
        ...withOptionalUrl(params),
        outputDir: params.outputDir ?? defaultOutputDir,
      })) as any,
    });

    // ---------- dom_snapshot ----------
    ctx.registerTool({
      name: "dom_snapshot",
      description:
        "Simplified DOM tree (tags, ids, classes, text) of the page or an element. For specific fields of known elements use dom_query.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        selector: z.string().optional().describe('Root CSS selector (default "body")'),
        maxDepth: z.number().optional().describe("Default 5"),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        summaryOnly: z.boolean().optional().describe("Return { rootTag, totalNodes, maxDepthReached, truncatedBranches, byTag } instead of the tree (default false)"),
        profile: z.enum(["walker"]).optional().describe('"walker" sets summaryOnly:true; explicit flags win'),
        ...useSchemaField,
      },
      handler: async (params) => (await domSnapshotTool(withOptionalUrl(params))) as any,
    });

    // ---------- accessibility_snapshot ----------
    ctx.registerTool({
      name: "accessibility_snapshot",
      description:
        "Accessibility tree: roles, accessible names, values. Good first look at an unknown page; names feed click selectors like " +
        "`role=button[name=\"Submit\"]`. assertRules runs named a11y checks. For a flat list of clickables with ready selectors use " +
        "list_interactive_elements; for a full WCAG audit use axe_audit.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        scope: z.string().optional().describe("CSS selector scoping tree and asserts (default body)"),
        assertRules: z
          .array(
            z.enum([
              "section-has-name",
              "details-summary-has-heading",
              "region-has-roledescription",
              "button-has-name",
              "img-has-alt",
              "form-control-has-label",
            ]),
          )
          .optional()
          .describe("Returns pass/fail per rule"),
        skipTree: z.boolean().optional().describe("Omit the tree, e.g. to get only assertRules results (default false)"),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        summaryOnly: z.boolean().optional().describe("Return role counts { rootRole, totalNodes, maxDepth, byRole, headingCount, landmarkCount, namedNodeCount } instead of the tree; assertRules results stay full (default false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await accessibilitySnapshotTool(withOptionalUrl(params))) as any,
    });

    // ---------- axe_audit ----------
    ctx.registerTool({
      name: "axe_audit",
      description:
        "Run an axe-core accessibility audit; returns a summary (counts, impact) plus violations/passes/incomplete/inapplicable. Default rules: WCAG 2.0/2.1 A+AA and best-practice.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Ephemeral only (default "chromium")'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Ephemeral only (default 1280x720)"),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        waitForNetworkIdle: z.boolean().optional().describe("Default true"),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        include: z.array(z.string()).optional().describe("CSS selectors to limit the audit to (default: whole document)"),
        exclude: z.array(z.string()).optional().describe("CSS selectors to skip, e.g. third-party widgets"),
        tags: z.array(z.enum([
          "wcag2a",
          "wcag2aa",
          "wcag2aaa",
          "wcag21a",
          "wcag21aa",
          "wcag22aa",
          "best-practice",
          "ACT",
          "section508",
          "experimental",
        ])).optional().describe('Default ["wcag2a","wcag2aa","wcag21a","wcag21aa","best-practice"]. Ignored when rules is set'),
        rules: z.array(z.string()).optional().describe("axe rule IDs to run (e.g. [\"color-contrast\",\"label\"]); overrides tags"),
        disableRules: z.array(z.string()).optional().describe("axe rule IDs to skip, on top of tags or rules"),
        resultTypes: z.array(z.enum(["violations", "passes", "incomplete", "inapplicable"])).optional().describe('Buckets returned in full (default ["violations","incomplete"]); the summary always returns'),
        summaryOnly: z.boolean().optional().describe("Only the summary, no per-rule details (default false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await axeAuditTool({
        ...params,
        url: params.url ? resolveUrl(params.url, config.baseUrl) : undefined,
      })) as any,
    });

    // ---------- visual_diff ----------
    ctx.registerTool({
      name: "visual_diff",
      description:
        "Pixel-compare two PNG files; writes a diff image and returns the mismatch %. To capture a live page against a reference use compare_screenshot or compare_element.",
      schema: {
        imageA: z.string().describe("PNG path"),
        imageB: z.string().describe("PNG path"),
        outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
        mode: z.enum(["precise", "design"]).optional().describe('"precise" (threshold 0.1) for screenshots of the same page, "design" (0.3) for design mockups (default "precise")'),
        threshold: z.number().optional().describe("Per-pixel threshold 0-1; overrides mode"),
        maxDiffPercent: z.number().optional().describe("Max diff % that still matches (default 5)"),
        crop: z.boolean().optional().describe("Crop both to the smaller size when sizes differ (default false)"),
        ...useSchemaField,
      },
      handler: async (params) =>
        (await visualDiffTool({ ...params, outputDir: params.outputDir ?? defaultOutputDir })) as any,
    });

    // ---------- compare_screenshot ----------
    const ignoreElementSchema = z.object({
      selector: z.string().describe("CSS selector"),
      mode: z.enum(["invisible", "position-only"]).describe(
        '"invisible" excludes the area; "position-only" paints a solid block so only position/size are compared',
      ),
    });
    const ignoreRegionSchema = z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      mode: z.enum(["invisible", "position-only"]).optional().describe('Default "invisible"'),
      reason: z.string().optional().describe("Note echoed back in the result"),
    });
    const summaryOnlyCompareDesc =
      "Return only match/diff %, a mask line, top clusters on one line, and file paths; no cluster DOM notes or preview files (default false)";

    ctx.registerTool({
      name: "compare_screenshot",
      description:
        "Screenshot a URL (fresh ephemeral browser) and pixel-compare it with a reference PNG. Viewport width is set to the reference width. " +
        "Returns match, diff %, and top diff clusters. For one element use compare_element; to find element shifts use align_elements.",
      schema: {
        url: z.string().describe(urlCaptureDesc),
        referenceImage: z.string().describe("Reference PNG path"),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Default "chromium"'),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
        mode: z.enum(["precise", "design"]).optional().describe('"precise" (threshold 0.1) for screenshots of the same page, "design" (0.3) for design mockups (default "precise")'),
        threshold: z.number().optional().describe("Per-pixel threshold 0-1; overrides mode"),
        maxDiffPercent: z.number().optional().describe("Max diff % that still matches (default 5)"),
        waitForNetworkIdle: z.boolean().optional().describe("Default true"),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        delay: z.number().optional().describe("Extra ms before capture (default 0)"),
        startY: z.number().optional().describe("Clip top, px. The reference must already be cropped to the same clip"),
        endY: z.number().optional().describe("Clip bottom, px"),
        startX: z.number().optional().describe("Clip left, px"),
        endX: z.number().optional().describe("Clip right, px"),
        ignoreImages: z.boolean().optional().describe("Paint <img> as solid blocks, comparing only position/size (default false)"),
        ignoreBackgrounds: z.boolean().optional().describe("Same for CSS background-image elements (default false)"),
        ignoreAllImages: z.boolean().optional().describe("ignoreImages + ignoreBackgrounds"),
        ignoreText: z.boolean().optional().describe("Mask each text line in position-only mode"),
        ignoreElements: z.array(ignoreElementSchema).optional().describe("Masked at the same coordinates on both images"),
        ignoreRegions: z.array(ignoreRegionSchema).optional().describe("Pixel regions masked on both images"),
        summaryOnly: z.boolean().optional().describe(summaryOnlyCompareDesc),
        clustersTopN: z.number().optional().describe("Default 5"),
        profile: z.enum(["walker"]).optional().describe('"walker" sets summaryOnly:true, clustersTopN:3; explicit flags win'),
        ...useSchemaField,
      },
      handler: async (params) => (await compareScreenshotTool(withUrlAndOut(params))) as any,
    });

    // ---------- compare_element ----------
    ctx.registerTool({
      name: "compare_element",
      description:
        "Pixel-compare one element: screenshots the page, crops the element (plus padding) from both the live page and the reference PNG at the same coordinates, and diffs them.",
      schema: {
        url: z.string().describe(urlCaptureDesc),
        referenceImage: z.string().describe("Reference PNG path"),
        selector: z.string().describe("CSS selector"),
        padding: z.number().optional().describe("px around the element box (default 50)"),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Default "chromium"'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Default: the reference image size"),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
        mode: z.enum(["precise", "design"]).optional().describe('Default "precise"'),
        threshold: z.number().optional().describe("Per-pixel threshold 0-1"),
        maxDiffPercent: z.number().optional().describe("Default 5"),
        waitForNetworkIdle: z.boolean().optional().describe("Default true"),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        delay: z.number().optional().describe("Extra ms before capture (default 0)"),
        ignoreImages: z.boolean().optional().describe("Paint <img> as solid blocks (default false)"),
        ignoreBackgrounds: z.boolean().optional().describe("Paint background-image elements as solid blocks (default false)"),
        ignoreAllImages: z.boolean().optional().describe("ignoreImages + ignoreBackgrounds"),
        ignoreText: z.boolean().optional().describe("Mask each text line in position-only mode"),
        ignoreElements: z.array(ignoreElementSchema).optional(),
        ignoreRegions: z.array(ignoreRegionSchema).optional().describe("Pixel regions to mask"),
        boundsHandling: z.enum(["strict", "intersect"]).optional().describe('"strict" (default) errors if the crop extends past the reference; "intersect" clamps it to the reference'),
        alignTo: z.enum(["top", "center"]).optional().describe("Exclusive with alignOn"),
        alignOn: z
          .object({
            referenceRect: z.object({
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
            }),
            frontendSelector: z.string(),
            mode: z.enum(["top-left", "center"]).optional(),
          })
          .optional()
          .describe("Shift the reference crop so this anchor (reference rect, live selector) lines up before diffing"),
        summaryOnly: z.boolean().optional().describe(summaryOnlyCompareDesc),
        clustersTopN: z.number().optional().describe("Default 5"),
        profile: z.enum(["walker"]).optional().describe('"walker" sets summaryOnly:true, clustersTopN:3; explicit flags win'),
        ...useSchemaField,
      },
      handler: async (params) => (await compareElementTool(withUrlAndOut(params))) as any,
    });

    // ---------- align_elements ----------
    ctx.registerTool({
      name: "align_elements",
      description:
        "For each element, find the integer translate(dx, dy) that makes its pixels best match the reference PNG (pixel search, not DOM coordinates). " +
        "Candidates come from diff clusters in scope unless selectors is given. Elements sharing a shift are reported at their common ancestor. " +
        "Returns per-element delta, baseline vs aligned diff scores, and a class: translation, rigid-with-parent, content-change, size-mismatch, ambiguous, or no-clusters.",
      schema: {
        url: z.string().describe(urlCaptureDesc),
        referenceImage: z.string().describe("Reference PNG path"),
        scope: z.string().optional().describe('Root selector for candidate discovery (default "body")'),
        selectors: z.array(z.string()).optional().describe("Elements to align; skips discovery"),
        refineRadius: z.number().optional().describe("Min search radius, px (default 3)"),
        maxRadius: z.number().optional().describe("Max search radius, px (default 60; grows once if hit)"),
        uniformityTolerance: z.number().optional().describe("Max px distance between deltas counted as one shared shift (default 2)"),
        minImprovement: z.number().optional().describe("Min score gain 0-1 to classify as translation, else content-change (default 0.005)"),
        applyTransform: z.boolean().optional().describe("Apply the found transforms live and capture an aligned screenshot (default true)"),
        topClusters: z.number().optional().describe("Diff clusters considered for discovery (default 12)"),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Default "chromium"'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Default: the reference image size"),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        outputDir: z.string().optional().describe(`Default "${defaultOutputDir}"`),
        mode: z.enum(["precise", "design"]).optional().describe('Default "design". Affects only the baseline/aligned diff scores, not the search'),
        threshold: z.number().optional().describe("Per-pixel threshold 0-1; overrides mode"),
        waitForNetworkIdle: z.boolean().optional().describe("Default true"),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        delay: z.number().optional().describe("Extra ms before capture (default 0)"),
        ignoreImages: z.boolean().optional().describe("Paint <img> as solid blocks (default false)"),
        ignoreBackgrounds: z.boolean().optional().describe("Paint background-image elements as solid blocks (default false)"),
        ignoreAllImages: z.boolean().optional().describe("ignoreImages + ignoreBackgrounds"),
        ignoreText: z.boolean().optional().describe("Mask each text line in position-only mode"),
        ignoreElements: z.array(ignoreElementSchema).optional(),
        ignoreRegions: z.array(ignoreRegionSchema).optional().describe("Pixel regions to mask"),
        summaryOnly: z.boolean().optional().describe("Summary plus the most significant rows instead of every element (default false)"),
        profile: z.enum(["walker"]).optional().describe('"walker" sets summaryOnly:true; explicit flags win'),
        ...useSchemaField,
      },
      handler: async (params) => (await alignElementsTool(withUrlAndOut(params))) as any,
    });

    // ---------- network_log ----------
    ctx.registerTool({
      name: "network_log",
      description:
        "Capture network requests (URL, method, status, content type, duration). Only requests after this call starts are seen; pass url to capture a fresh load.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        actions: z.array(actionSchema).optional().describe(actionsDesc + " Runs while capturing."),
        filterUrl: z.string().optional().describe("Regex on request URLs"),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        summaryOnly: z.boolean().optional().describe("Return { totalRequests, errorCount, byStatus, byContentType, avgDurationMs, slowestN, errorsTopN } (top 5 each) instead of all entries; larger than full output below ~5 requests (default false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await networkLogTool(withOptionalUrl(params))) as any,
    });

    // ---------- page_metadata ----------
    ctx.registerTool({
      name: "page_metadata",
      description:
        "Page metadata: title, description, Open Graph and other meta tags, favicon, language, charset.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        ...useSchemaField,
      },
      handler: async (params) => (await pageMetadataTool(withOptionalUrl(params))) as any,
    });

    // ---------- performance_metrics ----------
    ctx.registerTool({
      name: "performance_metrics",
      description:
        "Page performance: load, DOMContentLoaded, FCP, LCP, CLS, TBT, TTFB. With session_id and no url, metrics are from the page's original navigation and may be stale; pass url for fresh ones.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Default "chromium"; some metrics are Chromium-only'),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        summaryOnly: z.boolean().optional().describe("One 'LCP=Xms | FCP=… | TTFB=… | DCL=… | Load=… | CLS=… | TBT=… | transfer=…' line instead of JSON (default false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await performanceMetricsTool(withOptionalUrl(params))) as any,
    });

    // ---------- computed_styles ----------
    ctx.registerTool({
      name: "computed_styles",
      description:
        "Read an element's computed CSS (all or non-default), optionally with the source file and line of each rule (Chromium). To assert expected values use style_check.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        selector: z.string().describe("CSS selector"),
        filter: z.enum(["all", "non-default"]).optional().describe('Default "non-default"'),
        properties: z.array(z.string()).optional().describe("Only these properties; overrides filter"),
        includeSource: z.boolean().optional().describe("Source file + line per property, Chromium only (default false)"),
        includeInherited: z.boolean().optional().describe("With includeSource, also inherited styles from ancestors (default false)"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Ephemeral only (default 1280x720)"),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        ...useSchemaField,
      },
      handler: async (params) => (await computedStylesTool(withOptionalUrl(params))) as any,
    });

    // ---------- evaluate_script ----------
    ctx.registerTool({
      name: "evaluate_script",
      description:
        "Run JS in the page and return the JSON-serialized result. Use last, only for what other tools can't do: fetch() from the page origin, page JS APIs (e.g. wp.data), JS globals, perf entries. " +
        "Use click, not el.click() (untrusted events that React/Vue handlers may ignore); type_text, not setting input.value (skips framework change detection); " +
        "dom_query, accessibility_snapshot, or list_interactive_elements to find elements; wait_for_selector, not sleep loops.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        script: z.string().describe("Wrapped in an IIFE; use `return` to yield a value"),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Ephemeral only (default "chromium")'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Ephemeral only (default 1280x720)"),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        waitForNetworkIdle: z.boolean().optional().describe("Default true"),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        ...useSchemaField,
      },
      handler: async (params) => (await evaluateScriptTool({
        ...params,
        url: params.url ? resolveUrl(params.url, config.baseUrl) : undefined,
      })) as any,
    });

    // ---------- dom_query ----------
    const domFieldEnum = z.enum([
      "rect", "tag", "id", "classes", "text", "html", "role", "visible", "attributes", "computed",
    ]);
    const domQuerySchema = z.object({
      id: z.string().optional().describe("Echoed in the result (default: array index)"),
      selector: z.string().describe("CSS selector"),
      pseudoElement: z.enum(["before", "after"]).optional().describe(
        "Read the ::before/::after pseudo-element: rect, html, visible, attributes are skipped; text reads its `content`",
      ),
      match: z.enum(["first", "all"]).optional().describe('"first" (default) fills `element`; "all" fills `elements` (max 50, then truncated:true)'),
      fields: z.array(domFieldEnum).optional().describe('Default ["rect","tag"]. text = trimmed innerText (2 KB cap), html = outerHTML (4 KB cap), role = computed ARIA role'),
      computed: z.array(z.string()).optional().describe('CSS properties, or presets "box" (size, padding, margin, border widths), "text" (font-*, line-height, letter-spacing, color, ...), "flex" (display, flex-*, alignment, gaps)'),
      attributes: z.array(z.string()).optional().describe("Missing ones report null"),
      requireVisible: z.boolean().optional().describe("Default true: hidden elements (display:none, visibility:hidden, opacity:0) report found:false"),
    });
    ctx.registerTool({
      name: "dom_query",
      description:
        "Read many elements in one call (rect, text, attributes, computed styles, ...), one query per selector. No match returns found:false; a bad selector adds error:\"SyntaxError…\" without failing the other queries.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Ephemeral only (default "chromium")'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Ephemeral only (default 1280x720)"),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        waitForNetworkIdle: z.boolean().optional().describe("Default true"),
        delay: z.number().optional().describe("Extra ms before querying (default 0)"),
        queries: z.array(domQuerySchema).describe("Must not be empty"),
        profile: z.enum(["walker"]).optional().describe('"walker" defaults fields to ["rect","tag","id","classes","text"]; per-query fields win'),
        ...useSchemaField,
      },
      handler: async (params) => (await domQueryTool({
        ...params,
        url: params.url ? resolveUrl(params.url, config.baseUrl) : undefined,
      })) as any,
    });

    // ---------- hit_test ----------
    ctx.registerTool({
      name: "hit_test",
      description:
        "Which element would receive a real tap/click at a point (an element's center, or x/y)? Returns the z-ordered element stack there and a verdict: " +
        "reachesTarget, coveredBy (an overlay on top), tapWouldHitFileInput (plus expect.reachesExpected with expect_selector). Checks whether a control is really clickable, e.g. a file input hidden under its button. " +
        "Works on real iOS devices, where click_to_upload can't.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Ephemeral only (default "chromium")'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Ephemeral only (default 1280x720)"),
        selector: z.string().optional().describe("Element whose center is tested (and the expected target by default). Give this or x and y."),
        x: z.number().optional().describe("Viewport X; needs y"),
        y: z.number().optional().describe("Viewport Y; needs x"),
        expect_selector: z.string().optional().describe("Element the tap should reach, e.g. `input[type=file]` (default: selector)"),
        stack_depth: z.number().optional().describe("Default 8"),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        waitForNetworkIdle: z.boolean().optional().describe("Default true"),
        delay: z.number().optional().describe("Extra ms before probing (default 0)"),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        ...useSchemaField,
      },
      handler: async (params) => (await hitTestTool({
        ...params,
        url: params.url ? resolveUrl(params.url, config.baseUrl) : undefined,
      })) as any,
    });

    // ---------- style_check ----------
    ctx.registerTool({
      name: "style_check",
      description:
        "Assert one element's computed CSS against expected values; returns pass/fail with the actual value of each mismatch. " +
        "Values must be in computed form (`rgb(0, 0, 0)` not `#000`, `16px` not `1rem`); computed_styles shows the format.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        selector: z.string().describe("CSS selector"),
        expected: z.record(z.string(), z.string()).describe(
          'e.g. {"font-size":"24px","font-weight":"400"}',
        ),
        tolerance_px: z.number().optional().describe(
          "px tolerance for numeric values (default 0); units must still match. Colors and keywords compare exactly.",
        ),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Ephemeral only (default 1280x720)"),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        ...useSchemaField,
      },
      handler: async (params) => (await styleCheckTool(withOptionalUrl(params))) as any,
    });

    // ---------- trace_start / trace_stop (session-scoped) ----------
    // Playwright tracing records actions + DOM snapshots + network + console
    // as a trace.zip openable with `npx playwright show-trace <file>`.
    // Start before the behavior you want to capture; stop to save the zip.
    ctx.registerTool({
      name: "trace_start",
      description:
        "Start Playwright tracing (actions, DOM snapshots, network, console) on a session; one trace per session. Save it with trace_stop.",
      schema: {
        session_id: z.string(),
        screenshots: z.boolean().optional().describe("Default true"),
        snapshots: z.boolean().optional().describe("DOM snapshots (default true)"),
        sources: z.boolean().optional().describe("Include source JS (default false)"),
      },
      handler: async (p) => {
        sessionManager.touch(p.session_id);
        if (sessionManager.isTracing(p.session_id)) {
          return { content: [{ type: "text" as const, text: "Tracing is already active on this session. Call trace_stop first." }], isError: true };
        }
        const context = sessionManager.getContext(p.session_id);
        await context.tracing.start({
          screenshots: p.screenshots !== false,
          snapshots: p.snapshots !== false,
          sources: p.sources === true,
        });
        sessionManager.setTracing(p.session_id, true);
        return { content: [{ type: "text" as const, text: `Tracing started on session ${p.session_id}` }] };
      },
    });

    ctx.registerTool({
      name: "trace_stop",
      description:
        "Stop tracing and save trace.zip; returns its path (open with `npx playwright show-trace <file>`).",
      schema: {
        session_id: z.string(),
        output_path: z.string().optional().describe("Default <output_dir>/trace-<timestamp>.zip"),
        output_dir: z.string().optional().describe(`Base for a relative output_path (default "${defaultOutputDir}")`),
      },
      handler: async (p) => {
        sessionManager.touch(p.session_id);
        if (!sessionManager.isTracing(p.session_id)) {
          return { content: [{ type: "text" as const, text: "No trace is active on this session. Call trace_start first." }], isError: true };
        }
        const dir = p.output_dir ?? defaultOutputDir;
        const filePath = p.output_path
          ? (path.isAbsolute(p.output_path) ? p.output_path : path.join(dir, p.output_path))
          : path.join(dir, `trace-${Date.now()}.zip`);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const context = sessionManager.getContext(p.session_id);
        await context.tracing.stop({ path: filePath });
        sessionManager.setTracing(p.session_id, false);
        return { content: [{ type: "text" as const, text: JSON.stringify({ path: filePath }, null, 2) }] };
      },
    });

    // ---------- list_interactive_elements ----------
    ctx.registerTool({
      name: "list_interactive_elements",
      description:
        "List every clickable or typable element (links, buttons, form fields, contenteditable, interactive ARIA roles) with tag, type, role, " +
        "accessible name, text, value, rect, visible, and a selector_hint ready for click or type_text " +
        "(role=ROLE[name=\"NAME\"] when possible). Use before evaluate_script to find clickables.",
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        scope: z.string().optional().describe('CSS selector (default "body")'),
        cap: z.number().optional().describe("Max elements (default 100); truncated:true if more exist"),
        include_hidden: z.boolean().optional().describe("Include hidden and off-screen elements (default false)"),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Ephemeral only (default 1280x720)"),
        ...useSchemaField,
      },
      handler: async (params) => (await listInteractiveElementsTool(withOptionalUrl(params))) as any,
    });

    // ---------- schema_extract ----------
    ctx.registerTool({
      name: "schema_extract",
      description:
        'Parse and check every JSON-LD (<script type="application/ld+json">) block: parsed JSON, schema.org @types, and issue flags (json-parse-failed, whitespace-run, escape-chars-in-string, faq-question-in-answer, faq-empty-answer).',
      schema: {
        url: z.string().optional().describe(urlOptionalDesc),
        session_id: z.string().optional().describe(sessionIdDesc),
        tab_id: z.string().optional().describe(tabIdDesc),
        actions: z.array(actionSchema).optional().describe(actionsDesc),
        useBrowserStack: z.boolean().optional().describe("Default false"),
        ...browserStackFields,
        summaryOnly: z.boolean().optional().describe("Drop parsed bodies and rawPreview; keep summary, types, issues, errors (default false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await schemaExtractTool(withOptionalUrl(params))) as any,
    });
  },
};

export default devPlugin;

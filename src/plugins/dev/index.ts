import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import type {
  ScreenshotPlugin,
  PluginContext,
  PluginConfigSchema,
} from "../types.js";
import { actionSchema, useSchemaField } from "../../utils/schemas.js";
import { sessionManager } from "../../core/sessions.js";
import { consoleCaptureTool } from "./tools/console-capture.js";
import { domSnapshotTool } from "./tools/dom-snapshot.js";
import { accessibilitySnapshotTool } from "./tools/accessibility.js";
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
import { domQueryTool } from "./tools/dom-query.js";

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

    const urlVisitDesc = config.baseUrl
      ? `URL to visit (absolute or relative path — base: ${config.baseUrl})`
      : "URL to visit (absolute URL required)";

    const urlCaptureDesc = config.baseUrl
      ? `URL to screenshot (absolute or relative path — base: ${config.baseUrl})`
      : "URL to screenshot (absolute URL required)";

    const withUrl = <T extends { url: string }>(p: T): T => ({
      ...p,
      url: resolveUrl(p.url, config.baseUrl),
    });
    const withUrlAndOut = <T extends { url: string; outputDir?: string }>(p: T): T => ({
      ...p,
      url: resolveUrl(p.url, config.baseUrl),
      outputDir: p.outputDir ?? defaultOutputDir,
    });

    // ---------- console_capture ----------
    ctx.registerTool({
      name: "console_capture",
      description:
        "Capture browser console output (logs, warnings, errors) from a page." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlVisitDesc),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Browser to use (default: "chromium")'),
        actions: z.array(actionSchema).optional().describe("Actions to run. Selector-based actions support optional and timeout params"),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
        toFile: z.boolean().optional().describe("Write logs to file (default: false)"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        summaryOnly: z.boolean().optional().describe("Compact response: { totalLogs, byType, errorPreviews } (top 5 errors/warnings, capped at 200 chars each) instead of the full log body. Page errors collapse to count + 5 previews. Note: structural switch — at very low log counts (~5 or fewer) the aggregate may exceed the raw output; the win materializes at higher volumes (default: false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await consoleCaptureTool(withUrlAndOut(params))) as any,
    });

    // ---------- dom_snapshot ----------
    ctx.registerTool({
      name: "dom_snapshot",
      description:
        "Get a simplified DOM tree of a page or element. Returns tag names, IDs, classes, and text content." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlVisitDesc),
        selector: z.string().optional().describe('Root CSS selector (default: "body")'),
        maxDepth: z.number().optional().describe("Max DOM depth to traverse (default: 5)"),
        actions: z.array(actionSchema).optional().describe("Actions to run before snapshot. Selector-based actions support optional and timeout params"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        summaryOnly: z.boolean().optional().describe("Compact response: { rootTag, totalNodes, maxDepthReached, truncatedBranches, byTag } instead of the full tree. Re-run without to walk the tree itself (default: false)"),
        profile: z.enum(["walker"]).optional().describe('Named bundle of defaults. "walker" sets summaryOnly:true. Caller-supplied flags always win over profile defaults'),
        ...useSchemaField,
      },
      handler: async (params) => (await domSnapshotTool(withUrl(params))) as any,
    });

    // ---------- accessibility_snapshot ----------
    ctx.registerTool({
      name: "accessibility_snapshot",
      description:
        "Get the accessibility tree of a page (roles, names, values). Useful for verifying a11y. Optionally runs named WCAG-like rule checks and returns pass/fail per rule." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlVisitDesc),
        actions: z.array(actionSchema).optional().describe("Actions to run before snapshot. Selector-based actions support optional and timeout params"),
        scope: z.string().optional().describe("CSS selector to scope the snapshot and asserts (default: document.body)"),
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
          .describe("Named rule checks to run. Returns pass/fail per rule alongside the tree"),
        skipTree: z.boolean().optional().describe("Omit the full accessibility tree from output (default: false). Set true when you only want assertRules results"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        summaryOnly: z.boolean().optional().describe("Compact response: { rootRole, totalNodes, maxDepth, byRole, headingCount, landmarkCount, namedNodeCount } instead of the full tree. assertRules findings still surface in full (default: false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await accessibilitySnapshotTool(withUrl(params))) as any,
    });

    // ---------- visual_diff ----------
    ctx.registerTool({
      name: "visual_diff",
      description:
        "Compare two PNG images pixel-by-pixel and return a diff image with mismatch percentage.",
      schema: {
        imageA: z.string().describe("Path to the first image"),
        imageB: z.string().describe("Path to the second image"),
        outputDir: z.string().optional().describe(`Output directory for diff image (default: "${defaultOutputDir}")`),
        mode: z.enum(["precise", "design"]).optional().describe('Comparison mode: "precise" (threshold 0.1) for same-page screenshots, "design" (threshold 0.3) for Figma/design mockups (default: "precise")'),
        threshold: z.number().optional().describe("Pixel diff threshold 0-1. Overrides the mode default if provided"),
        maxDiffPercent: z.number().optional().describe("Maximum allowed diff percentage to still count as a match (default: 5)"),
        crop: z.boolean().optional().describe("Auto-crop both images to the smaller dimensions when sizes differ (default: false)"),
        ...useSchemaField,
      },
      handler: async (params) =>
        (await visualDiffTool({ ...params, outputDir: params.outputDir ?? defaultOutputDir })) as any,
    });

    // ---------- compare_screenshot ----------
    const ignoreElementSchema = z.object({
      selector: z.string().describe("CSS selector for elements to ignore"),
      mode: z.enum(["invisible", "position-only"]).describe(
        '"invisible" = area completely excluded from comparison; "position-only" = replaced with solid block to verify position/size only',
      ),
    });
    const ignoreRegionSchema = z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      mode: z.enum(["invisible", "position-only"]).optional().describe('Mask mode (default: "invisible")'),
      reason: z.string().optional().describe("Human-readable note for why this region is masked. Echoed back in the result so the mask trail is reviewable"),
    });

    ctx.registerTool({
      name: "compare_screenshot",
      description:
        "Take a screenshot of a URL and compare it pixel-by-pixel against a reference image. The page viewport width is automatically matched to the reference image width. Supports clipping the screenshot to a vertical range with startY/endY." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlCaptureDesc.replace("screenshot", "screenshot and compare")),
        referenceImage: z.string().describe("Path to the reference PNG image"),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Browser to use (default: "chromium")'),
        actions: z.array(actionSchema).optional().describe("Actions to run before screenshot. Selector-based actions support optional and timeout params"),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
        mode: z.enum(["precise", "design"]).optional().describe('Comparison mode: "precise" (threshold 0.1) for same-page screenshots, "design" (threshold 0.3) for Figma/design mockups (default: "precise")'),
        threshold: z.number().optional().describe("Pixel diff threshold 0-1. Overrides the mode default if provided"),
        maxDiffPercent: z.number().optional().describe("Maximum allowed diff percentage to still count as a match (default: 5)"),
        waitForNetworkIdle: z.boolean().optional().describe("Wait for network idle before screenshot (default: true)"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        delay: z.number().optional().describe("Extra delay in ms before capture (default: 0)"),
        startY: z.number().optional().describe("Y coordinate to start the screenshot clip from (pixels from top)"),
        endY: z.number().optional().describe("Y coordinate to end the screenshot clip at (pixels from top)"),
        ignoreImages: z.boolean().optional().describe("Replace all <img> elements with solid blocks so only their position/size is compared (default: false)"),
        ignoreBackgrounds: z.boolean().optional().describe("Replace all elements with a CSS background-image with solid blocks (default: false)"),
        ignoreAllImages: z.boolean().optional().describe("Shorthand for ignoreImages + ignoreBackgrounds (default: false)"),
        ignoreText: z.boolean().optional().describe("Mask every rendered text line (per-line client-rect) in position-only mode"),
        ignoreElements: z.array(ignoreElementSchema).optional().describe("Elements to mask before comparison. Masks are applied to both the live screenshot and reference image at the same coordinates"),
        ignoreRegions: z.array(ignoreRegionSchema).optional().describe("Pre-computed pixel-space regions to mask on both the live screenshot and reference image"),
        summaryOnly: z.boolean().optional().describe("Compact response: match/diff%/mode line, mask one-liner, top-N clusters as one line, canonical file paths only. Drops cluster DOM annotations, preview file generation, and verbose box/coord blocks. Re-run without to drill into a specific cluster (default: false)"),
        clustersTopN: z.number().optional().describe("How many top diff clusters to surface in the response (default: 5)"),
        profile: z.enum(["walker"]).optional().describe('Named bundle of defaults. "walker" sets summaryOnly:true and clustersTopN:3. Caller-supplied flags always win over profile defaults'),
        ...useSchemaField,
      },
      handler: async (params) => (await compareScreenshotTool(withUrlAndOut(params))) as any,
    });

    // ---------- compare_element ----------
    ctx.registerTool({
      name: "compare_element",
      description:
        "All-in-one element visual regression: takes a page screenshot, locates an element by CSS selector, crops it (with padding) from both the live page and the reference image at the same coordinates, and compares them pixel-by-pixel." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlCaptureDesc),
        referenceImage: z.string().describe("Path to the reference PNG image"),
        selector: z.string().describe("CSS selector of the element to compare"),
        padding: z.number().optional().describe("Padding in pixels around the element bounding box (default: 50)"),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Browser to use (default: "chromium")'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size (default: matched to reference image dimensions)"),
        actions: z.array(actionSchema).optional().describe("Actions to run before screenshot. Selector-based actions support optional and timeout params"),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
        mode: z.enum(["precise", "design"]).optional().describe('Comparison mode (default: "precise")'),
        threshold: z.number().optional().describe("Pixel diff threshold 0-1"),
        maxDiffPercent: z.number().optional().describe("Maximum allowed diff percentage (default: 5)"),
        waitForNetworkIdle: z.boolean().optional().describe("Wait for network idle before screenshot (default: true)"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        delay: z.number().optional().describe("Extra delay in ms before capture (default: 0)"),
        ignoreImages: z.boolean().optional().describe("Replace <img> elements with solid blocks (default: false)"),
        ignoreBackgrounds: z.boolean().optional().describe("Replace bg-image elements with solid blocks (default: false)"),
        ignoreAllImages: z.boolean().optional().describe("Shorthand for ignoreImages + ignoreBackgrounds"),
        ignoreText: z.boolean().optional().describe("Mask every rendered text line in position-only mode"),
        ignoreElements: z.array(ignoreElementSchema).optional().describe("Elements to mask before comparison"),
        ignoreRegions: z.array(ignoreRegionSchema).optional().describe("Pre-computed pixel-space regions to mask"),
        boundsHandling: z.enum(["strict", "intersect"]).optional().describe('"strict" (default) errors when the element crop extends past the reference bounds; "intersect" clamps the crop to the reference\'s dimensions'),
        alignTo: z.enum(["top", "center"]).optional().describe('Alignment shortcut: "top" or "center". Mutually exclusive with alignOn'),
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
          .describe("Opt-in: shift the reference crop so the named anchor pairs in live + reference overlap before diffing"),
        summaryOnly: z.boolean().optional().describe("Compact response: match/diff%/mode line, mask one-liner, top-N clusters as one line, canonical file paths only. Drops cluster DOM annotations, preview file generation, and verbose box/coord blocks. Re-run without to drill into a specific cluster (default: false)"),
        clustersTopN: z.number().optional().describe("How many top diff clusters to surface in the response (default: 5)"),
        profile: z.enum(["walker"]).optional().describe('Named bundle of defaults. "walker" sets summaryOnly:true and clustersTopN:3. Caller-supplied flags always win over profile defaults'),
        ...useSchemaField,
      },
      handler: async (params) => (await compareElementTool(withUrlAndOut(params))) as any,
    });

    // ---------- align_elements ----------
    ctx.registerTool({
      name: "align_elements",
      description:
        "Visual alignment probe. For each candidate element, finds the integer (dx, dy) that, applied as `transform: translate(dx, dy)`, makes the element's pixels best match the reference image. Search is grounded in pixel SAD over the live screenshot vs the reference — DOM-reported coordinates only seed the search center, not the answer. By default discovers candidates from diff clusters inside `scope`; pass explicit `selectors` to override. Groups elements with similar deltas and commits the rigid shift at their lowest common ancestor (`rigid-with-parent` classification). Returns per-element delta, baseline-vs-aligned diff scores, and a classification (translation / rigid-with-parent / content-change / size-mismatch / ambiguous / no-clusters)." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlCaptureDesc),
        referenceImage: z.string().describe("Path to the reference PNG image"),
        scope: z.string().optional().describe('Root selector to search within when discovering candidates from diff clusters (default: "body"). Ignored when `selectors` is provided'),
        selectors: z.array(z.string()).optional().describe("Explicit list of element selectors to align. When omitted, candidates are discovered automatically from the diff clusters inside `scope`"),
        refineRadius: z.number().optional().describe("Floor for the per-element search radius in pixels. Cluster geometry can raise this; this is the minimum (default: 3)"),
        maxRadius: z.number().optional().describe("Ceiling for the per-element search radius in pixels (default: 60). The tool auto-grows once if the first pass hits the radius edge"),
        uniformityTolerance: z.number().optional().describe("Manhattan-distance threshold (px) at which two element deltas are considered the same shift, triggering a parent commit (default: 2)"),
        minImprovement: z.number().optional().describe("Minimum SAD improvement (0..1) required to classify an element as 'translation'. Below this it's labelled 'content-change' (default: 0.005)"),
        applyTransform: z.boolean().optional().describe("After finding deltas, apply CSS transforms on the live page and capture an aligned screenshot for visual confirmation (default: true)"),
        topClusters: z.number().optional().describe("How many top diff clusters to consider when discovering candidates (default: 12)"),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Browser to use (default: "chromium")'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size (default: matched to reference image dimensions)"),
        actions: z.array(actionSchema).optional().describe("Actions to run before aligning. Selector-based actions support optional and timeout params"),
        outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
        mode: z.enum(["precise", "design"]).optional().describe('Comparison mode: "precise" or "design" (default: "design"). Sets the pixelmatch threshold used for the baseline/aligned diffs only — template matching is metric-fixed (SAD)'),
        threshold: z.number().optional().describe("Pixel diff threshold 0-1. Overrides the mode default if provided"),
        waitForNetworkIdle: z.boolean().optional().describe("Wait for network idle before screenshot (default: true)"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        delay: z.number().optional().describe("Extra delay in ms before capture (default: 0)"),
        ignoreImages: z.boolean().optional().describe("Replace <img> elements with solid blocks (default: false)"),
        ignoreBackgrounds: z.boolean().optional().describe("Replace bg-image elements with solid blocks (default: false)"),
        ignoreAllImages: z.boolean().optional().describe("Shorthand for ignoreImages + ignoreBackgrounds"),
        ignoreText: z.boolean().optional().describe("Mask every rendered text line in position-only mode"),
        ignoreElements: z.array(ignoreElementSchema).optional().describe("Elements to mask before scoring"),
        ignoreRegions: z.array(ignoreRegionSchema).optional().describe("Pre-computed pixel-space regions to mask"),
        summaryOnly: z.boolean().optional().describe("Compact response: drops the full per-element table; surfaces the summary block plus the most significant rows. Re-run without to see every candidate (default: false)"),
        profile: z.enum(["walker"]).optional().describe('Named bundle of defaults. "walker" sets summaryOnly:true. Caller-supplied flags always win over profile defaults'),
        ...useSchemaField,
      },
      handler: async (params) => (await alignElementsTool(withUrlAndOut(params))) as any,
    });

    // ---------- network_log ----------
    ctx.registerTool({
      name: "network_log",
      description:
        "Capture network requests made by a page. Returns URL, method, status, content type, and duration." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlVisitDesc),
        actions: z.array(actionSchema).optional().describe("Actions to run. Selector-based actions support optional and timeout params"),
        filterUrl: z.string().optional().describe("Regex to filter request URLs"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        summaryOnly: z.boolean().optional().describe("Compact response: { totalRequests, errorCount, byStatus, byContentType, avgDurationMs, slowestN (top 5), errorsTopN (top 5 4xx/5xx) } instead of the full entries array. Note: structural switch — at very low request counts (~5 or fewer) the aggregate may exceed the raw output; the win materializes at higher volumes (default: false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await networkLogTool(withUrl(params))) as any,
    });

    // ---------- page_metadata ----------
    ctx.registerTool({
      name: "page_metadata",
      description:
        "Extract page metadata: title, description, Open Graph tags, meta tags, favicon, language, and charset." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlVisitDesc),
        actions: z.array(actionSchema).optional().describe("Actions to run before extraction. Selector-based actions support optional and timeout params"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await pageMetadataTool(withUrl(params))) as any,
    });

    // ---------- performance_metrics ----------
    ctx.registerTool({
      name: "performance_metrics",
      description:
        "Measure page performance: load time, DOM content loaded, FCP, LCP, CLS, TBT, TTFB." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlVisitDesc),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Browser to use (default: "chromium"). Some metrics are Chromium-only.'),
        actions: z.array(actionSchema).optional().describe("Actions to run before measuring. Selector-based actions support optional and timeout params"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        summaryOnly: z.boolean().optional().describe("Compact response: pipe-separated 'LCP=Xms | FCP=Yms | TTFB=Zms | DCL=… | Load=… | CLS=… | TBT=… | transfer=…' line instead of the JSON object (default: false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await performanceMetricsTool(withUrl(params))) as any,
    });

    // ---------- computed_styles ----------
    ctx.registerTool({
      name: "computed_styles",
      description:
        "Get the computed/effective CSS styles of a DOM element. Returns all styles or only non-default ones. Optionally traces each property to its source CSS file and line number (Chromium only)." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlVisitDesc),
        selector: z.string().describe("CSS selector of the element to inspect"),
        filter: z.enum(["all", "non-default"]).optional().describe('Which properties to return (default: "non-default")'),
        properties: z.array(z.string()).optional().describe("Limit output to specific CSS properties. When set, `filter` is ignored"),
        includeSource: z.boolean().optional().describe("Include source CSS file + line number. Chromium CDP only (default: false)"),
        includeInherited: z.boolean().optional().describe("When includeSource is true, also return the chain of inherited styles from ancestor elements (default: false)"),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size (default: {width:1280, height:720})"),
        actions: z.array(actionSchema).optional().describe("Actions to run before inspecting styles. Selector-based actions support optional and timeout params"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await computedStylesTool(withUrl(params))) as any,
    });

    // ---------- evaluate_script ----------
    ctx.registerTool({
      name: "evaluate_script",
      description:
        "Run a JavaScript snippet in the page context and return its JSON-serialized result. Unlike the `evaluate` action (fire-and-forget), this tool returns the value. `return` works at the top level (the script is wrapped in an IIFE)." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlVisitDesc),
        script: z.string().describe("JS to evaluate. Use `return` to yield a value; result is JSON-stringified in the response"),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Browser to use (default: "chromium")'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size (default: {width:1280, height:720})"),
        actions: z.array(actionSchema).optional().describe("Actions to run before evaluating. Selector-based actions support optional and timeout params"),
        waitForNetworkIdle: z.boolean().optional().describe("Wait for network idle before evaluating (default: true)"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await evaluateScriptTool(withUrl(params))) as any,
    });

    // ---------- dom_query ----------
    const domFieldEnum = z.enum([
      "rect", "tag", "id", "classes", "text", "html", "role", "visible", "attributes", "computed",
    ]);
    const domQuerySchema = z.object({
      id: z.string().optional().describe("Caller-defined correlation id. Defaults to the array index. Echoed back in the matching result"),
      selector: z.string().describe("CSS selector for the element(s) to read"),
      pseudoElement: z.enum(["before", "after"]).optional().describe(
        "Read styles from the ::before or ::after pseudo-element. When set, `rect`/`html`/`visible`/`attributes` fields are skipped (pseudo-elements have no DOMRect or attributes); `text` reads the computed `content` property",
      ),
      match: z.enum(["first", "all"]).optional().describe('"first" returns the first match in `element` (default); "all" returns every match in `elements` (capped at 50, sets `truncated:true` on overflow)'),
      fields: z.array(domFieldEnum).optional().describe('Which fields to populate per matched element. Default ["rect","tag"]. Available: rect, tag, id, classes, text (innerText, trimmed, capped 2 KB), html (outerHTML, capped 4 KB), role (computed ARIA role), visible (CSS-visibility boolean), attributes, computed'),
      computed: z.array(z.string()).optional().describe('CSS property names to read into `computed`. Mixes literal property names with preset bucket names: "box" (width/height/padding-*/margin-*/border-*-width/box-sizing), "text" (font-*/line-height/letter-spacing/text-transform/color/text-align), "flex" (display/flex-*/justify-content/align-items/gap/row-gap/column-gap)'),
      attributes: z.array(z.string()).optional().describe("Attribute names to read into `attributes`. Missing attributes report `null` (distinct from empty string)"),
      requireVisible: z.boolean().optional().describe('When true (default), hidden elements (display:none, visibility:hidden, opacity:0) report `found:false`. Set false to also surface hidden elements (e.g. for a11y walks)'),
    });
    ctx.registerTool({
      name: "dom_query",
      description:
        "Batched DOM read: collapse N selector reads into one round-trip + one page.evaluate. Per-query try/catch so a bad selector reports `error` without sinking siblings; selector-syntax errors are distinct from no-match (no-match: `found:false`; bad selector: `found:false, error:\"SyntaxError…\"`). Reuses an open session via `session_id` (eliminates per-query browser launch); falls back to ephemeral when omitted." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().optional().describe("URL to navigate to before querying. Optional when session_id is provided (use the session's current page); required when ephemeral"),
        session_id: z.string().optional().describe("Reuse an open_session. Avoids the per-call browser launch — one launch + one navigate, then many dom_query calls"),
        tab_id: z.string().optional().describe("Which tab in the session to query. Defaults to the session's active tab"),
        browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Browser for ephemeral calls (default: "chromium")'),
        viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport for ephemeral calls (default: {width:1280, height:720})"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        actions: z.array(actionSchema).optional().describe("Actions to run before querying. Selector-based actions support optional and timeout params"),
        waitForNetworkIdle: z.boolean().optional().describe("Wait for network idle when navigating (default: true)"),
        delay: z.number().optional().describe("Extra delay in ms before querying (default: 0)"),
        queries: z.array(domQuerySchema).describe("Array of per-element queries. Empty array errors out"),
        profile: z.enum(["walker"]).optional().describe('Named bundle of defaults. "walker" sets per-query fields to ["rect","tag","id","classes","text"] when the caller does not supply fields explicitly. Per-query `fields` always wins over profile defaults'),
        ...useSchemaField,
      },
      handler: async (params) => (await domQueryTool({
        ...params,
        url: params.url ? resolveUrl(params.url, config.baseUrl) : undefined,
      })) as any,
    });

    // ---------- trace_start / trace_stop (session-scoped) ----------
    // Playwright tracing records actions + DOM snapshots + network + console
    // as a trace.zip openable with `npx playwright show-trace <file>`.
    // Start before the behavior you want to capture; stop to save the zip.
    ctx.registerTool({
      name: "trace_start",
      description:
        "Start Playwright tracing on a session's browser context. Records actions, DOM snapshots, network, and console output. " +
        "Stop with trace_stop to get a trace.zip you can inspect with `npx playwright show-trace`. Per-session, one trace at a time.",
      schema: {
        session_id: z.string().describe("Session id (from open_session) to trace"),
        screenshots: z.boolean().optional().describe("Capture screenshots at each action (default: true)"),
        snapshots: z.boolean().optional().describe("Capture DOM snapshots at each action (default: true)"),
        sources: z.boolean().optional().describe("Include source JS in the trace (default: false)"),
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
        "Stop Playwright tracing on a session and save the trace.zip. Returns the file path. Open with `npx playwright show-trace <file>`.",
      schema: {
        session_id: z.string().describe("Session id"),
        output_path: z.string().optional().describe("Relative or absolute path. Defaults to <output_dir>/trace-<timestamp>.zip"),
        output_dir: z.string().optional().describe(`Base directory when output_path is relative (default: "${defaultOutputDir}")`),
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

    // ---------- schema_extract ----------
    ctx.registerTool({
      name: "schema_extract",
      description:
        'Parse and validate all <script type="application/ld+json"> structured-data blocks on the page. Returns the parsed JSON, detected schema.org @type values, and heuristic issue flags (json-parse-failed, whitespace-run, escape-chars-in-string, faq-question-in-answer, faq-empty-answer).' +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlVisitDesc),
        actions: z.array(actionSchema).optional().describe("Actions to run before extracting. Selector-based actions support optional and timeout params"),
        useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
        summaryOnly: z.boolean().optional().describe("Compact response: drops `parsed` (full JSON-LD body) and `rawPreview` from each block; keeps summary, types, issues, parse errors. Re-run without to inspect parsed bodies (default: false)"),
        ...useSchemaField,
      },
      handler: async (params) => (await schemaExtractTool(withUrl(params))) as any,
    });
  },
};

export default devPlugin;

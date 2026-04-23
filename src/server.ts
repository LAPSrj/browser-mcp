import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { screenshotTool } from "./core/screenshot.js";
import { elementScreenshotTool } from "./core/element-screenshot.js";
import { consoleCaptureTool } from "./core/console-capture.js";
import { domSnapshotTool } from "./core/dom-snapshot.js";
import { accessibilitySnapshotTool } from "./core/accessibility.js";
import { visualDiffTool } from "./core/visual-diff.js";
import { compareScreenshotTool } from "./core/compare-screenshot.js";
import { compareElementTool } from "./core/compare-element.js";
import { networkLogTool } from "./core/network-log.js";
import { pageMetadataTool } from "./core/page-metadata.js";
import { performanceMetricsTool } from "./core/performance.js";
import { computedStylesTool } from "./core/computed-styles.js";
import { evaluateScriptTool } from "./core/evaluate-script.js";
import { schemaExtractTool } from "./core/schema-extract.js";
import type { ServerConfig } from "./config.js";
import { resolveUrl } from "./utils/url.js";
import {
  setLaunchConfig,
  toolContextStorage,
  createToolContext,
  abortToolContext,
} from "./utils/browser.js";
import type { PluginRegistry } from "./plugins/registry.js";
import { resolveModes, stripUse, type UseParam } from "./utils/resolve-modes.js";

const optionalDesc = "If true, skip this action silently when the element is not found instead of failing (default: false)";
const timeoutDesc = "Timeout in ms. When set and the action fails, remaining actions are skipped but the tool still completes and returns the error alongside the result. When optional is true, defaults to 5000. Otherwise uses the context default (30s) and failures abort the tool entirely";

const coreActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("click"),
    selector: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
    force: z.boolean().optional().describe("Skip actionability checks (visible, enabled, stable) and click immediately (default: false)"),
  }),
  z.object({
    action: z.literal("type"),
    selector: z.string(),
    text: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
  }),
  z.object({
    action: z.literal("wait_for_selector"),
    selector: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
  }),
  z.object({ action: z.literal("wait"), ms: z.number() }),
  z.object({
    action: z.literal("scroll_to"),
    selector: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
  }),
  z.object({ action: z.literal("evaluate"), script: z.string().describe("JS to run in page context. Wrapped in an IIFE under the hood — use `return` to yield a value (value is discarded by the action; use the evaluate_script tool to get it back)") }),
  z.object({
    action: z.literal("assert_visible"),
    selector: z.string(),
    timeout: z.number().optional().describe("How long to wait for the element to become visible (default: 3000ms)"),
  }),
  z.object({
    action: z.literal("assert_hidden"),
    selector: z.string(),
    timeout: z.number().optional().describe("How long to wait for the element to become hidden (default: 3000ms)"),
  }),
  z.object({
    action: z.literal("assert_attribute"),
    selector: z.string(),
    attribute: z.string(),
    equals: z.string().optional().describe("Expected attribute value. Omit to assert presence regardless of value"),
    absent: z.boolean().optional().describe("When true, assert the attribute is NOT set. Mutually exclusive with equals"),
  }),
  z.object({
    action: z.literal("assert_text"),
    selector: z.string(),
    contains: z.string().optional().describe("Expected substring within the element's trimmed textContent"),
    equals: z.string().optional().describe("Expected exact trimmed textContent"),
  }),
  z.object({
    action: z.literal("assert_count"),
    selector: z.string(),
    equals: z.number().describe("Expected number of matching elements"),
  }),
  z.object({
    action: z.literal("hover"),
    selector: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
    force: z.boolean().optional().describe("Skip actionability checks and hover immediately (default: false)"),
  }),
  z.object({
    action: z.literal("select"),
    selector: z.string(),
    value: z.string(),
    optional: z.boolean().optional().describe(optionalDesc),
    timeout: z.number().optional().describe(timeoutDesc),
  }),
]);

// Plugin actions: any object with an "action" string field + arbitrary params.
// Validated at runtime by the custom action handler.
const pluginActionSchema = z.object({
  action: z.string().describe("Plugin-provided action type (e.g. gutenberg_insert, gutenberg_select_block)"),
  optional: z.boolean().optional().describe(optionalDesc),
  timeout: z.number().optional().describe(timeoutDesc),
}).passthrough();

// Accept core actions OR plugin actions
const actionSchema = z.union([coreActionSchema, pluginActionSchema]);

// `use` param shared across every core tool. A plugin can register a
// named mode (e.g. the Gutenberg plugin registers "wordpress") whose
// session hooks get applied to the browser context before the tool runs.
// Spread into each tool's z.object schema as `...useSchemaField`.
const useSchemaField = {
  use: z.union([z.string(), z.array(z.string())]).optional().describe(
    'Opt into plugin-provided capabilities by mode name. E.g. use: "wordpress" applies the Gutenberg plugin\'s authenticated WP session cookie to this call, letting the tool reach /wp-admin/* and other login-gated URLs. Pass an array to stack multiple modes. Discover available modes via the list_modes tool.',
  ),
};

function withTimeout<T extends { use?: UseParam }>(
  timeoutMs: number,
  fn: (params: Omit<T, "use">) => Promise<any>,
  registry?: PluginRegistry,
): (params: T) => Promise<any> {
  return async (params: T) => {
    let sessionHooks;
    try {
      sessionHooks = resolveModes(params.use, registry);
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
    const ctx = createToolContext(sessionHooks);
    const toolParams = stripUse(params);

    return toolContextStorage.run(ctx, async () => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Kill any BrowserServers still owned by this invocation so that
            // playwright awaits suspended inside fn() reject immediately and
            // the tool's finally blocks can run closeSession (which releases
            // the semaphore). Without this, a hung browser leaks indefinitely.
            abortToolContext(ctx).catch(() => {
              // ignore — best-effort cleanup
            });
            reject(new Error(`Tool timed out after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
        });

        return await Promise.race([fn(toolParams), timeoutPromise]);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
          isError: true,
        };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    });
  };
}

export function createServer(config: ServerConfig = {}, registry?: PluginRegistry): McpServer {
  setLaunchConfig({
    launchTimeout: config.launchTimeout,
    launchRetries: config.launchRetries,
  });

  const toolTimeout = config.toolTimeout ?? 90000;

  const server = new McpServer({
    name: "browser-mcp",
    version: "1.3.0",
  });

  // Thin wrapper that binds the toolTimeout + plugin registry so each
  // tool registration reads as a single call. The registry lets withTimeout
  // resolve the caller's `use` param into session hooks before the tool runs.
  const wrap = <T extends { use?: UseParam }>(fn: (params: Omit<T, "use">) => Promise<any>) =>
    withTimeout<T>(toolTimeout, fn, registry);

  const defaultOutputDir = config.outputDir ?? ".browser";

  const urlDescription = config.baseUrl
    ? `URL to screenshot (absolute or relative path — base: ${config.baseUrl})`
    : "URL to screenshot (absolute URL required)";

  const urlVisitDescription = config.baseUrl
    ? `URL to visit (absolute or relative path — base: ${config.baseUrl})`
    : "URL to visit (absolute URL required)";

  // Helper to resolve url and outputDir from params
  function resolveParams<T extends { url: string; outputDir?: string }>(params: T): T {
    return {
      ...params,
      url: resolveUrl(params.url, config.baseUrl),
      outputDir: params.outputDir ?? defaultOutputDir,
    };
  }

  function resolveUrlOnly<T extends { url: string }>(params: T): T {
    return {
      ...params,
      url: resolveUrl(params.url, config.baseUrl),
    };
  }

  // 1. Screenshot tool
  server.tool(
    "screenshot",
    "Take screenshots of a URL across multiple browsers and viewports. Returns images and file paths. Supports pre-screenshot actions, console capture, and full-page capture." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlDescription),
      browsers: z
        .array(z.enum(["chromium", "firefox", "webkit"]))
        .optional()
        .describe('Browsers to use (default: ["chromium"])'),
      viewports: z
        .array(
          z.object({
            width: z.number(),
            height: z.number(),
            label: z.string().optional(),
          })
        )
        .optional()
        .describe("Viewport sizes (default: [{width:1280, height:720}])"),
      fullPage: z.boolean().optional().describe("Capture full scrollable page (default: false)"),
      outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      actions: z.array(actionSchema).optional().describe("Actions to run before screenshot. Selector-based actions (click, type, hover, scroll_to, select, wait_for_selector) support optional (skip if element missing) and timeout (ms) params"),
      captureConsole: z.boolean().optional().describe("Also return console logs (default: false)"),
      consoleToFile: z
        .boolean()
        .optional()
        .describe("Write console logs to file (default: false)"),
      waitForNetworkIdle: z
        .boolean()
        .optional()
        .describe("Wait for network idle before screenshot (default: true)"),
      useBrowserStack: z
        .boolean()
        .optional()
        .describe("Use BrowserStack instead of local browsers (default: false)"),
      delay: z.number().optional().describe("Extra delay in ms before capture (default: 0)"),
      startY: z.number().optional().describe("Y coordinate to start the screenshot clip from (pixels from top)"),
      endY: z.number().optional().describe("Y coordinate to end the screenshot clip at (pixels from top)"),
      ...useSchemaField,
    },
    wrap(async (params) => screenshotTool(resolveParams(params)) as any)
  );

  // 2. Element screenshot tool
  server.tool(
    "element_screenshot",
    "Take a screenshot of a specific element on a page identified by CSS selector." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      selector: z.string().describe("CSS selector of the element to screenshot"),
      browser: z
        .enum(["chromium", "firefox", "webkit"])
        .optional()
        .describe('Browser to use (default: "chromium")'),
      viewport: z
        .object({ width: z.number(), height: z.number() })
        .optional()
        .describe("Viewport size (default: {width:1280, height:720})"),
      actions: z.array(actionSchema).optional().describe("Actions to run before screenshot. Selector-based actions (click, type, hover, scroll_to, select, wait_for_selector) support optional (skip if element missing) and timeout (ms) params"),
      outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => elementScreenshotTool(resolveParams(params)) as any)
  );

  // 3. Console capture tool
  server.tool(
    "console_capture",
    "Capture browser console output (logs, warnings, errors) from a page." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      browser: z
        .enum(["chromium", "firefox", "webkit"])
        .optional()
        .describe('Browser to use (default: "chromium")'),
      actions: z.array(actionSchema).optional().describe("Actions to run. Selector-based actions support optional and timeout params"),
      outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      toFile: z.boolean().optional().describe("Write logs to file (default: false)"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => consoleCaptureTool(resolveParams(params)) as any)
  );

  // 4. DOM snapshot tool
  server.tool(
    "dom_snapshot",
    "Get a simplified DOM tree of a page or element. Returns tag names, IDs, classes, and text content." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      selector: z.string().optional().describe('Root CSS selector (default: "body")'),
      maxDepth: z.number().optional().describe("Max DOM depth to traverse (default: 5)"),
      actions: z.array(actionSchema).optional().describe("Actions to run before snapshot. Selector-based actions support optional and timeout params"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => domSnapshotTool(resolveUrlOnly(params)) as any)
  );

  // 5. Accessibility snapshot tool
  server.tool(
    "accessibility_snapshot",
    "Get the accessibility tree of a page (roles, names, values). Useful for verifying a11y. Optionally runs named WCAG-like rule checks and returns pass/fail per rule." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      actions: z.array(actionSchema).optional().describe("Actions to run before snapshot. Selector-based actions support optional and timeout params"),
      scope: z.string().optional().describe("CSS selector to scope the snapshot and asserts (default: document.body)"),
      assertRules: z.array(z.enum([
        "section-has-name",
        "details-summary-has-heading",
        "region-has-roledescription",
        "button-has-name",
        "img-has-alt",
        "form-control-has-label",
      ])).optional().describe("Named rule checks to run. Returns pass/fail per rule alongside the tree"),
      skipTree: z.boolean().optional().describe("Omit the full accessibility tree from output (default: false). Set true when you only want assertRules results"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => accessibilitySnapshotTool(resolveUrlOnly(params)) as any)
  );

  // 6. Visual diff tool
  server.tool(
    "visual_diff",
    "Compare two PNG images pixel-by-pixel and return a diff image with mismatch percentage.",
    {
      imageA: z.string().describe("Path to the first image"),
      imageB: z.string().describe("Path to the second image"),
      outputDir: z.string().optional().describe(`Output directory for diff image (default: "${defaultOutputDir}")`),
      mode: z.enum(["precise", "design"]).optional().describe('Comparison mode: "precise" (threshold 0.1) for same-page screenshots, "design" (threshold 0.3) for Figma/design mockups (default: "precise")'),
      threshold: z.number().optional().describe("Pixel diff threshold 0-1. Overrides the mode default if provided"),
      maxDiffPercent: z.number().optional().describe("Maximum allowed diff percentage to still count as a match (default: 5)"),
      crop: z.boolean().optional().describe("Auto-crop both images to the smaller dimensions when sizes differ (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => visualDiffTool({ ...params, outputDir: params.outputDir ?? defaultOutputDir }) as any)
  );

  // 6b. Compare screenshot tool
  server.tool(
    "compare_screenshot",
    "Take a screenshot of a URL and compare it pixel-by-pixel against a reference image. The page viewport width is automatically matched to the reference image width. Supports clipping the screenshot to a vertical range with startY/endY." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlDescription.replace("screenshot", "screenshot and compare")),
      referenceImage: z.string().describe("Path to the reference PNG image"),
      browser: z
        .enum(["chromium", "firefox", "webkit"])
        .optional()
        .describe('Browser to use (default: "chromium")'),
      actions: z.array(actionSchema).optional().describe("Actions to run before screenshot. Selector-based actions (click, type, hover, scroll_to, select, wait_for_selector) support optional (skip if element missing) and timeout (ms) params"),
      outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      mode: z.enum(["precise", "design"]).optional().describe('Comparison mode: "precise" (threshold 0.1) for same-page screenshots, "design" (threshold 0.3) for Figma/design mockups (default: "precise")'),
      threshold: z.number().optional().describe("Pixel diff threshold 0-1. Overrides the mode default if provided"),
      maxDiffPercent: z.number().optional().describe("Maximum allowed diff percentage to still count as a match (default: 5)"),
      waitForNetworkIdle: z
        .boolean()
        .optional()
        .describe("Wait for network idle before screenshot (default: true)"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      delay: z.number().optional().describe("Extra delay in ms before capture (default: 0)"),
      startY: z.number().optional().describe("Y coordinate to start the screenshot clip from (pixels from top)"),
      endY: z.number().optional().describe("Y coordinate to end the screenshot clip at (pixels from top)"),
      ignoreImages: z.boolean().optional().describe("Replace all <img> elements with solid blocks so only their position/size is compared (default: false)"),
      ignoreBackgrounds: z.boolean().optional().describe("Replace all elements with a CSS background-image with solid blocks (default: false)"),
      ignoreAllImages: z.boolean().optional().describe("Shorthand for ignoreImages + ignoreBackgrounds (default: false)"),
      ignoreText: z.boolean().optional().describe("Mask every rendered text line (per-line client-rect) in position-only mode. Hides glyph-interior pixels so Chromium-vs-Figma font rasterization drift stops polluting the score, while still catching layout regressions that move or resize text. Wrong-text regressions are undetectable under ignoreText — pair with assert_text for that coverage (default: false)"),
      ignoreElements: z.array(z.object({
        selector: z.string().describe("CSS selector for elements to ignore"),
        mode: z.enum(["invisible", "position-only"]).describe('"invisible" = area completely excluded from comparison; "position-only" = replaced with solid block to verify position/size only'),
      })).optional().describe("Elements to mask before comparison. Masks are applied to both the live screenshot and reference image at the same coordinates"),
      ignoreRegions: z.array(z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        mode: z.enum(["invisible", "position-only"]).optional().describe('Mask mode (default: "invisible")'),
        reason: z.string().optional().describe("Human-readable note for why this region is masked. Echoed back in the result so the mask trail is reviewable"),
      })).optional().describe("Pre-computed pixel-space regions to mask on both the live screenshot and reference image. Coordinates must be in the reference PNG's pixel space (same DPR as the reference). Applied symmetrically and OR'd with regions derived from ignoreElements"),
      ...useSchemaField,
    },
    wrap(async (params) => compareScreenshotTool(resolveParams(params)) as any)
  );

  // 6c. Compare element tool
  server.tool(
    "compare_element",
    "All-in-one element visual regression: takes a page screenshot, locates an element by CSS selector, crops it (with padding) from both the live page and the reference image at the same coordinates, and compares them pixel-by-pixel. No need to use screenshot or visual_diff separately." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlDescription),
      referenceImage: z.string().describe("Path to the reference PNG image"),
      selector: z.string().describe("CSS selector of the element to compare"),
      padding: z.number().optional().describe("Padding in pixels around the element bounding box (default: 50)"),
      browser: z
        .enum(["chromium", "firefox", "webkit"])
        .optional()
        .describe('Browser to use (default: "chromium")'),
      viewport: z
        .object({ width: z.number(), height: z.number() })
        .optional()
        .describe("Viewport size (default: matched to reference image dimensions)"),
      actions: z.array(actionSchema).optional().describe("Actions to run before screenshot. Selector-based actions (click, type, hover, scroll_to, select, wait_for_selector) support optional (skip if element missing) and timeout (ms) params"),
      outputDir: z.string().optional().describe(`Output directory (default: "${defaultOutputDir}")`),
      mode: z.enum(["precise", "design"]).optional().describe('Comparison mode: "precise" (threshold 0.1) for same-page screenshots, "design" (threshold 0.3) for Figma/design mockups (default: "precise")'),
      threshold: z.number().optional().describe("Pixel diff threshold 0-1. Overrides the mode default if provided"),
      maxDiffPercent: z.number().optional().describe("Maximum allowed diff percentage to still count as a match (default: 5)"),
      waitForNetworkIdle: z
        .boolean()
        .optional()
        .describe("Wait for network idle before screenshot (default: true)"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      delay: z.number().optional().describe("Extra delay in ms before capture (default: 0)"),
      ignoreImages: z.boolean().optional().describe("Replace all <img> elements with solid blocks so only their position/size is compared (default: false)"),
      ignoreBackgrounds: z.boolean().optional().describe("Replace all elements with a CSS background-image with solid blocks (default: false)"),
      ignoreAllImages: z.boolean().optional().describe("Shorthand for ignoreImages + ignoreBackgrounds (default: false)"),
      ignoreText: z.boolean().optional().describe("Mask every rendered text line (per-line client-rect) in position-only mode. Hides glyph-interior pixels so Chromium-vs-Figma font rasterization drift stops polluting the score, while still catching layout regressions that move or resize text. Wrong-text regressions are undetectable under ignoreText — pair with assert_text for that coverage (default: false)"),
      ignoreElements: z.array(z.object({
        selector: z.string().describe("CSS selector for elements to ignore"),
        mode: z.enum(["invisible", "position-only"]).describe('"invisible" = area completely excluded from comparison; "position-only" = replaced with solid block to verify position/size only'),
      })).optional().describe("Elements to mask before comparison. Masks are applied to both the live screenshot and reference image at the same coordinates"),
      ignoreRegions: z.array(z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        mode: z.enum(["invisible", "position-only"]).optional().describe('Mask mode (default: "invisible")'),
        reason: z.string().optional().describe("Human-readable note for why this region is masked. Echoed back in the result so the mask trail is reviewable"),
      })).optional().describe("Pre-computed pixel-space regions to mask. Coordinates are in the full reference PNG's pixel space (same DPR as the reference), not crop-local. Applied symmetrically to the cropped reference and cropped live screenshot, OR'd with regions derived from ignoreElements"),
      boundsHandling: z.enum(["strict", "intersect"]).optional().describe(
        'How to handle an element crop that extends past the reference image bounds. "strict" (default) returns an error with the cropped screenshot. "intersect" clamps the crop to the reference\'s dimensions and compares only the overlapping region — useful when the live element is slightly taller than the Figma reference'
      ),
      alignTo: z.enum(["top", "center"]).optional().describe(
        'Simpler alignment shortcut: "top" shifts the reference crop to match the live element\'s top-left (use when the Figma reference is cropped to the block and the live page has a header/container above it); "center" matches centers. Mutually exclusive with alignOn'
      ),
      alignOn: z.object({
        referenceRect: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }).describe("Anchor's bounding rect in the reference PNG's pixel space (e.g. from figexport's masked.json.regions entry for the primary image)"),
        frontendSelector: z.string().describe("CSS selector for the live-page element that corresponds to referenceRect"),
        mode: z.enum(["top-left", "center"]).optional().describe('Alignment point on both anchors: "top-left" matches rect origins, "center" matches rect centers (default: "top-left")'),
      }).optional().describe(
        "Opt-in: shift the reference crop so the named anchor pairs in live + reference overlap before diffing. Useful when the Figma frame's origin differs from the live container's origin (canvas-edge vs container-gutter) and the remaining diff is dominated by that offset rather than real visual deltas. Can mask real layout bugs if misused — only apply when the structural offset is known-acceptable. Emits a warning in the response text when |delta| exceeds 100px on either axis."
      ),
      ...useSchemaField,
    },
    wrap(async (params) => compareElementTool(resolveParams(params)) as any)
  );

  // 7. Network log tool
  server.tool(
    "network_log",
    "Capture network requests made by a page. Returns URL, method, status, content type, and duration." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      actions: z.array(actionSchema).optional().describe("Actions to run. Selector-based actions support optional and timeout params"),
      filterUrl: z.string().optional().describe("Regex to filter request URLs"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => networkLogTool(resolveUrlOnly(params)) as any)
  );

  // 8. Page metadata tool
  server.tool(
    "page_metadata",
    "Extract page metadata: title, description, Open Graph tags, meta tags, favicon, language, and charset." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      actions: z.array(actionSchema).optional().describe("Actions to run before extraction. Selector-based actions support optional and timeout params"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => pageMetadataTool(resolveUrlOnly(params)) as any)
  );

  // 9. Performance metrics tool
  server.tool(
    "performance_metrics",
    "Measure page performance: load time, DOM content loaded, FCP, LCP, CLS, TBT, TTFB." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      browser: z
        .enum(["chromium", "firefox", "webkit"])
        .optional()
        .describe('Browser to use (default: "chromium"). Some metrics are Chromium-only.'),
      actions: z.array(actionSchema).optional().describe("Actions to run before measuring. Selector-based actions support optional and timeout params"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => performanceMetricsTool(resolveUrlOnly(params)) as any)
  );

  // 10. Computed styles tool
  server.tool(
    "computed_styles",
    "Get the computed/effective CSS styles of a DOM element. Returns all styles or only non-default ones. Optionally traces each property to its source CSS file and line number (Chromium only)." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      selector: z.string().describe("CSS selector of the element to inspect"),
      filter: z.enum(["all", "non-default"]).optional()
        .describe('Which properties to return: "all" returns every computed property (~350), "non-default" returns only properties that differ from the browser default for the element\'s tag (default: "non-default")'),
      properties: z.array(z.string()).optional()
        .describe('Limit output to specific CSS properties (e.g. ["color", "font-size", "display"]). When set, the filter parameter is ignored'),
      includeSource: z.boolean().optional()
        .describe("Include the source CSS file and line number for each matched rule. Uses Chromium CDP — ignored when useBrowserStack is true (default: false)"),
      includeInherited: z.boolean().optional()
        .describe("When includeSource is true, also return the chain of inherited styles from ancestor elements (default: false)"),
      viewport: z.object({ width: z.number(), height: z.number() }).optional()
        .describe("Viewport size (default: {width:1280, height:720}). Affects media queries, container queries, and viewport units"),
      actions: z.array(actionSchema).optional()
        .describe("Actions to run before inspecting styles. Useful for triggering :hover, :focus, or toggling classes. Selector-based actions support optional and timeout params"),
      useBrowserStack: z.boolean().optional()
        .describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => computedStylesTool(resolveUrlOnly(params)) as any)
  );

  // 11. Evaluate script tool
  server.tool(
    "evaluate_script",
    "Run a JavaScript snippet in the page context and return its JSON-serialized result. Unlike the `evaluate` action (fire-and-forget), this tool returns the value. `return` works at the top level (the script is wrapped in an IIFE)." +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      script: z.string().describe("JS to evaluate. Use `return` to yield a value; result is JSON-stringified in the response"),
      browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Browser to use (default: "chromium")'),
      viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size (default: {width:1280, height:720})"),
      actions: z.array(actionSchema).optional().describe("Actions to run before evaluating. Selector-based actions support optional and timeout params"),
      waitForNetworkIdle: z.boolean().optional().describe("Wait for network idle before evaluating (default: true)"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => evaluateScriptTool(resolveUrlOnly(params)) as any)
  );

  // 12. Schema extract tool
  server.tool(
    "schema_extract",
    'Parse and validate all <script type="application/ld+json"> structured-data blocks on the page. Returns the parsed JSON, detected schema.org @type values, and heuristic issue flags (json-parse-failed, whitespace-run, escape-chars-in-string, faq-question-in-answer, faq-empty-answer).' +
      (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
    {
      url: z.string().describe(urlVisitDescription),
      actions: z.array(actionSchema).optional().describe("Actions to run before extracting. Selector-based actions support optional and timeout params"),
      useBrowserStack: z.boolean().optional().describe("Use BrowserStack (default: false)"),
      ...useSchemaField,
    },
    wrap(async (params) => schemaExtractTool(resolveUrlOnly(params)) as any)
  );

  // 13. List available modes (plugin-provided capabilities).
  server.tool(
    "list_modes",
    'List named modes registered by loaded plugins. Pass a mode name via a tool\'s `use` param to opt into its session hooks (e.g. use: "wordpress" attaches the Gutenberg plugin\'s WP auth cookie to a core tool call, unlocking /wp-admin/ URLs).',
    {},
    async () => {
      const modes = registry?.listModes() ?? [];
      if (modes.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No modes registered. Load plugins via BROWSER_MCP_PLUGINS to enable modes (e.g. BROWSER_MCP_PLUGINS=gutenberg registers the \"wordpress\" mode).",
          }],
        };
      }
      const payload = modes.map((m) => ({
        name: m.name,
        plugin: m.pluginName,
        description: m.description,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  // Register plugin tools
  if (registry) {
    for (const tool of registry.getTools()) {
      server.tool(
        tool.name,
        tool.description,
        tool.schema,
        wrap(tool.handler),
      );
    }
  }

  return server;
}

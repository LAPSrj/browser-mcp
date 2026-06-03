import { z } from "zod";
import type {
  ScreenshotPlugin,
  PluginContext,
  PluginConfigSchema,
} from "../types.js";
import { actionSchema, useSchemaField, browserStackFields } from "../../utils/schemas.js";
import { designCompareTool } from "./tools/design-compare.js";
import { designAuditTool } from "./tools/design-audit.js";

const pseudoElementsSchema = z
  .object({
    "::before": z
      .record(z.string(), z.string())
      .optional()
      .describe("Expected CSS properties for the ::before pseudo-element"),
    "::after": z
      .record(z.string(), z.string())
      .optional()
      .describe("Expected CSS properties for the ::after pseudo-element"),
  })
  .optional()
  .describe("Expected pseudo-element styles to compare");

const elementSchema = z.object({
  name: z.string().describe("Human-readable name for this element (e.g. 'heading', 'eyebrow')"),
  selector: z.string().describe("CSS selector for the rendered element on the live page"),
  expected: z.record(z.string(), z.string()).describe(
    "Expected CSS property values to compare against computed styles. Keys are CSS property names (kebab-case), values are CSS values (e.g. { \"font-size\": \"72px\", \"color\": \"#ffffff\" })",
  ),
  pseudoElements: pseudoElementsSchema,
  expectedTag: z.string().optional().describe("Expected HTML tag name (e.g. 'h1', 'div'). Verifies the selector matched the correct element type"),
  expectedText: z.string().optional().describe("Expected text content (trimmed, max 200 chars). Verifies the selector matched the correct element by content"),
});

const gapSchema = z.object({
  between: z
    .tuple([z.string(), z.string()])
    .describe("Pair of CSS selectors — gap is measured from the end of the first to the start of the second"),
  expected: z.string().describe("Expected gap value (e.g. '24px')"),
  axis: z
    .enum(["vertical", "horizontal"])
    .describe("Axis along which to measure the gap"),
});

const containmentSchema = z.object({
  child: z.string().describe("CSS selector for the child element"),
  parent: z.string().describe("CSS selector for the parent element"),
  expectClipped: z
    .boolean()
    .describe("If true, the child is expected to overflow the parent (e.g. decorative elements). If false, the child should be fully contained"),
});

const layoutSchema = z
  .object({
    gaps: z
      .array(gapSchema)
      .optional()
      .describe("Verify spacing between pairs of elements by comparing their bounding box gap against expected values"),
    containment: z
      .array(containmentSchema)
      .optional()
      .describe("Verify that child elements are contained within (or intentionally overflow) their parents"),
  })
  .optional()
  .describe("Cross-element layout checks: spacing gaps and parent/child containment");

const designComparePlugin: ScreenshotPlugin = {
  name: "design-compare",
  version: "0.3.0",

  getConfigSchema(): PluginConfigSchema {
    return {};
  },

  async register(ctx: PluginContext): Promise<void> {
    const { config } = ctx;
    const resolveUrl = ctx.core.resolveUrl;

    const urlDesc = config.baseUrl
      ? `URL of the page to compare (absolute or relative path — base: ${config.baseUrl})`
      : "URL of the page to compare (absolute URL required)";

    ctx.registerTool({
      name: "design_compare",
      description:
        "Compare expected CSS values (from a design spec) against the actual computed styles of rendered elements on a live page. " +
        "Accepts multiple elements in a single call for batch comparison. Returns per-property match/mismatch with deltas. " +
        "Handles color normalization (hex/rgb), numeric tolerance for rounding differences, and keyword matching. " +
        "Supports pseudo-element (::before/::after) style comparison, cross-element gap measurement, and parent/child containment checks. " +
        "Returns bounding box for each element and reports when selectors match multiple elements." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(urlDesc),
        viewport: z
          .object({ width: z.number(), height: z.number() })
          .optional()
          .describe("Viewport size to match the design frame (default: 1440x900)"),
        elements: z.array(elementSchema).describe(
          "Array of elements to compare. Each element has a name, CSS selector, expected CSS property values, and optional pseudo-element expectations.",
        ),
        layout: layoutSchema,
        tolerance: z
          .number()
          .optional()
          .describe("Numeric tolerance in px for dimension comparisons — values within this delta are considered matching (default: 0.5)"),
        freezeAnimations: z
          .boolean()
          .optional()
          .describe("Inject CSS to pause all animations and disable transitions before comparing (default: false). Prevents timing-dependent mismatches"),
        actions: z
          .array(actionSchema)
          .optional()
          .describe("Actions to run before comparing (e.g. wait for animations, scroll). Selector-based actions support optional and timeout params"),
        useBrowserStack: z
          .boolean()
          .optional()
          .describe("Use BrowserStack (default: false)"),
        ...browserStackFields,
        ...useSchemaField,
      },
      handler: async (params) =>
        (await designCompareTool({
          ...params,
          url: resolveUrl(params.url, config.baseUrl),
        })) as any,
    });

    const auditUrlDesc = config.baseUrl
      ? `URL of the page to audit (absolute or relative path — base: ${config.baseUrl})`
      : "URL of the page to audit (absolute URL required)";

    ctx.registerTool({
      name: "design_audit",
      description:
        "All-in-one design verification: runs deterministic CSS property comparison (design_compare) AND pixel-level visual diff against a reference, " +
        "then cross-references the results. Diff clusters that overlap elements with known property mismatches are marked 'explained'; " +
        "clusters with no corresponding property mismatch are flagged as 'unexplained' for investigation (pseudo-elements, cascade issues, compositional problems). " +
        "Accepts either a reference PNG image or a reference URL (e.g. figexport's standalone HTML) — when a URL is provided, the tool renders it in the same browser engine for apples-to-apples comparison. " +
        "Returns combined results from both passes plus a cross-check analysis in a single call." +
        (config.baseUrl ? ` Accepts relative URLs (base: ${config.baseUrl}).` : ""),
      schema: {
        url: z.string().describe(auditUrlDesc),
        referenceImage: z.string().optional().describe("Path to the Figma/design reference PNG image. Provide either this or referenceUrl"),
        referenceUrl: z.string().optional().describe("URL to the design reference page (e.g. file:// path to figexport's standalone HTML). The tool renders it at the target viewport and screenshots it. Provide either this or referenceImage"),
        rootSelector: z.string().describe("CSS selector for the root block element — used to scope the screenshot to just this block for pixel comparison"),
        viewport: z
          .object({ width: z.number(), height: z.number() })
          .optional()
          .describe("Viewport size to match the design frame (default: 1440x900)"),
        elements: z.array(elementSchema).describe(
          "Array of elements to compare. Each element has a name, CSS selector, expected CSS property values, and optional pseudo-element expectations.",
        ),
        layout: layoutSchema,
        tolerance: z
          .number()
          .optional()
          .describe("Numeric tolerance in px for dimension comparisons (default: 0.5)"),
        freezeAnimations: z
          .boolean()
          .optional()
          .describe("Inject CSS to pause all animations and disable transitions before comparing (default: false). Prevents timing-dependent mismatches"),
        hideSelectors: z
          .array(z.string())
          .optional()
          .describe("CSS selectors for elements to hide (visibility: hidden) before the visual diff screenshot. Use for dynamic content (images, user text) that would cause false positives in pixel comparison. Does not affect property comparison"),
        knownExclusions: z
          .array(z.string())
          .optional()
          .describe("CSS selectors for elements with expected visual differences (third-party embeds, JS-rendered content). Diff clusters overlapping these elements are marked 'excluded' instead of 'unexplained'"),
        diffMode: z
          .enum(["precise", "design"])
          .optional()
          .describe('Pixel comparison mode: "precise" (threshold 0.1) or "design" (threshold 0.3, default). Use "design" when comparing against Figma screenshots'),
        diffThreshold: z
          .number()
          .optional()
          .describe("Override pixel diff threshold (0-1). Takes precedence over diffMode"),
        actions: z
          .array(actionSchema)
          .optional()
          .describe("Actions to run before auditing"),
        outputDir: z
          .string()
          .optional()
          .describe('Output directory for diff images (default: ".browser")'),
        useBrowserStack: z
          .boolean()
          .optional()
          .describe("Use BrowserStack (default: false)"),
        ...browserStackFields,
        coverageManifest: z
          .object({
            nodeNames: z.array(z.string()).describe("All named nodes from the design file (_meta.nodeNames from resolve_styles)"),
            propertyCounts: z.record(z.string(), z.number()).describe("Property count per node from the design file (_meta.propertyCounts from resolve_styles)"),
          })
          .optional()
          .describe("Coverage manifest from resolve_styles _meta. When provided, the output includes element and property coverage stats against the design's ground truth"),
        ...useSchemaField,
      },
      handler: async (params) =>
        (await designAuditTool({
          ...params,
          url: resolveUrl(params.url, config.baseUrl),
        })) as any,
    });
  },
};

export default designComparePlugin;

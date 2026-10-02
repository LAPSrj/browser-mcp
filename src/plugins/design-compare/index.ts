import { z } from "zod";
import type {
  ScreenshotPlugin,
  PluginContext,
  PluginConfigSchema,
} from "../types.js";
import { actionSchema, actionsDesc, useSchemaField, browserStackFields } from "../../utils/schemas.js";
import { designCompareTool } from "./tools/design-compare.js";
import { designAuditTool } from "./tools/design-audit.js";

const pseudoElementsSchema = z
  .object({
    "::before": z
      .record(z.string(), z.string())
      .optional(),
    "::after": z
      .record(z.string(), z.string())
      .optional(),
  })
  .optional()
  .describe("Expected CSS for ::before / ::after");

const elementSchema = z.object({
  name: z.string().describe("Label, e.g. 'heading'"),
  selector: z.string().describe("CSS selector"),
  expected: z.record(z.string(), z.string()).describe(
    'Kebab-case property to CSS value, e.g. {"font-size":"72px","color":"#ffffff"}',
  ),
  pseudoElements: pseudoElementsSchema,
  expectedTag: z.string().optional().describe("e.g. 'h1'; confirms the selector hit the right element"),
  expectedText: z.string().optional().describe("Trimmed text (max 200 chars); confirms the selector hit the right element"),
});

const gapSchema = z.object({
  between: z
    .tuple([z.string(), z.string()])
    .describe("Gap from the end of the first to the start of the second"),
  expected: z.string().describe("e.g. '24px'"),
  axis: z
    .enum(["vertical", "horizontal"]),
});

const containmentSchema = z.object({
  child: z.string().describe("CSS selector"),
  parent: z.string().describe("CSS selector"),
  expectClipped: z
    .boolean()
    .describe("true: child should overflow the parent; false: fully contained"),
});

const layoutSchema = z
  .object({
    gaps: z
      .array(gapSchema)
      .optional()
      .describe("Bounding-box gaps between element pairs"),
    containment: z
      .array(containmentSchema)
      .optional()
      .describe("Child inside (or overflowing) parent"),
  })
  .optional()
  .describe("Cross-element layout checks");

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
      ? `Absolute URL or path relative to ${config.baseUrl}`
      : "Absolute URL";

    ctx.registerTool({
      name: "design_compare",
      description:
        "Compare design-spec CSS values with computed styles for many elements in one call (fresh ephemeral browser). " +
        "Normalizes colors (hex/rgb), allows numeric tolerance, checks ::before/::after, gaps, and containment. " +
        "Returns per-property match/mismatch with deltas, each element's bounding box, and a note when a selector matches several elements. " +
        "For a pixel diff as well use design-compare_design_audit.",
      schema: {
        url: z.string().describe(urlDesc),
        viewport: z
          .object({ width: z.number(), height: z.number() })
          .optional()
          .describe("Match the design frame (default 1440x900)"),
        elements: z.array(elementSchema).describe(
          "Elements to check",
        ),
        layout: layoutSchema,
        tolerance: z
          .number()
          .optional()
          .describe("px tolerance for dimensions (default 0.5)"),
        freezeAnimations: z
          .boolean()
          .optional()
          .describe("Pause animations and transitions first (default false)"),
        actions: z
          .array(actionSchema)
          .optional()
          .describe(actionsDesc),
        useBrowserStack: z
          .boolean()
          .optional()
          .describe("Default false"),
        ...browserStackFields,
        ...useSchemaField,
      },
      handler: async (params) =>
        (await designCompareTool({
          ...params,
          url: resolveUrl(params.url, config.baseUrl),
        })) as any,
    });

    const auditUrlDesc = urlDesc;

    ctx.registerTool({
      name: "design_audit",
      description:
        "design-compare_design_compare plus a pixel diff of rootSelector against a reference PNG or a reference URL (rendered in the same browser), cross-checked: " +
        "diff clusters over elements with property mismatches are 'explained', the rest 'unexplained' (or 'excluded' via knownExclusions).",
      schema: {
        url: z.string().describe(auditUrlDesc),
        referenceImage: z.string().optional().describe("Design PNG path. This or referenceUrl"),
        referenceUrl: z.string().optional().describe("Design page URL (e.g. file:// HTML export), screenshotted at the viewport. This or referenceImage"),
        rootSelector: z.string().describe("Block root; the pixel diff covers only this element"),
        viewport: z
          .object({ width: z.number(), height: z.number() })
          .optional()
          .describe("Match the design frame (default 1440x900)"),
        elements: z.array(elementSchema).describe(
          "Elements to check",
        ),
        layout: layoutSchema,
        tolerance: z
          .number()
          .optional()
          .describe("px tolerance for dimensions (default 0.5)"),
        freezeAnimations: z
          .boolean()
          .optional()
          .describe("Pause animations and transitions first (default false)"),
        hideSelectors: z
          .array(z.string())
          .optional()
          .describe("Hidden (visibility:hidden) for the pixel diff only, e.g. dynamic images or text"),
        knownExclusions: z
          .array(z.string())
          .optional()
          .describe("Selectors with expected differences (embeds, JS content); their clusters are 'excluded'"),
        diffMode: z
          .enum(["precise", "design"])
          .optional()
          .describe('"precise" (threshold 0.1) or "design" (0.3, default, for design screenshots)'),
        diffThreshold: z
          .number()
          .optional()
          .describe("Per-pixel threshold 0-1; overrides diffMode"),
        actions: z
          .array(actionSchema)
          .optional()
          .describe(actionsDesc),
        outputDir: z
          .string()
          .optional()
          .describe('Default ".browser"'),
        useBrowserStack: z
          .boolean()
          .optional()
          .describe("Default false"),
        ...browserStackFields,
        coverageManifest: z
          .object({
            nodeNames: z.array(z.string()).describe("_meta.nodeNames"),
            propertyCounts: z.record(z.string(), z.number()).describe("_meta.propertyCounts"),
          })
          .optional()
          .describe("resolve_styles _meta; adds element and property coverage stats against the design"),
        ...useSchemaField,
      },
      handler: async (params) =>
        (await designAuditTool({
          ...params,
          url: resolveUrl(params.url, config.baseUrl),
        })) as any,
      resultFile: true,
    });
  },
};

export default designComparePlugin;

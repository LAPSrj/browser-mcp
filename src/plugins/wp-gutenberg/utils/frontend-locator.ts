import type { Page } from "playwright";
import type { BlockFrontendHints } from "./wp-data.js";

export interface FrontendBlockMatch {
  /** Full outerHTML of the matched element. */
  html: string;
  /** The CSS selector string that matched. */
  matchedBy: string;
  /** Class list on the matched element. */
  classes: string[];
}

export interface FrontendLookupResult {
  /** All elements that matched. Empty array if nothing found. */
  matches: FrontendBlockMatch[];
  /** Selectors we tried, in order, for diagnostics. */
  triedSelectors: string[];
}

/**
 * Try to locate the rendered block(s) on the frontend page using a prioritized
 * list of selectors:
 *
 *   1. User-provided `overrideSelector` (if given) — always tried first
 *   2. The default class from wp.blocks.getBlockDefaultClassName()
 *   3. Any custom className on the block instance
 *   4. Specific classes from the block's editor DOM (filtered to wp-block-* only)
 *
 * Returns ALL matches (so blocks inserted multiple times are all captured).
 * Returns the list of selectors tried so callers can report useful diagnostics.
 */
export async function findBlockOnFrontend(
  page: Page,
  hints: BlockFrontendHints,
  overrideSelector?: string,
): Promise<FrontendLookupResult> {
  const selectors: string[] = [];

  if (overrideSelector) {
    selectors.push(overrideSelector);
  }
  if (hints.defaultClassName) {
    selectors.push(`.${cssEscape(hints.defaultClassName)}`);
  }
  if (hints.customClassName) {
    // customClassName may contain multiple space-separated classes
    for (const cls of hints.customClassName.split(/\s+/).filter(Boolean)) {
      selectors.push(`.${cssEscape(cls)}`);
    }
  }
  if (hints.editorDomClasses) {
    for (const cls of hints.editorDomClasses) {
      // Only use wp-block-* classes from the editor DOM — generic classes
      // like "has-background" match too many unrelated elements
      if (cls.startsWith("wp-block-") && !selectors.includes(`.${cssEscape(cls)}`)) {
        selectors.push(`.${cssEscape(cls)}`);
      }
    }
  }

  if (selectors.length === 0) {
    return { matches: [], triedSelectors: [] };
  }

  const matches = await page.evaluate(
    (sels) => {
      const seen = new Set<Element>();
      const results: Array<{ html: string; matchedBy: string; classes: string[] }> = [];
      for (const sel of sels) {
        let found: NodeListOf<Element>;
        try {
          found = document.querySelectorAll(sel);
        } catch {
          continue; // invalid selector, skip
        }
        for (const el of found) {
          if (seen.has(el)) continue;
          seen.add(el);
          results.push({
            html: el.outerHTML,
            matchedBy: sel,
            classes: Array.from(el.classList),
          });
        }
        if (results.length > 0) break; // first non-empty selector wins
      }
      return results;
    },
    selectors,
  );

  return { matches, triedSelectors: selectors };
}

/**
 * Escape a CSS class name for use in a selector. Handles characters like
 * `/`, `.`, `:`, `@`, etc. that WP block names can contain.
 */
function cssEscape(cls: string): string {
  // Browser's native CSS.escape handles everything correctly, but we're
  // running in Node context when building the selector strings. Use a
  // conservative escape for the common cases (alphanumerics, hyphens,
  // underscores pass through; everything else gets backslash-escaped).
  return cls.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

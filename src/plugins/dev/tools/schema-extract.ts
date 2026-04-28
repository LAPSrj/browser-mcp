import type { AnyAction } from "../../../utils/actions.js";
import { runActions, formatActionStop, formatAssertions } from "../../../utils/actions.js";
import { launchSession, closeSession, type BrowserName } from "../../../utils/browser.js";
import { navigateTo } from "../../../utils/navigate.js";

export interface SchemaExtractParams {
  url: string;
  actions?: AnyAction[];
  useBrowserStack?: boolean;
  summaryOnly?: boolean;
}

interface SchemaBlock {
  index: number;
  parseOk: boolean;
  parseError?: string;
  rawLength: number;
  /** The script's raw text. Truncated for readability; use parsed to inspect. */
  rawPreview: string;
  types?: string[];
  parsed?: unknown;
  /** Heuristic findings that catch the common "looks OK, isn't OK" failures. */
  issues: string[];
}

/**
 * Extract and validate all JSON-LD structured-data blocks on the page.
 *
 * Motivation: `accessibility_snapshot` returns `<script type="application/ld+json">`
 * content as an opaque text leaf, so "it looks present" passes but "the JSON
 * is malformed" or "the answer text contains raw tab/newline escapes" slips
 * through. This tool parses each block, collects the @type values, and flags
 * common issues (parse failure, unescaped whitespace runs, question-text
 * repeated inside answer-text, empty values).
 */
export async function schemaExtractTool(params: SchemaExtractParams) {
  const { url, actions = [], useBrowserStack = false, summaryOnly = false } = params;

  const session = await launchSession({
    browser: "chromium" as BrowserName,
    viewport: { width: 1280, height: 720 },
    useBrowserStack,
  });

  try {
    await navigateTo(session.page, url);

    let actionStopMsg: string | undefined;
    let assertionsMsg: string | undefined;
    if (actions.length > 0) {
      const { stoppedAt, assertions } = await runActions(session.page, actions);
      if (stoppedAt) actionStopMsg = formatActionStop(stoppedAt);
      assertionsMsg = formatAssertions(assertions);
    }

    const rawBlocks: string[] = await session.page.evaluate(() => {
      const scripts = document.querySelectorAll<HTMLScriptElement>(
        'script[type="application/ld+json"]',
      );
      return Array.from(scripts).map((s) => s.textContent ?? "");
    });

    const blocks: SchemaBlock[] = rawBlocks.map((raw, index) => {
      const trimmed = raw.trim();
      const rawPreview = trimmed.slice(0, 200);
      const issues: string[] = [];

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        return {
          index,
          parseOk: false,
          parseError: (err as Error).message,
          rawLength: raw.length,
          rawPreview,
          issues: ["json-parse-failed"],
        };
      }

      const types = collectTypes(parsed);

      walk(parsed, (value) => {
        if (typeof value !== "string") return;
        if (/\t{2,}|\n{2,}/.test(value)) issues.push("whitespace-run");
        if (/\\t|\\n/.test(value) && !value.includes(" ")) issues.push("escape-chars-in-string");
      });

      // FAQPage: mainEntity[i].name (question) should not appear verbatim inside
      // mainEntity[i].acceptedAnswer.text (answer). This was squidpickle's bug.
      if (types.includes("FAQPage")) {
        const mainEntity = (parsed as Record<string, unknown>).mainEntity;
        if (Array.isArray(mainEntity)) {
          for (const q of mainEntity) {
            if (typeof q !== "object" || q === null) continue;
            const qObj = q as Record<string, unknown>;
            const name = typeof qObj.name === "string" ? qObj.name.trim() : "";
            const answer = qObj.acceptedAnswer as Record<string, unknown> | undefined;
            const text = answer && typeof answer.text === "string" ? answer.text.trim() : "";
            if (name && text && text.includes(name)) {
              issues.push("faq-question-in-answer");
            }
            if (name && !text) issues.push("faq-empty-answer");
          }
        }
      }

      return {
        index,
        parseOk: true,
        rawLength: raw.length,
        rawPreview,
        types,
        parsed,
        issues: Array.from(new Set(issues)),
      };
    });

    const summary = {
      blockCount: blocks.length,
      allParseOk: blocks.every((b) => b.parseOk),
      typesFound: Array.from(new Set(blocks.flatMap((b) => b.types ?? []))),
      blocksWithIssues: blocks.filter((b) => b.issues.length > 0).length,
    };

    const content: Array<{ type: string; text: string }> = [];
    if (actionStopMsg) content.push({ type: "text", text: actionStopMsg });
    if (assertionsMsg) content.push({ type: "text", text: assertionsMsg });

    if (blocks.length === 0) {
      content.push({ type: "text", text: "No <script type=\"application/ld+json\"> blocks found on the page." });
      return { content };
    }

    if (summaryOnly) {
      // Drop `parsed` (the full JSON-LD body) and `rawPreview`; keep diagnostics.
      const compactBlocks = blocks.map((b) => ({
        index: b.index,
        parseOk: b.parseOk,
        ...(b.parseError ? { parseError: b.parseError } : {}),
        rawLength: b.rawLength,
        ...(b.types ? { types: b.types } : {}),
        issues: b.issues,
      }));
      content.push({ type: "text", text: JSON.stringify({ summary, blocks: compactBlocks }, null, 2) });
    } else {
      content.push({ type: "text", text: JSON.stringify({ summary, blocks }, null, 2) });
    }
    return { content };
  } finally {
    await closeSession(session);
  }
}

function collectTypes(obj: unknown, acc: string[] = []): string[] {
  if (Array.isArray(obj)) {
    for (const item of obj) collectTypes(item, acc);
    return acc;
  }
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    const t = rec["@type"];
    if (typeof t === "string") acc.push(t);
    else if (Array.isArray(t)) for (const s of t) if (typeof s === "string") acc.push(s);
    for (const key of Object.keys(rec)) {
      if (key !== "@type") collectTypes(rec[key], acc);
    }
  }
  return acc;
}

function walk(obj: unknown, visit: (value: unknown) => void): void {
  visit(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) walk(item, visit);
  } else if (obj && typeof obj === "object") {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      walk(value, visit);
    }
  }
}

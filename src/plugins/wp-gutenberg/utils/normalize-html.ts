import type { Page } from "playwright";

/**
 * Normalize a block's outerHTML so editor and frontend strings can be
 * structurally compared.
 *
 * Runs inside the current page's DOM via page.evaluate(), so the input is
 * parsed by a real HTML parser and re-serialized through outerHTML. That
 * canonicalizes attribute quoting, boolean attributes, and HTML entity
 * encoding (&amp; vs &, &quot; vs ", smart quotes, etc.) on both sides
 * symmetrically — no byte-level entity drift.
 *
 * The strip rules are scoped, not blanket:
 *   - Editor chrome (components-*, block-editor-block-toolbar wrappers) is
 *     removed as whole subtrees — that's editor UI noise by definition.
 *   - RichText UX attributes (aria-label, aria-readonly, aria-multiline,
 *     role, contenteditable, spellcheck, tabindex, the white-space:pre-wrap
 *     + min-width:1px style declarations) are stripped ONLY on elements
 *     identified as RichText (class="rich-text", role="textbox", or
 *     contenteditable) — leaves real frontend aria-label/style alone.
 *   - The block wrapper (originally data-block) gets its useBlockProps
 *     decoration stripped: aria-label="Block: …", draggable="true",
 *     tabindex="0", and the bare "wp-block" class — but only on the
 *     wrapper, so user content keeps its own draggable/aria-label/tabindex.
 *   - Generated ids are left alone here. The editor wrapper's
 *     id="block-{clientId}" and whatever id the theme generates on the
 *     frontend have different values by design; reconcileGeneratedIds()
 *     pairs the two normalized trees and gives both the same value.
 *   - Editor-only data attributes (data-block, data-type, data-title,
 *     data-wp-block, data-rich-text-*, data-is-drop-zone, data-empty,
 *     data-rich-text-placeholder) and editor-state classes (is-selected,
 *     is-hovered, …, block-editor-* prefix) are stripped everywhere.
 *   - Semantic no-ops are dropped: target="_self" on <a> (HTML default),
 *     empty aria-label / rel / class / style. target="_blank" without
 *     rel="noopener noreferrer" is intentionally NOT normalized — that's
 *     a real behavior diff and should surface.
 *
 * The same function runs on both editor and frontend strings. On frontend
 * input most rules are no-ops (no data-block, no contenteditable, no
 * components-*) — they exist defensively in case server-rendered HTML
 * happens to include matching markers.
 */
export interface NormalizeOptions {
  /**
   * Default block classes to strip from both editor and frontend HTML.
   *
   * Some core blocks declare `supports.className: false` (e.g. core/paragraph,
   * core/heading) — for those the save-side `useBlockProps.save` correctly
   * omits the `wp-block-{slug}` class, but the editor-side `useBlockProps`
   * still adds it for editor scaffolding. That produces an editor-only
   * asymmetry the normalizer can't detect from HTML alone.
   *
   * Caller (block_html) is expected to query
   * `wp.blocks.getBlockType(name).supports.className` for every registered
   * block type, derive the default class via
   * `wp.blocks.getBlockDefaultClassName`, and pass the list here. The strip
   * is applied symmetrically on both sides — safe because:
   *   - On the editor side, the class is editor-only chrome that needs to go.
   *   - On the frontend side, the class is already absent (per
   *     `supports.className: false`), so stripping is a no-op.
   */
  stripDefaultClasses?: string[];

  /**
   * Project-specific attributes to strip globally on every element.
   *
   * Each entry is either an exact attribute name (e.g.
   * "data-scroll-rotate-ready") or a trailing-`*` prefix pattern (e.g.
   * "data-scroll-rotate-*" matches any attribute starting with
   * "data-scroll-rotate-").
   *
   * Use case: client-side runtime artifacts written by project scripts
   * (intersection observers, scroll listeners, hydration markers) that
   * the editor and frontend may have in different states at capture time.
   * The normalizer is project-agnostic; the caller passes the list.
   */
  stripAttributes?: string[];

  /**
   * Project-specific classes to strip from class lists everywhere
   * (exact match, applied to all elements). Same use case as
   * stripAttributes — runtime-applied state classes that aren't part
   * of the block's structural output.
   */
  stripClasses?: string[];

  /**
   * CSS custom property names to remove from inline `style` attributes
   * everywhere. Each entry must include the leading `--` (e.g.
   * "--scroll-rotate"). Matching declarations are dropped; non-matching
   * declarations on the same element are preserved.
   */
  stripCssVars?: string[];

  /**
   * Class names marking project-specific editor chrome. Any element
   * bearing one of these classes is removed entirely with its subtree
   * — same mechanism as the built-in components-* / block-list-appender
   * removal, but extensible per-project.
   */
  stripSubtrees?: string[];
}

export async function normalizeBlockHtmlOnPage(
  page: Page,
  rawHtml: string,
  options: NormalizeOptions = {},
): Promise<string> {
  const stripDefaultClasses = options.stripDefaultClasses ?? [];
  const stripAttributes = options.stripAttributes ?? [];
  const stripClasses = options.stripClasses ?? [];
  const stripCssVars = options.stripCssVars ?? [];
  const stripSubtrees = options.stripSubtrees ?? [];
  return page.evaluate(({
    raw,
    stripDefaults,
    extraAttrs,
    extraClasses,
    extraCssVars,
    extraSubtrees,
  }) => {
    const tpl = document.createElement("template");
    tpl.innerHTML = raw;
    const root = tpl.content.firstElementChild;
    if (!root) return raw;
    const stripDefaultsSet = new Set<string>(stripDefaults);

    // Compile project-supplied attribute patterns into exact + prefix sets.
    const extraAttrExact = new Set<string>();
    const extraAttrPrefixes: string[] = [];
    for (const p of extraAttrs) {
      if (p.endsWith("*")) extraAttrPrefixes.push(p.slice(0, -1));
      else extraAttrExact.add(p);
    }
    const extraClassesSet = new Set<string>(extraClasses);
    const extraSubtreesSet = new Set<string>(extraSubtrees);
    const extraCssVarsSet = new Set<string>(extraCssVars);
    const extraCssVarPatterns: RegExp[] = [];
    for (const v of extraCssVars) {
      // Match a CSS declaration whose property is exactly this custom
      // property name. Anchored at start of the trimmed declaration.
      extraCssVarPatterns.push(
        new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "i"),
      );
    }

    const EDITOR_STATE_CLASSES = new Set([
      "is-selected",
      "is-hovered",
      "is-highlighted",
      "has-child-selected",
      "is-multi-selected",
      "is-typing",
      "is-focused",
      "is-focus-mode",
      "is-reusable",
      "wp-block-post-content",
      "rich-text",
    ]);

    const RICH_TEXT_STYLE_DROP = [
      /^white-space\s*:\s*pre-wrap$/i,
      /^min-width\s*:\s*1px$/i,
    ];

    // The block wrapper is the element that originally carried data-block.
    // Identify it BEFORE stripping data-block so wrapper-specific rules
    // (aria-label="Block: …", draggable="true", bare "wp-block" class) can
    // fire only on it.
    const isWrapperElement = (el: Element): boolean =>
      el.hasAttribute("data-block");

    const stripStyleDeclarations = (
      el: Element,
      patterns: RegExp[],
    ): void => {
      const style = el.getAttribute("style");
      if (!style) return;
      const kept = style
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d && !patterns.some((p) => p.test(d)))
        .join("; ");
      if (kept) el.setAttribute("style", kept);
      else el.removeAttribute("style");
    };

    const stripClasses = (el: Element, predicate: (c: string) => boolean): void => {
      const cls = el.getAttribute("class");
      if (!cls) return;
      const kept = cls.split(/\s+/).filter((c) => c && !predicate(c));
      if (kept.length) el.setAttribute("class", kept.join(" "));
      else el.removeAttribute("class");
    };

    const removeDataAttrs = (el: Element, predicate: (name: string) => boolean): void => {
      // Snapshot attributes first — modifying during iteration is unsafe.
      const names: string[] = [];
      for (const a of Array.from(el.attributes)) names.push(a.name);
      for (const name of names) {
        if (predicate(name)) el.removeAttribute(name);
      }
    };

    const walk = (el: Element): void => {
      const classList = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);

      // 1. Remove editor chrome subtrees entirely. These elements have NO
      //    equivalent in the frontend output — keeping them as anonymous
      //    empty wrappers (after class-strip) would still leave structural
      //    diff noise. Subtree-remove based on the original (pre-strip)
      //    class list:
      //      - components-*  : @wordpress/components (popovers, dropdowns,
      //                        inserter buttons inside InnerBlocks zones)
      //      - block-editor-block-toolbar : floating toolbar (rare)
      //      - block-list-appender / is-default-block-appender :
      //                        InnerBlocks "+ Add block" appender at the
      //                        end of every drop zone
      //      - block-editor-inserter / block-editor-block-list-appender :
      //                        the inserter chrome wrapping the appender
      const isChromeSubtree = classList.some(
        (c) =>
          c.startsWith("components-") ||
          c === "block-editor-block-toolbar" ||
          c === "block-list-appender" ||
          c === "block-list-appender__toggle" ||
          c === "is-default-block-appender" ||
          c === "wp-block-list-appender" ||
          // Any block-editor-* appender or inserter variant. Covers
          // block-editor-inserter, block-editor-default-block-appender,
          // block-editor-button-block-appender,
          // block-editor-block-list-appender, *-inserter__toggle, etc.
          (c.startsWith("block-editor-") &&
            (c.includes("appender") || c.includes("inserter"))) ||
          // Project-supplied subtree markers.
          extraSubtreesSet.has(c),
      );
      if (isChromeSubtree) {
        el.remove();
        return;
      }

      // 2. RichText scope — strip UX attrs ONLY here, not globally.
      const isRichText =
        classList.includes("rich-text") ||
        el.getAttribute("role") === "textbox" ||
        el.hasAttribute("contenteditable");

      if (isRichText) {
        el.removeAttribute("aria-label");
        el.removeAttribute("aria-readonly");
        el.removeAttribute("aria-multiline");
        el.removeAttribute("aria-describedby");
        el.removeAttribute("aria-autocomplete");
        el.removeAttribute("role");
        el.removeAttribute("contenteditable");
        el.removeAttribute("spellcheck");
        el.removeAttribute("tabindex");
        // Drop only the specific RichText-injected style declarations.
        stripStyleDeclarations(el, RICH_TEXT_STYLE_DROP);
      }

      // 3. Block-wrapper-only strips (identified by data-block presence).
      if (isWrapperElement(el)) {
        const al = el.getAttribute("aria-label");
        if (al && /^Block:\s/.test(al)) el.removeAttribute("aria-label");
        if (el.getAttribute("draggable") === "true") el.removeAttribute("draggable");
        // useBlockProps applies tabindex={0} for editor focusability — only
        // the exact value "0" on the wrapper, not user-set tabindex on
        // nested content.
        if (el.getAttribute("tabindex") === "0") el.removeAttribute("tabindex");
        // Bare "wp-block" class is wrapper-only editor decoration; the
        // frontend keeps wp-block-{slug} but not bare wp-block.
        stripClasses(el, (c) => c === "wp-block");
      }

      // 3b. Semantic-no-op attributes some block authors emit always vs.
      //     conditionally. These are HTML/ARIA no-ops — stripping them is
      //     canonical-form normalization, not hiding behavior drift:
      //       - <a target="_self"> is the HTML default; identical to no target.
      //       - aria-label="" falls back to accessible name from content.
      //       - rel="" / class="" / style="" are byte-noise.
      //     Note: target="_blank" without rel="noopener noreferrer" is a
      //     REAL behavior diff and is intentionally NOT normalized.
      if (el.tagName === "A" && el.getAttribute("target") === "_self") {
        el.removeAttribute("target");
      }
      for (const emptyAttr of ["aria-label", "rel", "class", "style"]) {
        if (el.getAttribute(emptyAttr) === "") el.removeAttribute(emptyAttr);
      }

      // 4. Editor-only data attributes everywhere.
      //      - data-block/data-type/data-title : useBlockProps wrapper id +
      //        block-type metadata
      //      - data-wp-block-* (prefix) : block-editor internals, including
      //        data-wp-block-attribute-key (RichText's mapping of the
      //        contenteditable area to a block attribute). Prefix-matching
      //        is intentional — the family expands across Gutenberg
      //        versions and none of these attrs ship to the frontend.
      //      - data-is-drop-zone : drop target markers
      //      - data-rich-text-* (prefix) + data-rich-text-placeholder :
      //        RichText editor state
      //      - data-empty : empty paragraph placeholder
      removeDataAttrs(
        el,
        (name) =>
          name === "data-block" ||
          name === "data-type" ||
          name === "data-title" ||
          name === "data-wp-block" ||
          name.startsWith("data-wp-block-") ||
          name === "data-is-drop-zone" ||
          name === "data-empty" ||
          name === "data-rich-text-placeholder" ||
          name.startsWith("data-rich-text-"),
      );

      // 5. role="document" is editor-canvas only.
      if (el.getAttribute("role") === "document") el.removeAttribute("role");

      // 6. Editor-state classes + block-editor-* prefix everywhere.
      //    Also strip the default classes for blocks that declared
      //    supports.className: false (see NormalizeOptions docstring),
      //    plus project-supplied class names.
      stripClasses(
        el,
        (c) =>
          EDITOR_STATE_CLASSES.has(c) ||
          c.startsWith("block-editor-") ||
          stripDefaultsSet.has(c) ||
          extraClassesSet.has(c),
      );

      // 6b. Project-supplied attribute strips (exact name + trailing-*
      //     prefix patterns).
      if (extraAttrExact.size > 0 || extraAttrPrefixes.length > 0) {
        removeDataAttrs(
          el,
          (name) =>
            extraAttrExact.has(name) ||
            extraAttrPrefixes.some((pre) => name.startsWith(pre)),
        );
      }

      // 6c. Project-supplied CSS custom property strips. Drop matching
      //     declarations from inline style; preserve everything else.
      if (extraCssVarPatterns.length > 0) {
        stripStyleDeclarations(el, extraCssVarPatterns);
      }

      // 7. Recurse into a snapshot — children may be removed mid-walk.
      for (const child of Array.from(el.children)) walk(child);
    };

    walk(root);

    // Final pass: collapse pure-whitespace text nodes between element
    // siblings, since editor and frontend can format their HTML differently
    // even after attribute strips. Don't touch mixed text+inline-element
    // content (e.g. "hello <span>world</span>!").
    const collapseWhitespace = (el: Element): void => {
      const children = Array.from(el.childNodes);
      const allElementSiblings = children.every(
        (n) =>
          n.nodeType === 1 ||
          (n.nodeType === 3 && /^\s*$/.test(n.textContent || "")),
      );
      if (allElementSiblings) {
        for (const n of children) {
          if (n.nodeType === 3) el.removeChild(n);
        }
      }
      for (const child of Array.from(el.children)) collapseWhitespace(child);
    };
    collapseWhitespace(root);

    // Final pass: remove editor-chrome carcasses left after class strips.
    // When the normalizer strips identifying classes/attrs from chrome
    // wrappers, the elements remain as content-free shells. A <span> or
    // <div> with no text, no remaining children, and no semantically
    // meaningful attributes (only an absolute-positioned style decoration
    // OR nothing) is editor scaffolding the frontend never produces.
    //
    // Bottom-up: clean each subtree first, so wrapper carcasses can
    // collapse once their leaf chrome children are gone.
    //
    // Conservative scope: only <span> and <div> (typical chrome wrappers).
    // Real content with empty paragraphs/headings/etc. is preserved.
    const isCarcass = (el: Element): boolean => {
      if (el.tagName !== "SPAN" && el.tagName !== "DIV") return false;
      if (el.textContent && el.textContent.trim()) return false;
      if (el.children.length > 0) return false;
      for (const a of Array.from(el.attributes)) {
        // Tolerate absolute-positioned style decoration (the editor
        // appender overlay signature).
        if (a.name === "style" && /position\s*:\s*absolute/i.test(a.value)) {
          continue;
        }
        return false;
      }
      return true;
    };

    const cleanupCarcasses = (el: Element): void => {
      for (const child of Array.from(el.children)) cleanupCarcasses(child);
      for (const child of Array.from(el.children)) {
        if (isCarcass(child)) child.remove();
      }
    };
    cleanupCarcasses(root);

    return root.outerHTML;
  }, {
    raw: rawHtml,
    stripDefaults: stripDefaultClasses,
    extraAttrs: stripAttributes,
    extraClasses: stripClasses,
    extraCssVars: stripCssVars,
    extraSubtrees: stripSubtrees,
  });
}

/** One block wrapper in the editor HTML, in document order. */
export interface EditorBlockId {
  /** The wrapper's editor id, Gutenberg's `block-{clientId}`. */
  id: string;
  /** The block's `anchor` attribute, or null when it has none. */
  anchor: string | null;
}

/**
 * Collect the wrapper id and anchor of every block in a raw editor
 * outerHTML (the root block and its inner blocks), in document order.
 * Runs on the editor page, where wp.data can read the block attributes.
 */
export async function collectEditorBlockIds(
  page: Page,
  rawEditorHtml: string,
): Promise<EditorBlockId[]> {
  return page.evaluate((raw) => {
    const wp = (window as any).wp;
    const store = wp?.data?.select?.("core/block-editor");
    const tpl = document.createElement("template");
    tpl.innerHTML = raw;
    const out: { id: string; anchor: string | null }[] = [];
    for (const el of Array.from(tpl.content.querySelectorAll("[data-block]"))) {
      if (!el.id) continue;
      const anchor = store?.getBlock(el.getAttribute("data-block"))?.attributes?.anchor;
      out.push({ id: el.id, anchor: typeof anchor === "string" && anchor ? anchor : null });
    }
    return out;
  }, rawEditorHtml);
}

/**
 * Give generated ids the same value on both sides of a normalized
 * editor/frontend pair.
 *
 * Gutenberg's useBlockProps always sets the editor wrapper id to
 * `block-{clientId}`, even when the block has an anchor. On the frontend
 * the same block has its anchor, an id the theme generates, or no id.
 * Block code often derives more ids from the wrapper id
 * (`{id}-heading`) and points ARIA attributes at them, so those differ
 * too. For each editor block wrapper:
 *   - With an anchor: the editor id becomes the anchor, so the frontend
 *     shows a difference only when it doesn't output the anchor.
 *   - Without an anchor: the frontend element at the same position in the
 *     normalized tree (same tag) is its counterpart. If that element has
 *     an id, the theme generated it, and both ids become
 *     `generated-id-{n}`. If it has none (or there's no counterpart), the
 *     editor id is removed.
 * Derived ids (`{id}-…`) and references to them in id-reference
 * attributes and `href="#…"` are rewritten with the id they derive from.
 * Pairing by position can't match blocks whose structure already differs
 * between the sides; those keep their own ids, inside a diff that shows
 * anyway.
 */
export async function reconcileGeneratedIds(
  page: Page,
  editorHtml: string,
  frontendHtml: string | null,
  editorBlocks: EditorBlockId[],
): Promise<{ editor: string; frontend: string | null }> {
  return page.evaluate(({ editorRaw, frontendRaw, blocks }) => {
    const parse = (html: string): Element | null => {
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      return tpl.content.firstElementChild;
    };
    const editorRoot = parse(editorRaw);
    if (!editorRoot) return { editor: editorRaw, frontend: frontendRaw };
    const frontendRoot = frontendRaw === null ? null : parse(frontendRaw);

    // Pair editor wrapper ids with the frontend id at the same position.
    const wrapperIds = new Set(blocks.map((b) => b.id));
    const frontendIdFor = new Map<string, string | null>();
    const pair = (e: Element, f: Element): void => {
      if (e.tagName !== f.tagName) return;
      if (e.id && wrapperIds.has(e.id)) frontendIdFor.set(e.id, f.id || null);
      const n = Math.min(e.children.length, f.children.length);
      for (let i = 0; i < n; i++) pair(e.children[i], f.children[i]);
    };
    if (frontendRoot) pair(editorRoot, frontendRoot);

    const editorMap = new Map<string, string>();
    const frontendMap = new Map<string, string>();
    const editorDrop = new Set<string>();
    blocks.forEach((b, n) => {
      if (b.anchor) {
        editorMap.set(b.id, b.anchor);
        return;
      }
      const f = frontendIdFor.get(b.id);
      if (f) {
        const placeholder = `generated-id-${n}`;
        editorMap.set(b.id, placeholder);
        frontendMap.set(f, placeholder);
      } else {
        editorDrop.add(b.id);
      }
    });

    const ID_REF_ATTRS = [
      "aria-activedescendant",
      "aria-controls",
      "aria-describedby",
      "aria-details",
      "aria-errormessage",
      "aria-flowto",
      "aria-labelledby",
      "aria-owns",
      "commandfor",
      "for",
      "form",
      "headers",
      "list",
      "popovertarget",
    ];

    const rewrite = (root: Element, map: Map<string, string>, drop: Set<string>): void => {
      // Longest first, so "a-b" wins over "a" for "a-b-heading".
      const entries = Array.from(map).sort((x, y) => y[0].length - x[0].length);
      const mapId = (v: string): string => {
        for (const [from, to] of entries) {
          if (v === from) return to;
          if (v.startsWith(`${from}-`)) return to + v.slice(from.length);
        }
        return v;
      };
      for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
        const id = el.getAttribute("id");
        if (id !== null) {
          if (drop.has(id)) el.removeAttribute("id");
          else el.setAttribute("id", mapId(id));
        }
        for (const name of ID_REF_ATTRS) {
          const v = el.getAttribute(name);
          if (v) el.setAttribute(name, v.split(/\s+/).filter(Boolean).map(mapId).join(" "));
        }
        for (const name of ["href", "xlink:href"]) {
          const v = el.getAttribute(name);
          if (v && v.startsWith("#")) el.setAttribute(name, `#${mapId(v.slice(1))}`);
        }
      }
    };

    rewrite(editorRoot, editorMap, editorDrop);
    if (frontendRoot) rewrite(frontendRoot, frontendMap, new Set());
    return {
      editor: editorRoot.outerHTML,
      frontend: frontendRoot ? frontendRoot.outerHTML : null,
    };
  }, { editorRaw: editorHtml, frontendRaw: frontendHtml, blocks: editorBlocks });
}

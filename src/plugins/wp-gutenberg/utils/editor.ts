import type { Page, Frame } from "playwright";
import type { WpSite, WpSites } from "../../wp/sites.js";

/**
 * Wait for the Gutenberg block editor to be fully loaded and interactive.
 * Handles the async React app startup and wp.data store initialization.
 */
export async function waitForEditor(page: Page): Promise<void> {
  // Wait for the editor wrapper — covers both iframe and non-iframe modes
  await page.waitForSelector(
    '.block-editor-block-list__layout, iframe[name="editor-canvas"]',
    { timeout: 15000 },
  );

  // Wait for wp.data to be available
  await page.waitForFunction(
    () => typeof (window as any).wp !== "undefined"
      && (window as any).wp.data
      && (window as any).wp.data.select("core/block-editor"),
    { timeout: 10000 },
  );

  // Wait for the editor store to signal readiness (WP 6.x+)
  await page.waitForFunction(
    () => {
      const wp = (window as any).wp;
      const editor = wp.data.select("core/editor");
      // __unstableIsEditorReady exists on WP 6.x+
      if (editor && typeof editor.__unstableIsEditorReady === "function") {
        return editor.__unstableIsEditorReady();
      }
      // Fallback for older versions: if blocks store is responding, assume ready
      return true;
    },
    { timeout: 10000 },
  );

  // On WP 6.x+ the blocks render in the editor-canvas iframe, whose document
  // loads after the iframe element appears; until then contentDocument is
  // null or still loading, and scripts that read it fail. No iframe (older
  // WP, or the classic-mode wrapper matched above): nothing to wait for.
  await page.waitForFunction(
    () => {
      const iframe = document.querySelector('iframe[name="editor-canvas"]') as HTMLIFrameElement | null;
      if (!iframe) return true;
      const doc = iframe.contentDocument;
      return !!doc && doc.readyState === "complete" && !!doc.body;
    },
    { timeout: 10000 },
  ).catch(() => {
    throw new Error("The editor canvas iframe's document didn't finish loading within 10 s.");
  });

  // Wait for any loading overlays to disappear
  const loadingOverlay = await page.$(".edit-post-layout__loading");
  if (loadingOverlay) {
    await page.waitForSelector(".edit-post-layout__loading", {
      state: "detached",
      timeout: 10000,
    }).catch(() => { /* may not exist */ });
  }
}

/** How to find one block's element in the editor canvas. */
export type EditorBlockLocator =
  | { clientId: string }
  | { name: string; sameNameIndex: number; anchor: string | null };

export interface BlockRendererTracker {
  inFlight(): number;
  dispose(): void;
}

const isBlockRendererUrl = (url: string): boolean =>
  url.includes("/wp/v2/block-renderer/") || url.includes("wp%2Fv2%2Fblock-renderer%2F");

/**
 * Count the page's in-flight /wp/v2/block-renderer/ requests (ServerSideRender).
 * Attach before navigating to the editor so the first renders are counted.
 * Tracks request objects, not a counter, so a request that started before
 * attaching can't drive the count below zero.
 */
export function trackBlockRendererRequests(page: Page): BlockRendererTracker {
  const pending = new Set<unknown>();
  const onRequest = (r: { url(): string }) => {
    if (isBlockRendererUrl(r.url())) pending.add(r);
  };
  const onDone = (r: unknown) => { pending.delete(r); };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  return {
    inFlight: () => pending.size,
    dispose: () => {
      page.off("request", onRequest);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
    },
  };
}

/**
 * Wait until a block's editor markup is final, so one read matches the next:
 *
 *   - no pending server render: no [data-not-ready="true"] under
 *     #filtered-server-side-render-root (FilteredServerSideRender's hidden
 *     node) in the page or canvas document, and no in-flight
 *     /wp/v2/block-renderer/ request;
 *   - no stale disabled markup: in template-locked mode the editor first
 *     paints post-content blocks as is-editing-disabled and re-renders them
 *     after the store's editing mode settles, so an is-editing-disabled
 *     wrapper whose store mode isn't "disabled" is still waiting for that
 *     re-render;
 *   - the block's outerHTML has been unchanged for `quietMs`.
 *
 * Throws on timeout with the conditions that were still unmet.
 */
export async function waitForBlockToSettle(
  page: Page,
  locator: EditorBlockLocator,
  tracker: BlockRendererTracker | null,
  opts: { quietMs?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const quietMs = opts.quietMs ?? 400;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const pollMs = opts.pollMs ?? 50;
  const start = Date.now();
  let lastHtml: string | null | undefined;
  let stableSince = start;

  for (;;) {
    const probe = await page.evaluate((loc) => {
      const iframe = document.querySelector('iframe[name="editor-canvas"]') as HTMLIFrameElement | null;
      const doc = iframe?.contentDocument || document;
      const docs = doc === document ? [document] : [document, doc];
      let pendingFssr = 0;
      for (const d of docs) {
        pendingFssr += d.querySelectorAll('#filtered-server-side-render-root [data-not-ready="true"]').length;
      }

      let el: Element | null = null;
      if ("clientId" in loc) {
        el = doc.querySelector(`[data-block="${CSS.escape(loc.clientId)}"]`);
      } else {
        if (loc.anchor) el = doc.getElementById(loc.anchor);
        if (!el) {
          const wrapper = doc.querySelector('[data-type="core/post-content"]');
          const same = wrapper
            ? Array.from(wrapper.querySelectorAll(`[data-type="${CSS.escape(loc.name)}"]`))
            : [];
          el = same[loc.sameNameIndex] ?? null;
        }
      }
      if (!el) return { html: null as string | null, pendingFssr, staleDisabled: 0 };

      let staleDisabled = 0;
      const be = (window as any).wp?.data?.select?.("core/block-editor");
      if (be && typeof be.getBlockEditingMode === "function") {
        const wrappers = [el, ...Array.from(el.querySelectorAll("[data-block]"))];
        for (const w of wrappers) {
          if (!w.classList.contains("is-editing-disabled")) continue;
          const cid = w.getAttribute("data-block");
          if (!cid || !be.getBlock?.(cid)) continue;
          if (be.getBlockEditingMode(cid) !== "disabled") staleDisabled++;
        }
      }
      return { html: el.outerHTML, pendingFssr, staleDisabled };
    }, locator);

    const now = Date.now();
    if (probe.html !== lastHtml) {
      lastHtml = probe.html;
      stableSince = now;
    }
    const inFlight = tracker?.inFlight() ?? 0;
    const quietFor = now - stableSince;
    if (
      probe.html !== null &&
      probe.pendingFssr === 0 &&
      inFlight === 0 &&
      probe.staleDisabled === 0 &&
      quietFor >= quietMs
    ) {
      return;
    }

    if (now - start >= timeoutMs) {
      const unmet: string[] = [];
      if (probe.html === null) unmet.push("the block's element is not in the editor canvas");
      if (probe.pendingFssr > 0) {
        unmet.push(
          `${probe.pendingFssr} server-side render(s) still pending ` +
          `(#filtered-server-side-render-root [data-not-ready="true"])`,
        );
      }
      if (inFlight > 0) unmet.push(`${inFlight} /wp/v2/block-renderer/ request(s) still in flight`);
      if (probe.staleDisabled > 0) {
        unmet.push(
          `${probe.staleDisabled} block wrapper(s) still show is-editing-disabled ` +
          `while the block-editor store's editing mode is not "disabled"`,
        );
      }
      if (probe.html !== null && quietFor < quietMs) {
        unmet.push(`the block's DOM changed ${quietFor} ms ago (needs ${quietMs} ms without changes)`);
      }
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for the block's editor markup to settle: ${unmet.join("; ")}.`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Get the editor canvas frame. WP 6.x+ renders blocks inside an iframe.
 * Returns the iframe Frame if present, otherwise the main page (WP < 6.0).
 */
export async function getEditorFrame(page: Page): Promise<Page | Frame> {
  const iframeHandle = await page.$('iframe[name="editor-canvas"]');
  if (iframeHandle) {
    const frame = await iframeHandle.contentFrame();
    if (frame) return frame;
  }
  return page;
}

/**
 * Returns true when the page is already on <site>/wp-admin/post.php?post=<postId>&action=edit
 * for ANY host. Lets caller-owned sessions authed against an unconfigured host
 * (e.g. staging) skip the goto that would otherwise yank the page to the site URL.
 */
function isOnPostEditor(currentUrl: string, postId: number): boolean {
  try {
    const u = new URL(currentUrl);
    if (!u.pathname.endsWith("/wp-admin/post.php")) return false;
    if (u.searchParams.get("post") !== String(postId)) return false;
    if (u.searchParams.get("action") !== "edit") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Navigate to the WordPress post editor and ensure auth + editor readiness.
 * If the session has expired (redirected to login), re-authenticates and retries.
 *
 * Detect-and-skip: when the page is already on the target post editor on the
 * target site, or on a host that isn't a configured site, skip the goto.
 * Otherwise navigation would force the page to the site URL, breaking
 * caller-owned sessions authed against an unconfigured host. A page on
 * another configured site's editor is moved to the target site.
 */
export async function navigateToEditor(
  page: Page,
  postId: number,
  site: WpSite,
  sites: WpSites,
): Promise<void> {
  const auth = site.auth;
  const editorUrl = `${site.url}/wp-admin/post.php?post=${postId}&action=edit`;
  const current = page.url();
  const alreadyThere = isOnPostEditor(current, postId) && (sites.forUrl(current) ?? site) === site;

  if (!alreadyThere) {
    await page.goto(editorUrl, { waitUntil: "load", timeout: 30000 });

    // Detect auth redirect
    if (auth.isOnLoginPage(page)) {
      auth.invalidate();
      // Re-login on this page (we're already on the login form)
      await auth.getStorageState(page);
      // Navigate again
      await page.goto(editorUrl, { waitUntil: "load", timeout: 30000 });

      if (auth.isOnLoginPage(page)) {
        throw new Error("WordPress authentication failed: unable to access the editor after re-login.");
      }
    }
  }

  // Check if we're on a Gutenberg editor (not classic)
  const hasBlockEditor = await page.$(".block-editor-block-list__layout, iframe[name=\"editor-canvas\"], .edit-post-visual-editor");
  const hasClassicEditor = await page.$("#post");

  if (!hasBlockEditor && hasClassicEditor) {
    throw new Error(
      "This post uses the Classic Editor, not Gutenberg. " +
      "The gutenberg plugin requires the block editor to be active."
    );
  }

  await waitForEditor(page);
}

export interface EditorReturn {
  /** Remember the editor URL and rendering mode. Call right before leaving the editor. */
  leave(): Promise<void>;
  /** Go back to the remembered editor. Returns a warning if that failed. No-op if leave() wasn't called. */
  back(): Promise<string | null>;
}

/**
 * Bring a caller-owned session back to the editor after a tool visits the
 * frontend, in the rendering mode (e.g. "post-only") it had before, so the
 * caller's next editor call doesn't have to navigate back and set it again.
 * Disabled for ephemeral sessions, which close anyway.
 */
export function editorReturn(page: Page, enabled: boolean): EditorReturn {
  let state: { url: string; renderingMode: string | null } | null = null;
  return {
    async leave() {
      if (!enabled) return;
      const renderingMode = await page.evaluate(() => {
        const editor = (window as any).wp?.data?.select("core/editor");
        return typeof editor?.getRenderingMode === "function" ? (editor.getRenderingMode() as string) : null;
      }).catch(() => null);
      state = { url: page.url(), renderingMode };
    },
    async back() {
      if (!state) return null;
      const { url, renderingMode } = state;
      state = null;
      try {
        await page.goto(url, { waitUntil: "load", timeout: 30000 });
        await waitForEditor(page);
        if (renderingMode) {
          await page.evaluate((mode) => {
            const wp = (window as any).wp;
            if (wp.data.select("core/editor").getRenderingMode() !== mode) {
              wp.data.dispatch("core/editor").setRenderingMode(mode);
            }
          }, renderingMode);
        }
        return null;
      } catch (e) {
        return `Couldn't return the session to the editor (${url}); it may still be on the frontend: ${(e as Error).message}`;
      }
    },
  };
}

/**
 * Wait for a specific block type to be registered in the block editor.
 * Custom blocks loaded via wp_enqueue_script may register after the editor is "ready".
 */
export async function waitForBlockType(page: Page, blockName: string, timeoutMs = 10000): Promise<boolean> {
  try {
    await page.waitForFunction(
      (name: string) => {
        const wp = (window as any).wp;
        return wp && wp.blocks && !!wp.blocks.getBlockType(name);
      },
      blockName,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the WordPress version from the page.
 */
export async function detectWpVersion(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const meta = document.querySelector('meta[name="generator"]');
    if (meta) {
      const content = meta.getAttribute("content") || "";
      const match = content.match(/WordPress\s+([\d.]+)/);
      if (match) return match[1];
    }
    return null;
  });
}

/**
 * Check if the editor has crashed (React error boundary).
 */
export async function checkEditorError(page: Page): Promise<string | null> {
  const errorBoundary = await page.$(".editor-error-boundary");
  if (errorBoundary) {
    const text = await errorBoundary.textContent();
    return text?.trim() || "Editor crashed (error boundary triggered)";
  }
  return null;
}

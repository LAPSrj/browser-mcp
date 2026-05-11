import type { Page, Frame } from "playwright";
import type { ResolvedPluginConfig } from "../../types.js";
import type { WpAuth } from "../../wp/auth.js";

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

  // Wait for any loading overlays to disappear
  const loadingOverlay = await page.$(".edit-post-layout__loading");
  if (loadingOverlay) {
    await page.waitForSelector(".edit-post-layout__loading", {
      state: "detached",
      timeout: 10000,
    }).catch(() => { /* may not exist */ });
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
 * Returns true when the page is already on /wp-admin/post.php?post=<postId>&action=edit
 * for ANY host. Lets caller-owned sessions authed against a different host
 * (e.g. staging) skip the goto that would otherwise yank the page to config.wpUrl.
 */
function isOnPostEditor(currentUrl: string, postId: number): boolean {
  try {
    const u = new URL(currentUrl);
    if (u.pathname !== "/wp-admin/post.php") return false;
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
 * Detect-and-skip: when the page is already on the target post editor on any
 * host, skip the goto. Otherwise navigation would force the page to config.wpUrl,
 * breaking caller-owned sessions authed against a different host.
 */
export async function navigateToEditor(
  page: Page,
  postId: number,
  config: ResolvedPluginConfig,
  auth: WpAuth,
): Promise<void> {
  const base = config.wpUrl.replace(/\/+$/, "");
  const editorUrl = `${base}/wp-admin/post.php?post=${postId}&action=edit`;

  if (!isOnPostEditor(page.url(), postId)) {
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

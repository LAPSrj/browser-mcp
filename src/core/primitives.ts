import { z } from "zod";
import type { BrowserContext, Page } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import {
  launchSession,
  closeSession,
  type BrowserName,
} from "../utils/browser.js";
import { sessionManager } from "./sessions.js";
import { useSchemaField } from "../utils/schemas.js";

// All the user-replicable browser primitives — the things a human can do
// in a browser without opening DevTools. Each primitive accepts an
// optional session_id; when provided the tool reuses the existing
// session's page, when omitted it spins up a one-shot ephemeral context.

type Viewport = { width: number; height: number };

interface CommonTarget {
  session_id?: string;
  tab_id?: string;
  browser?: BrowserName;
  viewport?: Viewport;
  useBrowserStack?: boolean;
}

async function withPage<T>(
  params: CommonTarget,
  fn: (page: Page, ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  if (params.session_id) {
    sessionManager.touch(params.session_id);
    const page = sessionManager.getPage(params.session_id, params.tab_id);
    return await fn(page, page.context());
  }
  const session = await launchSession({
    browser: params.browser ?? "chromium",
    viewport: params.viewport ?? { width: 1280, height: 720 },
    useBrowserStack: params.useBrowserStack,
  });
  try {
    return await fn(session.page, session.context);
  } finally {
    await closeSession(session);
  }
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const json = (obj: unknown) => ok(JSON.stringify(obj, null, 2));
const err = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const targetField = {
  session_id: z
    .string()
    .optional()
    .describe(
      "Attach to an existing persistent session from open_session. Without it the tool opens an ephemeral context for this call only.",
    ),
  tab_id: z.string().optional().describe("Which tab in the session to target. Defaults to the session's active tab."),
  browser: z
    .enum(["chromium", "firefox", "webkit"])
    .optional()
    .describe('Browser to use for ephemeral calls (ignored when session_id is set). Default: "chromium"'),
  viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport for ephemeral calls (ignored when session_id is set)"),
  useBrowserStack: z.boolean().optional().describe("Use BrowserStack for ephemeral calls (default: false)"),
};

const selectorField = {
  selector: z.string().describe("CSS selector of the target element"),
};
const timeoutField = {
  timeout: z.number().optional().describe("Action timeout in ms (default: 30000)"),
};

// ---------------------------------------------------------------------------
// Session lifecycle tools
// ---------------------------------------------------------------------------

export const sessionPrimitives: Record<string, PrimitiveDef> = {
  open_session: {
    description:
      "Open a persistent browser session the agent can reuse across multiple tool calls. " +
      "Returns a session_id that other primitives accept. Sessions self-close on idle (default 5 min), " +
      "on hard wall-clock cap (30 min; 2 min if record_video is enabled), or when the MCP server exits. " +
      "Enable record_video to capture a webm of the session — Playwright records the whole context, so " +
      "the session lifetime is clamped short to prevent runaway recordings.",
    schema: {
      browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Browser (default: "chromium")'),
      viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Viewport size (default: {width:1280,height:720})"),
      url: z.string().optional().describe("Initial URL to load (optional)"),
      user_agent: z.string().optional().describe("Custom user-agent string"),
      locale: z.string().optional().describe("Locale (e.g. \"en-US\")"),
      timezone: z.string().optional().describe("IANA timezone id (e.g. \"America/New_York\")"),
      record_video: z.boolean().optional().describe(
        "Record video of the session. When true, wall-clock TTL is clamped to 10 min max (default 2 min). webm files land in <output_dir>/videos/<session_id>/",
      ),
      idle_ttl_ms: z.number().optional().describe("Close when no tool touches the session for this many ms (default: 300000)"),
      wall_ttl_ms: z.number().optional().describe(
        "Hard max session lifetime in ms. Default 1800000 (30 min), or 120000 (2 min) with record_video. Max 600000 (10 min) when record_video is true.",
      ),
      output_dir: z.string().optional().describe('Directory for video artifacts (default: ".browser")'),
      headless: z.boolean().optional().describe(
        "When false, opens a visible browser window. Useful for human-in-the-loop captcha/login flows. " +
          "On WSL, the Linux Chromium window renders directly into the Windows desktop via WSLg. Default: true.",
      ),
      // attach_cdp accepts boolean OR endpoint URL string. Some MCP clients
      // string-coerce booleans (true → "true") on the wire; without the
      // preprocess below, "true" would be accepted as the URL variant and
      // Playwright would fail with ERR_INVALID_URL. The URL variant is also
      // narrowed to require http(s):// so no other accidental string can
      // masquerade as an endpoint.
      attach_cdp: z.preprocess(
        (v) => (v === "true" ? true : v === "false" ? false : v),
        z.union([
          z.boolean(),
          z.string().regex(/^https?:\/\//i, "attach_cdp string must be an http(s) endpoint URL like http://localhost:9222"),
        ]),
      ).optional().describe(
        "Attach to a CDP-speaking browser instead of launching Playwright Chromium. Pass `true` to auto-launch " +
          "an isolated Chromium-channel browser (edge/chrome/brave/vivaldi/opera — selected via the " +
          "BROWSER_MCP_PRODUCT env var, default edge on Windows/WSL or chrome on macOS/Linux) using the " +
          "configured executable_path; or pass an http endpoint URL like \"http://localhost:9222\" to attach to " +
          "a user-managed browser. Chromium-only. Cannot record video. On WSL, auto-launch transparently spawns " +
          "a Windows-side TCP relay so the browser CDP endpoint is reachable across the WSL2 NAT.",
      ),
      auto_launch: z.preprocess(
        (v) => (v === "true" ? true : v === "false" ? false : v),
        z.boolean(),
      ).optional().describe(
        "Override config-default auto_launch behavior for this attach_cdp session. When true (and attach_cdp is " +
          "true), spawns a fresh isolated browser instance of the configured product. Ignored when attach_cdp " +
          "is a string endpoint.",
      ),
      executable_path: z.string().optional().describe(
        "Override config executable_path for attach_cdp auto-launch. Windows path on WSL.",
      ),
      user_data_dir: z.string().optional().describe(
        "Override config user_data_dir for attach_cdp auto-launch. Windows path on WSL. When omitted, an " +
          "isolated session-scoped temp profile is used.",
      ),
    },
    handler: async (p) => json(await sessionManager.open(p)),
  },

  close_session: {
    description:
      "Close a persistent session opened via open_session. Returns any video file paths produced while the session was open. " +
      "If the server exits while the session is still open, it's closed automatically on SIGINT/SIGTERM.",
    schema: {
      session_id: z.string().describe("Session id returned by open_session"),
    },
    handler: async (p) => json(await sessionManager.close(p.session_id)),
  },

  list_sessions: {
    description:
      "List all open persistent sessions with their tabs, TTLs, and next expiry timestamp. " +
      "Useful for cleaning up stragglers or seeing what's live.",
    schema: {},
    handler: async () => json(sessionManager.list()),
  },
};

// ---------------------------------------------------------------------------
// Navigation primitives
// ---------------------------------------------------------------------------

const waitUntilEnum = z
  .enum(["load", "domcontentloaded", "networkidle", "commit"])
  .optional()
  .describe('Lifecycle event to wait for (default: "load")');

export const navigationPrimitives: Record<string, PrimitiveDef> = {
  navigate: {
    description: "Navigate to a URL. Uses the session's active tab when session_id is provided, otherwise runs in a one-shot browser context.",
    schema: {
      url: z.string().describe("Absolute URL to navigate to"),
      wait_until: waitUntilEnum,
      timeout: z.number().optional().describe("Navigation timeout in ms (default: 30000)"),
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => {
      return withPage(p, async (page) => {
        const resp = await page.goto(p.url, {
          waitUntil: p.wait_until ?? "load",
          timeout: p.timeout ?? 30000,
        });
        return json({
          url: page.url(),
          status: resp?.status() ?? null,
          title: await page.title().catch(() => ""),
        });
      });
    },
  },

  go_back: {
    description: "Navigate back in the session's history. Requires session_id.",
    schema: {
      session_id: z.string().describe("Session id"),
      tab_id: z.string().optional(),
      wait_until: waitUntilEnum,
    },
    handler: async (p) => withPage(p, async (page) => {
      const resp = await page.goBack({ waitUntil: p.wait_until ?? "load" });
      return json({ url: page.url(), status: resp?.status() ?? null });
    }),
  },

  go_forward: {
    description: "Navigate forward in the session's history. Requires session_id.",
    schema: {
      session_id: z.string().describe("Session id"),
      tab_id: z.string().optional(),
      wait_until: waitUntilEnum,
    },
    handler: async (p) => withPage(p, async (page) => {
      const resp = await page.goForward({ waitUntil: p.wait_until ?? "load" });
      return json({ url: page.url(), status: resp?.status() ?? null });
    }),
  },

  reload: {
    description: "Reload the current page.",
    schema: {
      ...targetField,
      wait_until: waitUntilEnum,
    },
    handler: async (p) => withPage(p, async (page) => {
      const resp = await page.reload({ waitUntil: p.wait_until ?? "load" });
      return json({ url: page.url(), status: resp?.status() ?? null });
    }),
  },
};

// ---------------------------------------------------------------------------
// Interaction primitives
// ---------------------------------------------------------------------------

export const interactionPrimitives: Record<string, PrimitiveDef> = {
  click: {
    description: "Click an element. Use button and click_count for right-click, double-click, etc.",
    schema: {
      ...selectorField,
      button: z.enum(["left", "right", "middle"]).optional().describe('Mouse button (default: "left")'),
      click_count: z.number().optional().describe("Number of consecutive clicks (default: 1; set 2 for double-click)"),
      force: z.boolean().optional().describe("Skip actionability checks (visible, enabled, stable) and click immediately"),
      position: z.object({ x: z.number(), y: z.number() }).optional().describe("Offset from the element's top-left to click at (pixels)"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      await page.click(p.selector, {
        button: p.button,
        clickCount: p.click_count,
        force: p.force,
        position: p.position,
        timeout: p.timeout,
      });
      return ok(`Clicked ${p.selector}`);
    }),
  },

  type_text: {
    description: "Fill a text input or textarea. Clears the field first unless clear:false.",
    schema: {
      ...selectorField,
      text: z.string().describe("Text to type"),
      clear: z.boolean().optional().describe("Clear the field before typing (default: true)"),
      press_enter: z.boolean().optional().describe("Press Enter after typing (default: false)"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const clear = p.clear !== false;
      if (clear) {
        await page.fill(p.selector, p.text, { timeout: p.timeout });
      } else {
        await page.locator(p.selector).pressSequentially(p.text, { timeout: p.timeout });
      }
      if (p.press_enter) await page.press(p.selector, "Enter");
      return ok(`Typed ${p.text.length} chars into ${p.selector}`);
    }),
  },

  press_key: {
    description:
      "Press a keyboard key or key combo. Examples: \"Enter\", \"Tab\", \"Escape\", \"Control+A\", \"Shift+Tab\". " +
      "Targets a specific element when selector is provided, otherwise fires on the currently-focused element.",
    schema: {
      key: z.string().describe("Key or combo (e.g. \"Enter\", \"Control+A\", \"ArrowDown\")"),
      selector: z.string().optional().describe("Element to focus before the key press"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      if (p.selector) {
        await page.press(p.selector, p.key, { timeout: p.timeout });
      } else {
        await page.keyboard.press(p.key);
      }
      return ok(`Pressed ${p.key}`);
    }),
  },

  hover: {
    description: "Hover over an element.",
    schema: {
      ...selectorField,
      force: z.boolean().optional().describe("Skip actionability checks"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      await page.hover(p.selector, { force: p.force, timeout: p.timeout });
      return ok(`Hovered ${p.selector}`);
    }),
  },

  scroll: {
    description:
      "Scroll the page. Provide selector to scroll an element into view, or x/y deltas to scroll the window by pixels, or to:\"top\"|\"bottom\" to jump.",
    schema: {
      selector: z.string().optional().describe("Scroll this element into view"),
      to: z.enum(["top", "bottom"]).optional().describe('Jump to "top" or "bottom" of the page'),
      x: z.number().optional().describe("Horizontal scroll delta in pixels"),
      y: z.number().optional().describe("Vertical scroll delta in pixels"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      if (p.selector) {
        await page.locator(p.selector).scrollIntoViewIfNeeded({ timeout: p.timeout });
        return ok(`Scrolled ${p.selector} into view`);
      }
      if (p.to === "top") {
        await page.evaluate(() => window.scrollTo(0, 0));
        return ok("Scrolled to top");
      }
      if (p.to === "bottom") {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        return ok("Scrolled to bottom");
      }
      const dx = p.x ?? 0;
      const dy = p.y ?? 0;
      await page.evaluate(([x, y]) => window.scrollBy(x as number, y as number), [dx, dy]);
      return ok(`Scrolled by x=${dx}, y=${dy}`);
    }),
  },

  drag: {
    description: "Drag one element onto another. Both selectors are required.",
    schema: {
      from_selector: z.string().describe("Element to drag from"),
      to_selector: z.string().describe("Element to drop onto"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      await page.dragAndDrop(p.from_selector, p.to_selector, { timeout: p.timeout });
      return ok(`Dragged ${p.from_selector} → ${p.to_selector}`);
    }),
  },

  select_option: {
    description: "Select an option in a <select> dropdown by value, label, or index.",
    schema: {
      ...selectorField,
      value: z.string().optional().describe("Option value attribute"),
      label: z.string().optional().describe("Option visible label"),
      index: z.number().optional().describe("0-based option index"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const opts: any = {};
      if (p.value !== undefined) opts.value = p.value;
      if (p.label !== undefined) opts.label = p.label;
      if (p.index !== undefined) opts.index = p.index;
      const picked = await page.selectOption(p.selector, opts, { timeout: p.timeout });
      return json({ selected: picked });
    }),
  },

  check: {
    description: "Check a checkbox or radio button. No-op if already checked.",
    schema: { ...selectorField, ...timeoutField, ...targetField, ...useSchemaField },
    handler: async (p) => withPage(p, async (page) => {
      await page.check(p.selector, { timeout: p.timeout });
      return ok(`Checked ${p.selector}`);
    }),
  },

  uncheck: {
    description: "Uncheck a checkbox. No-op if already unchecked.",
    schema: { ...selectorField, ...timeoutField, ...targetField, ...useSchemaField },
    handler: async (p) => withPage(p, async (page) => {
      await page.uncheck(p.selector, { timeout: p.timeout });
      return ok(`Unchecked ${p.selector}`);
    }),
  },

  upload_file: {
    description: "Set files on a file input. Accepts one or more absolute paths.",
    schema: {
      ...selectorField,
      paths: z.array(z.string()).describe("Absolute paths to the files to upload"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      await page.setInputFiles(p.selector, p.paths, { timeout: p.timeout });
      return ok(`Uploaded ${p.paths.length} file(s) to ${p.selector}`);
    }),
  },
};

// ---------------------------------------------------------------------------
// Wait primitives
// ---------------------------------------------------------------------------

export const waitPrimitives: Record<string, PrimitiveDef> = {
  wait_for_selector: {
    description: "Wait for an element to reach a given visibility state.",
    schema: {
      ...selectorField,
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional().describe('Target state (default: "visible")'),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      await page.waitForSelector(p.selector, { state: p.state, timeout: p.timeout });
      return ok(`Selector ${p.selector} reached state ${p.state ?? "visible"}`);
    }),
  },

  wait_for_url: {
    description: "Wait until the page URL matches the given pattern. Pattern can be a substring or a regex literal.",
    schema: {
      url_pattern: z.string().describe("Substring or /regex/flags the URL must match"),
      ...timeoutField,
      session_id: z.string().describe("Session id (waits against the session's active page)"),
      tab_id: z.string().optional(),
    },
    handler: async (p) => withPage(p, async (page) => {
      const match = p.url_pattern.match(/^\/(.*)\/([gimsuy]*)$/);
      const matcher: string | RegExp = match ? new RegExp(match[1], match[2]) : p.url_pattern;
      await page.waitForURL(matcher as any, { timeout: p.timeout });
      return ok(`URL matched ${p.url_pattern} → ${page.url()}`);
    }),
  },

  wait_for_load_state: {
    description: "Wait for a page lifecycle event.",
    schema: {
      state: z.enum(["load", "domcontentloaded", "networkidle"]).describe("Event to wait for"),
      ...timeoutField,
      session_id: z.string().describe("Session id"),
      tab_id: z.string().optional(),
    },
    handler: async (p) => withPage(p, async (page) => {
      await page.waitForLoadState(p.state, { timeout: p.timeout });
      return ok(`Reached load state: ${p.state}`);
    }),
  },

  wait: {
    description: "Sleep for a given number of ms. Prefer wait_for_selector when you know what you're waiting on.",
    schema: {
      ms: z.number().describe("Duration in ms"),
    },
    handler: async (p) => {
      await new Promise((r) => setTimeout(r, p.ms));
      return ok(`Slept ${p.ms}ms`);
    },
  },
};

// ---------------------------------------------------------------------------
// Read primitives
// ---------------------------------------------------------------------------

export const readPrimitives: Record<string, PrimitiveDef> = {
  get_text: {
    description: "Return the visible text content of an element (or the whole page body when selector is omitted).",
    schema: {
      selector: z.string().optional().describe('CSS selector (default: "body")'),
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const sel = p.selector ?? "body";
      const text = await page.locator(sel).first().innerText();
      return ok(text);
    }),
  },

  get_attribute: {
    description: "Return the value of an attribute on an element. Returns null if the attribute is absent.",
    schema: {
      ...selectorField,
      attribute: z.string().describe("Attribute name (e.g. \"href\", \"data-id\")"),
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const val = await page.locator(p.selector).first().getAttribute(p.attribute);
      return json({ selector: p.selector, attribute: p.attribute, value: val });
    }),
  },

  get_html: {
    description: "Return the outerHTML of an element or the full <html> when selector is omitted.",
    schema: {
      selector: z.string().optional().describe('CSS selector (default: whole document)'),
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      if (p.selector) {
        const html = await page.locator(p.selector).first().evaluate((el) => el.outerHTML);
        return ok(html);
      }
      return ok(await page.content());
    }),
  },

  get_url: {
    description: "Return the current URL of a session's active (or named) tab.",
    schema: {
      session_id: z.string().describe("Session id"),
      tab_id: z.string().optional(),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const page = sessionManager.getPage(p.session_id, p.tab_id);
      return json({ url: page.url(), title: await page.title().catch(() => "") });
    },
  },
};

// ---------------------------------------------------------------------------
// Tab primitives (all require session_id)
// ---------------------------------------------------------------------------

export const tabPrimitives: Record<string, PrimitiveDef> = {
  open_tab: {
    description: "Open a new tab in an existing session and make it the active tab.",
    schema: {
      session_id: z.string().describe("Session id"),
      url: z.string().optional().describe("Initial URL to load in the new tab"),
      tab_id: z.string().optional().describe("Custom tab id (default: auto-assigned like \"tab2\", \"tab3\")"),
    },
    handler: async (p) => json(await sessionManager.addTab(p.session_id, p.tab_id, p.url)),
  },

  switch_tab: {
    description: "Make a given tab the active tab for subsequent primitives.",
    schema: {
      session_id: z.string().describe("Session id"),
      tab_id: z.string().describe("Target tab id"),
    },
    handler: async (p) => {
      await sessionManager.switchTab(p.session_id, p.tab_id);
      return ok(`Switched to tab ${p.tab_id}`);
    },
  },

  list_tabs: {
    description: "List all tabs in a session (url + which is active).",
    schema: { session_id: z.string().describe("Session id") },
    handler: async (p) => {
      const info = sessionManager.list().find((s) => s.session_id === p.session_id);
      if (!info) return err(`Session "${p.session_id}" not found.`);
      return json({ session_id: info.session_id, active_tab_id: info.active_tab_id, tabs: info.tabs });
    },
  },

  close_tab: {
    description: "Close a tab in a session. Can't close the last tab — close the session instead.",
    schema: {
      session_id: z.string().describe("Session id"),
      tab_id: z.string().describe("Tab id to close"),
    },
    handler: async (p) => {
      await sessionManager.closeTab(p.session_id, p.tab_id);
      return ok(`Closed tab ${p.tab_id}`);
    },
  },
};

// ---------------------------------------------------------------------------
// Cookies & storage (session-scoped)
// ---------------------------------------------------------------------------

export const cookiePrimitives: Record<string, PrimitiveDef> = {
  get_cookies: {
    description: "Return cookies from the session's context. Filter to a single URL to get only cookies sent to it.",
    schema: {
      session_id: z.string().describe("Session id"),
      url: z.string().optional().describe("Return only cookies that would be sent to this URL"),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const ctx = sessionManager.get(p.session_id).context;
      const cookies = p.url ? await ctx.cookies(p.url) : await ctx.cookies();
      return json(cookies);
    },
  },

  set_cookies: {
    description: "Add cookies to the session's context. Accepts Playwright's cookie shape.",
    schema: {
      session_id: z.string().describe("Session id"),
      cookies: z.array(z.object({
        name: z.string(),
        value: z.string(),
        url: z.string().optional(),
        domain: z.string().optional(),
        path: z.string().optional(),
        expires: z.number().optional(),
        httpOnly: z.boolean().optional(),
        secure: z.boolean().optional(),
        sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
      })),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      await sessionManager.get(p.session_id).context.addCookies(p.cookies as any);
      return ok(`Added ${p.cookies.length} cookie(s)`);
    },
  },

  clear_cookies: {
    description: "Clear all cookies in the session's context.",
    schema: { session_id: z.string().describe("Session id") },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      await sessionManager.get(p.session_id).context.clearCookies();
      return ok("Cleared cookies");
    },
  },

  get_storage: {
    description: "Return the contents of localStorage or sessionStorage on the active (or named) tab.",
    schema: {
      session_id: z.string().describe("Session id"),
      tab_id: z.string().optional(),
      area: z.enum(["local", "session"]).optional().describe('Storage area (default: "local")'),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const page = sessionManager.getPage(p.session_id, p.tab_id);
      const area = p.area ?? "local";
      const entries = await page.evaluate((a) => {
        const store = a === "local" ? window.localStorage : window.sessionStorage;
        const out: Record<string, string> = {};
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k !== null) out[k] = store.getItem(k) ?? "";
        }
        return out;
      }, area);
      return json(entries);
    },
  },

  set_storage: {
    description: "Set a key/value pair in localStorage or sessionStorage on the active (or named) tab.",
    schema: {
      session_id: z.string().describe("Session id"),
      tab_id: z.string().optional(),
      key: z.string().describe("Storage key"),
      value: z.string().describe("Storage value (string)"),
      area: z.enum(["local", "session"]).optional().describe('Storage area (default: "local")'),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const page = sessionManager.getPage(p.session_id, p.tab_id);
      const area = p.area ?? "local";
      await page.evaluate(
        ({ area: a, key, value }) => {
          const store = a === "local" ? window.localStorage : window.sessionStorage;
          store.setItem(key, value);
        },
        { area, key: p.key, value: p.value },
      );
      return ok(`Set ${area}Storage[${p.key}]`);
    },
  },

  clear_storage: {
    description: "Clear localStorage or sessionStorage on the active (or named) tab.",
    schema: {
      session_id: z.string().describe("Session id"),
      tab_id: z.string().optional(),
      area: z.enum(["local", "session"]).optional().describe('Storage area (default: "local")'),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const page = sessionManager.getPage(p.session_id, p.tab_id);
      const area = p.area ?? "local";
      await page.evaluate((a) => {
        const store = a === "local" ? window.localStorage : window.sessionStorage;
        store.clear();
      }, area);
      return ok(`Cleared ${area}Storage`);
    },
  },
};

// ---------------------------------------------------------------------------
// Capture primitives — session-aware screenshot + frame capture
// ---------------------------------------------------------------------------

export const capturePrimitives: Record<string, PrimitiveDef> = {
  capture: {
    description:
      "Take a PNG screenshot of a session's active (or named) tab. Optionally crop to an element by selector, " +
      "or capture the full scrollable page with full_page:true. For ephemeral multi-browser / multi-viewport captures use the `screenshot` tool instead.",
    schema: {
      session_id: z.string().describe("Session id (use open_session to create one, or use the `screenshot` tool for ephemeral captures)"),
      tab_id: z.string().optional(),
      selector: z.string().optional().describe("CSS selector to crop to. Omit for viewport/full-page capture"),
      full_page: z.boolean().optional().describe("Capture the full scrollable page (default: false)"),
      output_path: z.string().optional().describe("Relative or absolute path. Defaults to <output_dir>/capture-<timestamp>.png"),
      output_dir: z.string().optional().describe('Base directory when output_path is relative (default: ".browser")'),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const page = sessionManager.getPage(p.session_id, p.tab_id);
      const outputDir = p.output_dir ?? ".browser";
      const filePath = p.output_path
        ? (path.isAbsolute(p.output_path) ? p.output_path : path.join(outputDir, p.output_path))
        : path.join(outputDir, `capture-${Date.now()}.png`);
      await ensureOutput(filePath);
      const buf = p.selector
        ? await page.locator(p.selector).first().screenshot({ type: "png" })
        : await page.screenshot({ type: "png", fullPage: p.full_page === true });
      await fs.writeFile(filePath, buf);
      return json({ path: filePath, bytes: buf.byteLength, selector: p.selector ?? null });
    },
  },
};

// ---------------------------------------------------------------------------
// Save primitives (PDF, HTML)
// ---------------------------------------------------------------------------

async function ensureOutput(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export const savePrimitives: Record<string, PrimitiveDef> = {
  save_pdf: {
    description:
      "Save the current page as a PDF. Chromium only. The resulting file is written under output_dir.",
    schema: {
      output_path: z.string().optional().describe("Relative or absolute path. Defaults to <output_dir>/<session>-<timestamp>.pdf"),
      output_dir: z.string().optional().describe('Base directory when output_path is relative (default: ".browser")'),
      format: z.string().optional().describe('Paper format (e.g. "A4", "Letter"). Default: Letter'),
      landscape: z.boolean().optional(),
      print_background: z.boolean().optional().describe("Include CSS backgrounds (default: true)"),
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const outputDir = p.output_dir ?? ".browser";
      const filePath = p.output_path
        ? (path.isAbsolute(p.output_path) ? p.output_path : path.join(outputDir, p.output_path))
        : path.join(outputDir, `page-${Date.now()}.pdf`);
      await ensureOutput(filePath);
      try {
        await page.pdf({
          path: filePath,
          format: p.format ?? "Letter",
          landscape: p.landscape,
          printBackground: p.print_background !== false,
        });
      } catch (error) {
        return err(`save_pdf failed (Chromium only): ${(error as Error).message}`);
      }
      return json({ path: filePath });
    }),
  },

  save_html: {
    description: "Save the page's full HTML content to a file.",
    schema: {
      output_path: z.string().optional().describe("Relative or absolute path. Defaults to <output_dir>/<timestamp>.html"),
      output_dir: z.string().optional().describe('Base directory when output_path is relative (default: ".browser")'),
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const outputDir = p.output_dir ?? ".browser";
      const filePath = p.output_path
        ? (path.isAbsolute(p.output_path) ? p.output_path : path.join(outputDir, p.output_path))
        : path.join(outputDir, `page-${Date.now()}.html`);
      await ensureOutput(filePath);
      const html = await page.content();
      await fs.writeFile(filePath, html, "utf8");
      return json({ path: filePath, bytes: Buffer.byteLength(html) });
    }),
  },
};

// ---------------------------------------------------------------------------
// Dialog handling (session-only, pre-arms a handler for the next dialog)
// ---------------------------------------------------------------------------

export const dialogPrimitives: Record<string, PrimitiveDef> = {
  handle_next_dialog: {
    description:
      "Pre-arm a one-shot dialog handler for the session's active tab. The next native alert/confirm/prompt is auto-handled. " +
      "Call this before triggering the action that raises the dialog (e.g. before clicking a button that calls window.confirm).",
    schema: {
      session_id: z.string().describe("Session id"),
      tab_id: z.string().optional(),
      action: z.enum(["accept", "dismiss"]).describe("What to do with the dialog"),
      text: z.string().optional().describe("Text to type into a prompt() before accepting"),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const page = sessionManager.getPage(p.session_id, p.tab_id);
      page.once("dialog", async (dialog) => {
        try {
          if (p.action === "accept") {
            await dialog.accept(p.text);
          } else {
            await dialog.dismiss();
          }
        } catch {
          // ignore — the dialog may have auto-closed
        }
      });
      return ok(`Armed ${p.action} handler for next dialog on tab ${p.tab_id ?? "active"}`);
    },
  },
};

// ---------------------------------------------------------------------------
// Type + aggregator
// ---------------------------------------------------------------------------

export interface PrimitiveDef {
  description: string;
  schema: Record<string, unknown>;
  handler: (params: any) => Promise<any>;
}

export function allPrimitives(): Record<string, PrimitiveDef> {
  return {
    ...sessionPrimitives,
    ...navigationPrimitives,
    ...interactionPrimitives,
    ...waitPrimitives,
    ...readPrimitives,
    ...tabPrimitives,
    ...cookiePrimitives,
    ...capturePrimitives,
    ...savePrimitives,
    ...dialogPrimitives,
  };
}

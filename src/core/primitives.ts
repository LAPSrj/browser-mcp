import { z } from "zod";
import type { BrowserContext, Page } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import {
  launchSession,
  closeSession,
  pickBrowserStack,
  type BrowserName,
} from "../utils/browser.js";
import { sessionManager } from "./sessions.js";
import { useSchemaField, browserStackFields } from "../utils/schemas.js";
import { resolveLocator } from "../utils/locator.js";
import { diagnosePageErrors } from "../utils/page-diagnostics.js";

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
  browserStackOs?: string;
  browserStackOsVersion?: string;
  browserStackDevice?: string;
  browserStackLocal?: boolean;
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
    ...pickBrowserStack(params),
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
    .describe("open_session id. Omit for a one-shot ephemeral browser."),
  tab_id: z.string().optional().describe("Session tab (default: active)"),
  browser: z
    .enum(["chromium", "firefox", "webkit"])
    .optional()
    .describe('Ephemeral only (default "chromium")'),
  viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Ephemeral only (default 1280x720)"),
  useBrowserStack: z.boolean().optional().describe("Ephemeral only (default false)"),
  ...browserStackFields,
};

const selectorField = {
  selector: z.string().describe(
    "CSS (`#id`, `nav > a`), Playwright role (`role=button[name=\"Submit\"]`, preferred: survives class and layout changes), " +
    "text (`text=\"Save\"` exact, `text=Save` substring; breaks across locales), or `button:has-text(\"Save\")`. " +
    "Avoid build-hashed classes like `.css-1g2hf83`. " +
    "Pierce iframes, cross-origin too, with ` >>> `: `iframe[src*=\"chat\"] >>> #send` (nestable).",
  ),
};
const timeoutField = {
  timeout: z.number().optional().describe("ms (default 30000)"),
};
const downloadDirField = z.string().optional();
const DOWNLOAD_DIR_FORMS =
  "Linux path (absolute, relative, or ~/...); on WSL also C:\\... or \\\\wsl.localhost\\<distro>\\.... Created if missing.";

// ---------------------------------------------------------------------------
// Session lifecycle tools
// ---------------------------------------------------------------------------

export const sessionPrimitives: Record<string, PrimitiveDef> = {
  open_session: {
    description:
      "Open a persistent browser session; returns a session_id that other tools accept. " +
      "Closes after idle_ttl_ms without a tool call, at wall_ttl_ms, or when the server exits. " +
      "Default launches Playwright; attach_cdp drives a Chromium-channel browser (edge/chrome) instead, " +
      "with user_data_dir for a real profile; useBrowserStack runs it on BrowserStack.",
    schema: {
      browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe('Default "chromium"'),
      viewport: z.object({ width: z.number(), height: z.number() }).optional().describe("Default {width:1280,height:720}"),
      url: z.string().optional().describe("Initial URL"),
      user_agent: z.string().optional(),
      locale: z.string().optional().describe("e.g. \"en-US\""),
      timezone: z.string().optional().describe("IANA id, e.g. \"America/New_York\""),
      record_video: z.boolean().optional().describe(
        "Record webm to <output_dir>/videos/<session_id>/. Limits wall_ttl_ms to 10 min (default 2 min)",
      ),
      idle_ttl_ms: z.number().optional().describe("Close after this many ms without a tool call (default 300000)"),
      wall_ttl_ms: z.number().optional().describe(
        "Max lifetime in ms (default 1800000). No cap unless recording, so pass e.g. 86400000 for 24h. " +
          "Recording: default 120000, max 600000.",
      ),
      output_dir: z.string().optional(),
      headless: z.boolean().optional().describe(
        "false opens a visible window (for human captcha/login; on WSL it shows on the Windows desktop). Default true.",
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
        "true: auto-launch an isolated Chromium-channel browser (BROWSER_MCP_PRODUCT: edge/chrome/brave/vivaldi/opera; " +
          "default edge on Windows/WSL, chrome elsewhere). Or an http endpoint (\"http://localhost:9222\") to attach " +
          "to a browser you run. Chromium only, no video.",
      ),
      auto_launch: z.preprocess(
        (v) => (v === "true" ? true : v === "false" ? false : v),
        z.boolean(),
      ).optional().describe(
        "Override the configured auto_launch for attach_cdp:true (true spawns a fresh browser). Ignored with an endpoint URL.",
      ),
      executable_path: z.string().optional().describe(
        "Override the configured browser path for attach_cdp auto-launch (Windows path on WSL)",
      ),
      user_data_dir: z.string().optional().describe(
        "Profile dir for attach_cdp auto-launch (Windows path on WSL). Default: a temp profile per session.",
      ),
      restore_previous_tabs: z.preprocess(
        (v) => (v === "true" ? true : v === "false" ? false : v),
        z.boolean(),
      ).optional().describe(
        "attach_cdp only. Default false closes tabs the profile restores from its last run, leaving one page. true keeps them.",
      ),
      ignore_https_errors: z.preprocess(
        (v) => (v === "true" ? true : v === "false" ? false : v),
        z.boolean(),
      ).optional().describe(
        "Accept invalid TLS certs, e.g. self-signed local dev (default false; otherwise the page shows a browser error)",
      ),
      download_dir: downloadDirField.describe(
        "Downloads folder. " + DOWNLOAD_DIR_FORMS +
          " Default: the browser's own Downloads setting for attach_cdp, <output_dir>/downloads otherwise.",
      ),
      useBrowserStack: z.preprocess(
        (v) => (v === "true" ? true : v === "false" ? false : v),
        z.boolean(),
      ).optional().describe(
        "Run on BrowserStack. Not with attach_cdp, no video. BrowserStack closes the session after 5 min " +
          "without a tool call. Needs BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY.",
      ),
      ...browserStackFields,
    },
    handler: async (p) => json(await sessionManager.open(p)),
  },

  close_session: {
    description:
      "Close a session; returns any video paths. On a shared attach_cdp browser, the browser stays up until the last attached server closes.",
    schema: {
      session_id: z.string(),
    },
    handler: async (p) => json(await sessionManager.close(p.session_id)),
  },

  close_browser: {
    description:
      "Kill an attach_cdp browser process tree. Refuses while other browser-mcp servers are attached unless force:true. " +
      "For recovery from a stuck browser; use close_session normally.",
    schema: {
      session_id: z.string().describe("Any attach_cdp session on that browser"),
      force: z.preprocess(
        (v) => (v === "true" ? true : v === "false" ? false : v),
        z.boolean(),
      ).optional().describe(
        "Kill even with other servers attached; their sessions disconnect on their next call.",
      ),
    },
    handler: async (p) => json(await sessionManager.closeBrowser(p.session_id, p.force)),
  },

  browser_status: {
    description:
      "Read-only state of a shared attach_cdp browser, for debugging multi-agent setups: ports, root pid, attached sessions, " +
      "how this server attached (spawn/existing), own and orphan tab counts, peer count. Other sessions get is_attach_cdp:false + own_tabs_count.",
    schema: {
      session_id: z.string(),
    },
    handler: async (p) => json(await sessionManager.browserStatus(p.session_id)),
  },

  claim_tab: {
    description:
      "Take ownership of an unowned tab in the shared browser (e.g. a rel=\"noopener\" popup, or a tab open before attach). " +
      "Errors if no unowned page's URL matches.",
    schema: {
      session_id: z.string().describe("Session that will own the tab"),
      url_pattern: z.string().describe("Substring, or `/regex/flags` (e.g. `/checkout-[0-9]+/i`)"),
      target_index: z.number().optional().describe("Pick the Nth match, 0-based (default 0)"),
    },
    handler: async (p) => json(await sessionManager.claimTab(p)),
  },

  list_sessions: {
    description:
      "List open sessions with their tabs, TTLs, and next expiry.",
    schema: {},
    handler: async () => json(sessionManager.list()),
  },

  pause_session: {
    description:
      "Save a session's cookies, localStorage, sessionStorage, and active-tab URL as a `snapshot`, then close it. " +
      "Pass the snapshot to resume_session later (e.g. after a human solves a captcha). Not for attach_cdp sessions. " +
      "Lost: in-page JS state, scroll, unsaved form input, other tabs.",
    schema: {
      session_id: z.string(),
    },
    handler: async (p) => json(await sessionManager.pauseSession(p.session_id)),
  },

  resume_session: {
    description:
      "Reopen a pause_session snapshot as a NEW session_id with the saved storage, navigated to the saved URL. " +
      "Browser engine comes from the snapshot.",
    schema: {
      snapshot: z.object({
        storage_state: z.any(),
        url: z.string(),
        viewport: z.object({ width: z.number(), height: z.number() }),
        user_agent: z.string().optional(),
        locale: z.string().optional(),
        timezone: z.string().optional(),
        browser: z.enum(["chromium", "firefox", "webkit"]),
        paused_at: z.string(),
      }).describe("pause_session's snapshot, unchanged"),
      headless: z.boolean().optional(),
      idle_ttl_ms: z.number().optional(),
      wall_ttl_ms: z.number().optional(),
      output_dir: z.string().optional().describe('Downloads go to <output_dir>/downloads (default ".browser")'),
    },
    handler: async (p) => json(await sessionManager.resumeSession(p)),
  },
};

// ---------------------------------------------------------------------------
// Navigation primitives
// ---------------------------------------------------------------------------

const waitUntilEnum = z
  .enum(["load", "domcontentloaded", "networkidle", "commit"])
  .optional()
  .describe('Default "load"');

export const navigationPrimitives: Record<string, PrimitiveDef> = {
  navigate: {
    description: "Navigate to a URL; returns url, status, title. Errors with diagnostics if the page can't load (TLS, DNS, refused, HTTP 5xx).",
    schema: {
      url: z.string().describe("Absolute URL"),
      wait_until: waitUntilEnum,
      timeout: z.number().optional().describe("ms (default 30000)"),
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => {
      return withPage(p, async (page) => {
        let status: number | null = null;
        let gotoError: string | undefined;

        try {
          const resp = await page.goto(p.url, {
            waitUntil: p.wait_until ?? "load",
            timeout: p.timeout ?? 30000,
          });
          status = resp?.status() ?? null;
        } catch (error) {
          gotoError = (error as Error).message;
        }

        const diagnostic = await diagnosePageErrors(page, status);
        const title = await page.title().catch(() => "");
        const result: Record<string, unknown> = {
          url: page.url(),
          status,
          title,
        };

        if (diagnostic) {
          result.error = diagnostic.message;
          if (diagnostic.errorCode) result.error_code = diagnostic.errorCode;
        } else if (gotoError) {
          result.error = gotoError;
        }

        if (diagnostic && diagnostic.type === "browser-error") {
          return err(JSON.stringify(result, null, 2));
        }

        return json(result);
      });
    },
  },

  go_back: {
    description: "Go back in the session's history.",
    schema: {
      session_id: z.string(),
      tab_id: z.string().optional(),
      wait_until: waitUntilEnum,
    },
    handler: async (p) => withPage(p, async (page) => {
      const resp = await page.goBack({ waitUntil: p.wait_until ?? "load" });
      return json({ url: page.url(), status: resp?.status() ?? null });
    }),
  },

  go_forward: {
    description: "Go forward in the session's history.",
    schema: {
      session_id: z.string(),
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
    description:
      "Click an element. Returns its tag, role, href, and form action, plus any navigation (new URL, title, page error) " +
      "or a warning for a disabled element.",
    schema: {
      ...selectorField,
      button: z.enum(["left", "right", "middle"]).optional().describe('Default "left"'),
      click_count: z.number().optional().describe("Default 1; 2 = double-click"),
      force: z.boolean().optional().describe(
        "Skip actionability checks (visible, enabled, stable). Doesn't prove a real user can reach it; use hit_test for that.",
      ),
      position: z.object({ x: z.number(), y: z.number() }).optional().describe("px offset from the element's top-left"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const locator = resolveLocator(page, p.selector);

      const elementInfo = await locator.first().evaluate((el) => {
        const he = el as HTMLElement;
        const tag = el.tagName.toLowerCase();
        const result: Record<string, unknown> = { tag };

        if (he.hasAttribute("disabled") || he.getAttribute("aria-disabled") === "true") {
          result.disabled = true;
        }

        const type = el.getAttribute("type");
        if (type) result.type = type;

        const role = el.getAttribute("role");
        if (role) result.role = role;

        const anchor = el.tagName === "A" ? (el as HTMLAnchorElement) : (el.closest("a") as HTMLAnchorElement | null);
        if (anchor?.href) result.href = anchor.href;

        const form = el.closest("form") as HTMLFormElement | null;
        const isSubmit =
          (tag === "button" && (type ?? "submit") === "submit") ||
          (tag === "input" && type === "submit");
        if (isSubmit && form) {
          result.form_action = form.action;
          result.form_method = (form.method || "GET").toUpperCase();
        }

        return result;
      }).catch(() => null);

      const urlBefore = page.url();

      await locator.click({
        button: p.button,
        clickCount: p.click_count,
        force: p.force,
        position: p.position,
        timeout: p.timeout,
      });

      const urlAfter = page.url();
      const navigated = urlAfter !== urlBefore;

      const result: Record<string, unknown> = { selector: p.selector };

      if (elementInfo) result.element = elementInfo;

      if (p.force) {
        result.force_used = true;
        if (elementInfo?.disabled) {
          result.warning =
            "force:true clicked a disabled element — a real user cannot interact with disabled elements. Use hit_test to verify reachability.";
        }
      }

      if (navigated) {
        const title = await page.title().catch(() => "");
        result.navigated_to = { url: urlAfter, title };
        const diagnostic = await diagnosePageErrors(page, null);
        if (diagnostic) {
          result.page_error = diagnostic.message;
        }
      } else {
        result.page_url = urlAfter;
      }

      return json(result);
    }),
  },

  type_text: {
    description: "Fill a text input or textarea.",
    schema: {
      ...selectorField,
      text: z.string(),
      clear: z.boolean().optional().describe("Replace the value (default true); false types key by key without clearing"),
      press_enter: z.boolean().optional().describe("Default false"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const target = resolveLocator(page, p.selector);
      const clear = p.clear !== false;
      if (clear) {
        await target.fill(p.text, { timeout: p.timeout });
      } else {
        await target.pressSequentially(p.text, { timeout: p.timeout });
      }
      if (p.press_enter) await target.press("Enter");
      return ok(`Typed ${p.text.length} chars into ${p.selector}`);
    }),
  },

  press_key: {
    description:
      "Press a key or combo on the focused element, or on selector if given.",
    schema: {
      key: z.string().describe("e.g. \"Enter\", \"Escape\", \"Control+A\", \"Shift+Tab\", \"ArrowDown\""),
      selector: z.string().optional(),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      if (p.selector) {
        await resolveLocator(page, p.selector).press(p.key, { timeout: p.timeout });
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
      await resolveLocator(page, p.selector).hover({ force: p.force, timeout: p.timeout });
      return ok(`Hovered ${p.selector}`);
    }),
  },

  scroll: {
    description:
      "Scroll the page: selector into view, to top/bottom, or by x/y pixels.",
    schema: {
      selector: z.string().optional().describe("Scroll this element into view"),
      to: z.enum(["top", "bottom"]).optional(),
      x: z.number().optional().describe("Horizontal delta, px"),
      y: z.number().optional().describe("Vertical delta, px"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      if (p.selector) {
        await resolveLocator(page, p.selector).scrollIntoViewIfNeeded({ timeout: p.timeout });
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
    description: "Drag one element onto another.",
    schema: {
      from_selector: z.string(),
      to_selector: z.string(),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const from = resolveLocator(page, p.from_selector);
      const to = resolveLocator(page, p.to_selector);
      await from.dragTo(to, { timeout: p.timeout });
      return ok(`Dragged ${p.from_selector} → ${p.to_selector}`);
    }),
  },

  select_option: {
    description: "Select an option in a <select> dropdown by value, label, or index.",
    schema: {
      ...selectorField,
      value: z.string().optional().describe("Option value attribute"),
      label: z.string().optional().describe("Visible label"),
      index: z.number().optional().describe("0-based"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const opts: any = {};
      if (p.value !== undefined) opts.value = p.value;
      if (p.label !== undefined) opts.label = p.label;
      if (p.index !== undefined) opts.index = p.index;
      const picked = await resolveLocator(page, p.selector).selectOption(opts, { timeout: p.timeout });
      return json({ selected: picked });
    }),
  },

  check: {
    description: "Check a checkbox or radio button. No-op if already checked.",
    schema: { ...selectorField, ...timeoutField, ...targetField, ...useSchemaField },
    handler: async (p) => withPage(p, async (page) => {
      await resolveLocator(page, p.selector).check({ timeout: p.timeout });
      return ok(`Checked ${p.selector}`);
    }),
  },

  uncheck: {
    description: "Uncheck a checkbox. No-op if already unchecked.",
    schema: { ...selectorField, ...timeoutField, ...targetField, ...useSchemaField },
    handler: async (p) => withPage(p, async (page) => {
      await resolveLocator(page, p.selector).uncheck({ timeout: p.timeout });
      return ok(`Unchecked ${p.selector}`);
    }),
  },

  upload_file: {
    description: "Set files directly on an <input type=file> (no click, no file chooser). Works on real iOS devices.",
    schema: {
      ...selectorField,
      paths: z.array(z.string()).describe("Absolute file paths"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      await resolveLocator(page, p.selector).setInputFiles(p.paths, { timeout: p.timeout });
      return ok(`Uploaded ${p.paths.length} file(s) to ${p.selector}`);
    }),
  },

  click_to_upload: {
    description:
      "Upload via a real click that opens the native file chooser, then set the files on it. " +
      "Use when a button or label opens the picker (hidden/synthetic input, e.g. plupload) or the site needs a user-activated click; " +
      "upload_file never clicks. Desktop browsers only: fails on real iOS devices (use upload_file there).",
    schema: {
      trigger_selector: z.string().describe(
        "Element to click to open the chooser, usually the visible Upload button or label",
      ),
      paths: z.array(z.string()).describe("Absolute file paths"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => {
      // Fast-fail on real BrowserStack devices: real iOS Safari never surfaces
      // a file-chooser event to automation (the iOS picker is native OS UI),
      // so this would just time out after `timeout` ms. Tell the caller now.
      if (p.session_id && sessionManager.isBrowserStackRealDevice(p.session_id)) {
        return err(
          "click_to_upload can't open a file chooser on a real BrowserStack device (real iOS Safari surfaces no file-chooser event to automation — the picker is native OS UI). " +
            "Use upload_file to inject the file directly, hit_test to verify the control is tappable, or perform a manual tap in BrowserStack Live.",
        );
      }
      return withPage(p, async (page) => {
        const timeout = p.timeout ?? 30000;
        // Arm the chooser listener and click in one shot — the Playwright-
        // recommended idiom that avoids the race where the chooser opens
        // before the listener is attached.
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout }),
          resolveLocator(page, p.trigger_selector).click({ timeout }),
        ]);
        await chooser.setFiles(p.paths, { timeout });
        return ok(
          `Opened file chooser via ${p.trigger_selector} and set ${p.paths.length} file(s)` +
            (chooser.isMultiple() ? " (chooser accepts multiple)" : ""),
        );
      });
    },
  },

  drop_to_upload: {
    description:
      "Upload by dispatching dragenter/dragover/drop with real File objects on a dropzone (dropzone.js, react-dropzone). " +
      "Use when there is no input for upload_file and no chooser button for click_to_upload. Desktop only; on real mobile devices use upload_file.",
    schema: {
      target_selector: z.string().describe("Dropzone element"),
      paths: z.array(z.string()).describe("Absolute file paths"),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const timeout = p.timeout ?? 30000;
      // Read files host-side and pass name+mime+base64 into the page, where we
      // reconstruct File objects (the page can't read the local filesystem).
      const files = await Promise.all(
        (p.paths as string[]).map(async (pth) => ({
          name: path.basename(pth),
          mime: guessMimeType(pth),
          b64: (await fs.readFile(pth)).toString("base64"),
        })),
      );
      await resolveLocator(page, p.target_selector).evaluate(
        (el: Element, payload: Array<{ name: string; mime: string; b64: string }>) => {
          const dt = new DataTransfer();
          for (const f of payload) {
            const bin = atob(f.b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            dt.items.add(new File([arr], f.name, { type: f.mime }));
          }
          const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt } as DragEventInit;
          el.dispatchEvent(new DragEvent("dragenter", opts));
          el.dispatchEvent(new DragEvent("dragover", opts));
          el.dispatchEvent(new DragEvent("drop", opts));
        },
        files,
        { timeout },
      );
      return ok(`Dropped ${files.length} file(s) onto ${p.target_selector}`);
    }),
  },
};

// Minimal extension→MIME map for drop_to_upload. Dropzones usually only read
// file.name/.size, but a correct type avoids accept-filter rejections.
function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
    ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
    ".zip": "application/zip", ".mp4": "video/mp4", ".webm": "video/webm",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Wait primitives
// ---------------------------------------------------------------------------

export const waitPrimitives: Record<string, PrimitiveDef> = {
  wait_for_selector: {
    description: "Wait for an element to reach a given visibility state.",
    schema: {
      ...selectorField,
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional().describe('Default "visible"'),
      ...timeoutField,
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      await resolveLocator(page, p.selector).waitFor({ state: p.state, timeout: p.timeout });
      return ok(`Selector ${p.selector} reached state ${p.state ?? "visible"}`);
    }),
  },

  wait_for_url: {
    description: "Wait until the session page's URL matches a pattern.",
    schema: {
      url_pattern: z.string().describe("Substring or /regex/flags"),
      ...timeoutField,
      session_id: z.string(),
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
      state: z.enum(["load", "domcontentloaded", "networkidle"]),
      ...timeoutField,
      session_id: z.string(),
      tab_id: z.string().optional(),
    },
    handler: async (p) => withPage(p, async (page) => {
      await page.waitForLoadState(p.state, { timeout: p.timeout });
      return ok(`Reached load state: ${p.state}`);
    }),
  },

  wait: {
    description: "Sleep. Prefer wait_for_selector when you know what to wait for.",
    schema: {
      ms: z.number(),
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
    description: "Return the visible text (innerText) of the first match, or the page body.",
    schema: {
      selector: z.string().optional().describe('Same syntax as click (default "body")'),
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const sel = p.selector ?? "body";
      const text = await resolveLocator(page, sel).first().innerText();
      return ok(text);
    }),
  },

  get_attribute: {
    description: "Return an attribute's value on the first match, or null if absent.",
    schema: {
      ...selectorField,
      attribute: z.string(),
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      const val = await resolveLocator(page, p.selector).first().getAttribute(p.attribute);
      return json({ selector: p.selector, attribute: p.attribute, value: val });
    }),
  },

  get_html: {
    description: "Return an element's outerHTML, or the whole document without selector.",
    schema: {
      selector: z.string().optional().describe("Same syntax as click"),
      ...targetField,
      ...useSchemaField,
    },
    handler: async (p) => withPage(p, async (page) => {
      if (p.selector) {
        const html = await resolveLocator(page, p.selector).first().evaluate((el) => el.outerHTML);
        return ok(html);
      }
      return ok(await page.content());
    }),
  },

  get_url: {
    description: "Return a session tab's current URL and title.",
    schema: {
      session_id: z.string(),
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
    description: "Open a tab in a session and make it active.",
    schema: {
      session_id: z.string(),
      url: z.string().optional(),
      tab_id: z.string().optional().describe("Custom id (default \"tab2\", \"tab3\", ...)"),
    },
    handler: async (p) => json(await sessionManager.addTab(p.session_id, p.tab_id, p.url)),
  },

  switch_tab: {
    description: "Make a tab the session's active tab for later calls.",
    schema: {
      session_id: z.string(),
      tab_id: z.string(),
    },
    handler: async (p) => {
      await sessionManager.switchTab(p.session_id, p.tab_id);
      return ok(`Switched to tab ${p.tab_id}`);
    },
  },

  list_tabs: {
    description:
      "List a session's tabs (url, active). Each has owner \"self\" (with a tab_id) or \"orphan\" " +
      "(no tab_id; claim_tab it first).",
    schema: {
      session_id: z.string(),
      include_other_agents: z.preprocess(
        (v) => (v === "true" ? true : v === "false" ? false : v),
        z.boolean(),
      ).optional().describe(
        "Also list pages in the shared browser that this server doesn't own, as orphans (default false)",
      ),
    },
    handler: async (p) => {
      const info = sessionManager.list().find((s) => s.session_id === p.session_id);
      if (!info) return err(`Session "${p.session_id}" not found.`);
      const own = info.tabs.map((t) => ({ ...t, owner: "self" as const }));
      if (!p.include_other_agents) {
        return json({ session_id: info.session_id, active_tab_id: info.active_tab_id, tabs: own });
      }
      // Surface unowned pages from the shared context.
      const session = sessionManager.get(p.session_id);
      const ourPages = new Set<unknown>();
      for (const sx of sessionManager.list()) {
        const live = sessionManager.get(sx.session_id);
        if (live.context === session.context) {
          for (const pg of live.pages.values()) ourPages.add(pg);
        }
      }
      const allPages = session.context.pages();
      const orphans = allPages
        .filter((pg) => !ourPages.has(pg))
        .map((pg) => ({
          tab_id: null as string | null,
          url: pg.url(),
          active: false,
          owner: "orphan" as const,
        }));
      return json({
        session_id: info.session_id,
        active_tab_id: info.active_tab_id,
        tabs: [...own, ...orphans],
      });
    },
  },

  close_tab: {
    description: "Close a session tab. The last tab can't be closed; close the session instead.",
    schema: {
      session_id: z.string(),
      tab_id: z.string(),
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
    description: "Return the session's cookies.",
    schema: {
      session_id: z.string(),
      url: z.string().optional().describe("Only cookies sent to this URL"),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const ctx = sessionManager.get(p.session_id).context;
      const cookies = p.url ? await ctx.cookies(p.url) : await ctx.cookies();
      return json(cookies);
    },
  },

  set_cookies: {
    description: "Add cookies to the session (Playwright cookie shape).",
    schema: {
      session_id: z.string(),
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
    description: "Clear all of the session's cookies.",
    schema: { session_id: z.string() },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      await sessionManager.get(p.session_id).context.clearCookies();
      return ok("Cleared cookies");
    },
  },

  get_storage: {
    description: "Return localStorage or sessionStorage of a session tab.",
    schema: {
      session_id: z.string(),
      tab_id: z.string().optional(),
      area: z.enum(["local", "session"]).optional().describe('Default "local"'),
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
    description: "Set a key in localStorage or sessionStorage of a session tab.",
    schema: {
      session_id: z.string(),
      tab_id: z.string().optional(),
      key: z.string(),
      value: z.string(),
      area: z.enum(["local", "session"]).optional().describe('Default "local"'),
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
    description: "Clear localStorage or sessionStorage of a session tab.",
    schema: {
      session_id: z.string(),
      tab_id: z.string().optional(),
      area: z.enum(["local", "session"]).optional().describe('Default "local"'),
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
  screenshot: {
    description:
      "PNG screenshot of a session tab (viewport, full page, or one element); writes a file and returns its path, url, title. " +
      "Without a session use multi_screenshot or element_screenshot.",
    schema: {
      session_id: z.string(),
      tab_id: z.string().optional(),
      selector: z.string().optional().describe("Crop to this element (same syntax as click)"),
      full_page: z.boolean().optional().describe("Default false"),
      output_path: z.string().optional().describe("Default <output_dir>/capture-<timestamp>.png"),
      output_dir: z.string().optional().describe('Base for a relative output_path (default ".browser")'),
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
        ? await resolveLocator(page, p.selector).first().screenshot({ type: "png" })
        : await page.screenshot({ type: "png", fullPage: p.full_page === true });
      await fs.writeFile(filePath, buf);
      return json({
        path: filePath,
        bytes: buf.byteLength,
        selector: p.selector ?? null,
        url: page.url(),
        title: await page.title().catch(() => ""),
      });
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
      "Save the page as a PDF file; returns its path. Chromium only.",
    schema: {
      output_path: z.string().optional().describe("Default <output_dir>/page-<timestamp>.pdf"),
      output_dir: z.string().optional().describe('Base for a relative output_path (default ".browser")'),
      format: z.string().optional().describe('Paper format, e.g. "A4" (default "Letter")'),
      landscape: z.boolean().optional(),
      print_background: z.boolean().optional().describe("Default true"),
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
    description: "Save the page's full HTML to a file; returns path and bytes. To read HTML inline use get_html.",
    schema: {
      output_path: z.string().optional().describe("Default <output_dir>/page-<timestamp>.html"),
      output_dir: z.string().optional().describe('Base for a relative output_path (default ".browser")'),
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
      "Handle the next native alert/confirm/prompt on a session tab, once. Call before the action that opens the dialog.",
    schema: {
      session_id: z.string(),
      tab_id: z.string().optional(),
      action: z.enum(["accept", "dismiss"]),
      text: z.string().optional().describe("Text for a prompt() when accepting"),
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
// Downloads (session-only)
// ---------------------------------------------------------------------------

export const downloadPrimitives: Record<string, PrimitiveDef> = {
  wait_for_download: {
    description:
      "Wait for a session download to finish and return where it was saved. Returns the oldest download not yet returned " +
      "(an already finished one comes back at once), so call it after the click that starts it. `path` is openable by this " +
      "server (on WSL, C:\\... becomes /mnt/c/...; original in `browser_path`). Still running at timeout: state \"in_progress\", " +
      "and the next call waits again. If an attach_cdp profile asks where to save, the download waits on its Save dialog.",
    schema: {
      session_id: z.string(),
      timeout: z.number().optional().describe(
        "Max ms (default 30000). Keep under BROWSER_MCP_TOOL_TIMEOUT (default 90000).",
      ),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const timeout = p.timeout ?? 30000;
      const d = await sessionManager.getDownloads(p.session_id).waitNext(timeout);
      sessionManager.touch(p.session_id);
      if (!d) return err(`No download started within ${timeout}ms.`);
      return d.state === "failed" ? err(JSON.stringify(d, null, 2)) : json(d);
    },
  },

  list_downloads: {
    description:
      "List the session's downloads (newest last) with state, path, size, plus download_dir (null = the browser's own folder).",
    schema: {
      session_id: z.string(),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const tracker = sessionManager.getDownloads(p.session_id);
      return json({ download_dir: tracker.downloadDir(), downloads: tracker.list() });
    },
  },

  set_download_dir: {
    description:
      "Set the session's downloads folder for downloads started after this call (attach_cdp: saved by the browser, then moved here).",
    schema: {
      session_id: z.string(),
      path: downloadDirField.describe(`${DOWNLOAD_DIR_FORMS} Omit to restore the default.`),
    },
    handler: async (p) => {
      sessionManager.touch(p.session_id);
      const dir = await sessionManager.getDownloads(p.session_id).setDir(p.path);
      return json({ download_dir: dir });
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
    ...downloadPrimitives,
  };
}

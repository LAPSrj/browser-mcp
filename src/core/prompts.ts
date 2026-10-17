import type { Browser, CDPSession, Dialog, Frame, Page } from "playwright";

// Holds every prompt a session's pages open until the agent answers it, so an
// unattended run never has a prompt answered for it or left hanging unseen.
//
// Three kinds:
// - dialog: alert / confirm / prompt / beforeunload. Without a listener,
//   Playwright dismisses them on its own (confirm() returns false). While one
//   is held, click, screenshot and evaluate on that tab hang until it's
//   answered (verified live), so page tools on that tab fail fast instead.
// - permission: camera, microphone, geolocation, notifications, clipboard
//   read, MIDI, local fonts, window management, idle detection, storage
//   access. CDP has no event for a permission prompt (checked against the
//   Chrome 145 protocol), so an init script wraps the APIs that ask, reports
//   the request through a binding, and waits. Accepting grants the
//   permission to the origin with Browser.setPermission and then runs the
//   real call; dismissing rejects only that call. Neither is saved in the
//   profile: a later session on the same Edge profile asks again (verified
//   live).
// - http_auth: Basic/Digest/NTLM challenges. Fetch.authRequired holds the
//   request (and the navigation waiting on it) until the agent gives
//   credentials or cancels. Only document requests are intercepted: Chrome
//   rejects handleAuthRequests with no patterns, and documents are where a
//   login challenge shows a browser dialog.
//
// Permissions and HTTP logins need CDP, so they're tracked on Chromium
// sessions only; dialogs are tracked on every engine.

export type PromptKind = "dialog" | "permission" | "http_auth";
export type PromptAction = "accept" | "dismiss";

export interface PromptInfo {
  prompt_id: string;
  kind: PromptKind;
  /** Session tab the prompt is on; null when the tab isn't tracked yet (e.g. a popup still being claimed). */
  tab_id: string | null;
  /** Page URL for a dialog, requesting origin for a permission, request URL for an HTTP login. */
  url: string;
  opened_at: string;
  dialog_type?: string;
  message?: string;
  default_value?: string;
  permissions?: string[];
  realm?: string;
  scheme?: string;
  /** "Server" or "Proxy". */
  source?: string;
  /** True when the server rejected the credentials last given for this request. */
  credentials_rejected?: boolean;
}

export interface PromptAnswer {
  action: PromptAction;
  /** Text for a prompt() dialog when accepting. */
  text?: string;
  username?: string;
  password?: string;
}

type PermissionVerdict = "granted" | "denied" | "pass";

interface Pending {
  info: Omit<PromptInfo, "tab_id">;
  page: Page;
  answer: (a: PromptAnswer) => Promise<void>;
  /** Close it without the agent: dismiss, deny, or cancel. */
  cancel: () => void;
}

const BINDING = "__browserMcpPermissionPrompt";

/**
 * Wraps the permission-requesting APIs in each frame. A call whose
 * permission is already granted or denied goes straight to the real API; a
 * call that would prompt asks the server first and waits for its verdict.
 * "pass" (no server, opaque origin, binding failure) runs the real call.
 */
const PERMISSION_WRAPPER = `(() => {
  if (window.__browserMcpPermissionsWrapped) return;
  Object.defineProperty(window, "__browserMcpPermissionsWrapped", { value: true });
  const ask = async (names) => {
    const pending = [];
    for (const name of names) {
      let state = "prompt";
      try { state = (await navigator.permissions.query({ name })).state; } catch {}
      if (state === "prompt") pending.push(name);
    }
    if (!pending.length || typeof window.${BINDING} !== "function") return "pass";
    try { return await window.${BINDING}({ permissions: pending }); } catch { return "pass"; }
  };
  const notAllowed = () => new DOMException("Permission denied", "NotAllowedError");
  const wrapAsync = (owner, key, namesOf, onDenied) => {
    const orig = owner && owner[key];
    if (typeof orig !== "function") return;
    owner[key] = async function (...args) {
      const names = namesOf(...args);
      if (names.length && (await ask(names)) === "denied") return onDenied();
      return orig.apply(this, args);
    };
  };
  const reject = () => { throw notAllowed(); };

  if (window.Geolocation) {
    const proto = Geolocation.prototype;
    const getPos = proto.getCurrentPosition, watch = proto.watchPosition, clear = proto.clearWatch;
    const deniedError = { code: 1, message: "User denied Geolocation", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
    proto.getCurrentPosition = function (ok, fail, opts) {
      ask(["geolocation"]).then((v) => {
        if (v === "denied") { if (fail) fail(deniedError); return; }
        getPos.call(this, ok, fail, opts);
      });
    };
    const watches = new Map();
    let nextWatch = 1000000;
    proto.watchPosition = function (ok, fail, opts) {
      const id = nextWatch++;
      watches.set(id, null);
      ask(["geolocation"]).then((v) => {
        if (!watches.has(id)) return;
        if (v === "denied") { watches.delete(id); if (fail) fail(deniedError); return; }
        watches.set(id, watch.call(this, ok, fail, opts));
      });
      return id;
    };
    proto.clearWatch = function (id) {
      if (!watches.has(id)) return clear.call(this, id);
      const real = watches.get(id);
      watches.delete(id);
      if (real != null) clear.call(this, real);
    };
  }
  if (window.Notification) {
    const orig = Notification.requestPermission;
    Notification.requestPermission = function (cb) {
      const p = ask(["notifications"]).then((v) => (v === "denied" ? "denied" : orig.call(Notification)));
      if (typeof cb === "function") p.then(cb);
      return p;
    };
  }
  if (window.MediaDevices) {
    wrapAsync(MediaDevices.prototype, "getUserMedia",
      (c) => [c && c.audio ? "microphone" : null, c && c.video ? "camera" : null].filter(Boolean), reject);
  }
  if (window.Clipboard) {
    wrapAsync(Clipboard.prototype, "read", () => ["clipboard-read"], reject);
    wrapAsync(Clipboard.prototype, "readText", () => ["clipboard-read"], reject);
  }
  wrapAsync(Navigator.prototype, "requestMIDIAccess", () => ["midi"], reject);
  wrapAsync(window, "queryLocalFonts", () => ["local-fonts"], reject);
  wrapAsync(window, "getScreenDetails", () => ["window-management"], reject);
  wrapAsync(Document.prototype, "requestStorageAccess", () => ["storage-access"], reject);
  if (window.IdleDetector) wrapAsync(IdleDetector, "requestPermission", () => ["idle-detection"], () => "denied");
})();`;

/** Browser.setPermission descriptors for one Permissions API name. */
function descriptors(name: string): Array<{ name: string; sysex?: boolean }> {
  return name === "midi" ? [{ name: "midi" }, { name: "midi", sysex: true }] : [{ name }];
}

export class PromptTracker {
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private watching = new WeakMap<Page, Promise<void>>();
  private cdpSessions = new Set<CDPSession>();
  private openListeners = new Set<(p: PromptInfo) => void>();
  /** handle_next_dialog: answer the next dialog on a tab without asking. */
  private presets = new Map<string, PromptAnswer>();
  private browserCdp?: Promise<CDPSession>;
  private closed = false;

  constructor(
    private readonly opts: {
      /** Permission and HTTP-login tracking need CDP. */
      chromium: boolean;
      /** True when no other session or server shares the context, so every page in it belongs to this session. */
      exclusiveContext: boolean;
      tabIdOf: (page: Page) => string | null;
    },
  ) {}

  /**
   * Start tracking a page's permission requests and HTTP logins (dialogs come
   * through onDialog). Resolves once the page's hooks are installed; a second
   * call for the same page returns the first call's promise.
   */
  watchPage(page: Page): Promise<void> {
    let watching = this.watching.get(page);
    if (!watching) {
      watching = this.closed ? Promise.resolve() : this.startWatching(page);
      this.watching.set(page, watching);
    }
    return watching;
  }

  private async startWatching(page: Page): Promise<void> {
    page.on("close", () => this.dropPage(page));
    if (!this.opts.chromium) return;
    await Promise.all([this.watchPermissions(page), this.watchHttpAuth(page)]);
  }

  /** Context "dialog" listener. Ignores pages another session or server owns. */
  async onDialog(dialog: Dialog): Promise<void> {
    const page = dialog.page();
    if (!page || this.closed || !(await this.owns(page))) return;
    const tabId = this.opts.tabIdOf(page);
    const preset = tabId ? this.presets.get(tabId) : undefined;
    if (preset) {
      this.presets.delete(tabId!);
      await answerDialog(dialog, preset).catch(() => {});
      return;
    }
    this.open({
      page,
      info: {
        kind: "dialog",
        url: page.url(),
        dialog_type: dialog.type(),
        message: dialog.message(),
        ...(dialog.type() === "prompt" ? { default_value: dialog.defaultValue() } : {}),
      },
      answer: (a) => answerDialog(dialog, a),
      cancel: () => {
        dialog.dismiss().catch(() => {});
      },
    });
  }

  /** Answer the next dialog on a tab without holding it for the agent. */
  presetNextDialog(tabId: string, answer: PromptAnswer): void {
    this.presets.set(tabId, answer);
  }

  list(): PromptInfo[] {
    return [...this.pending.values()].map((p) => this.describe(p));
  }

  /** A held dialog on this tab: every page call on the tab hangs until it's answered. */
  blockingDialog(tabId: string): PromptInfo | undefined {
    for (const p of this.pending.values()) {
      if (p.info.kind === "dialog" && this.opts.tabIdOf(p.page) === tabId) return this.describe(p);
    }
    return undefined;
  }

  async respond(promptId: string, answer: PromptAnswer): Promise<PromptInfo> {
    const p = this.pending.get(promptId);
    if (!p) {
      const open = [...this.pending.keys()];
      throw new Error(
        `No prompt "${promptId}" is waiting. ${open.length ? `Waiting: ${open.join(", ")}.` : "No prompts are waiting."}`,
      );
    }
    if (p.info.kind === "http_auth" && answer.action === "accept" && (answer.username === undefined || answer.password === undefined)) {
      throw new Error(`Prompt "${promptId}" is an HTTP login: accept needs username and password.`);
    }
    const info = this.describe(p);
    this.pending.delete(promptId);
    await p.answer(answer);
    return info;
  }

  /** Calls back once for each prompt that opens until the returned function is called. */
  onOpen(cb: (p: PromptInfo) => void): () => void {
    this.openListeners.add(cb);
    return () => this.openListeners.delete(cb);
  }

  /** Resolves with the next prompt that opens on this page, or never. */
  nextOpenOn(page: Page): { promise: Promise<PromptInfo>; stop: () => void } {
    let stop = () => {};
    const promise = new Promise<PromptInfo>((resolve) => {
      stop = this.onOpen((p) => {
        if (this.pending.get(p.prompt_id)?.page === page) resolve(p);
      });
    });
    return { promise, stop };
  }

  /** Session closing: dismiss dialogs, deny permission calls, cancel logins. */
  async dispose(): Promise<void> {
    this.closed = true;
    for (const p of this.pending.values()) p.cancel();
    this.pending.clear();
    this.openListeners.clear();
    const sessions = [...this.cdpSessions];
    this.cdpSessions.clear();
    const browserCdp = this.browserCdp?.catch(() => undefined);
    await Promise.all([
      ...sessions.map((s) => s.detach().catch(() => {})),
      browserCdp?.then((s) => s?.detach().catch(() => {})),
    ]);
  }

  // ---------------------------------------------------------------------------

  private describe(p: Pending): PromptInfo {
    const { prompt_id, kind, ...rest } = p.info;
    return { prompt_id, kind, tab_id: this.opts.tabIdOf(p.page), ...rest };
  }

  private open(p: Omit<Pending, "info"> & { info: Omit<PromptInfo, "prompt_id" | "tab_id" | "opened_at"> }): void {
    if (this.closed) {
      p.cancel();
      return;
    }
    const prompt_id = `p${this.nextId++}`;
    const pending: Pending = { ...p, info: { prompt_id, opened_at: new Date().toISOString(), ...p.info } };
    this.pending.set(prompt_id, pending);
    const info = this.describe(pending);
    for (const cb of [...this.openListeners]) cb(info);
  }

  private dropPage(page: Page): void {
    for (const [id, p] of this.pending) {
      if (p.page !== page) continue;
      this.pending.delete(id);
      p.cancel();
    }
  }

  private async owns(page: Page): Promise<boolean> {
    if (this.opts.exclusiveContext || this.watching.has(page)) return true;
    // A popup whose claim is still resolving: its opener is one of ours.
    const opener = await page.opener().catch(() => null);
    return !!opener && this.watching.has(opener);
  }

  private async watchPermissions(page: Page): Promise<void> {
    await page.exposeBinding(BINDING, (source, payload: { permissions?: unknown }) =>
      this.onPermissionRequest(page, source.frame, payload),
    );
    await page.addInitScript(PERMISSION_WRAPPER);
    // addInitScript covers later documents; wrap the ones already loaded.
    for (const frame of page.frames()) frame.evaluate(PERMISSION_WRAPPER).catch(() => {});
  }

  private onPermissionRequest(page: Page, frame: Frame, payload: { permissions?: unknown }): Promise<PermissionVerdict> {
    const names = Array.isArray(payload?.permissions)
      ? payload.permissions.filter((n): n is string => typeof n === "string")
      : [];
    let origin = "null";
    try {
      origin = new URL(frame.url()).origin;
    } catch { /* about:blank and friends */ }
    // Opaque origins can't hold a permission; let the browser answer.
    if (!names.length || origin === "null" || this.closed) return Promise.resolve("pass");
    return new Promise<PermissionVerdict>((resolve) => {
      this.open({
        page,
        info: { kind: "permission", url: origin, permissions: names },
        answer: async (a) => {
          if (a.action === "dismiss") return resolve("denied");
          try {
            await this.grant(page, origin, names);
          } catch (e) {
            // Passing the call on would open the browser's own prompt, which
            // nobody answers in an unattended run.
            resolve("denied");
            throw new Error(`Could not grant ${names.join(", ")} for ${origin}, so the page's call was rejected: ${(e as Error).message}`);
          }
          resolve("granted");
        },
        cancel: () => resolve("denied"),
      });
    });
  }

  private async grant(page: Page, origin: string, names: string[]): Promise<void> {
    const pageCdp = await page.context().newCDPSession(page);
    let browserContextId: string | undefined;
    try {
      ({ targetInfo: { browserContextId } } = await pageCdp.send("Target.getTargetInfo"));
    } finally {
      await pageCdp.detach().catch(() => {});
    }
    const cdp = await this.browserSession(page);
    for (const name of names) {
      for (const permission of descriptors(name)) {
        await cdp.send("Browser.setPermission", { permission, setting: "granted", origin, browserContextId });
      }
    }
  }

  private browserSession(page: Page): Promise<CDPSession> {
    if (!this.browserCdp) {
      const browser: Browser | null = page.context().browser();
      if (!browser) throw new Error("the page's context has no browser");
      this.browserCdp = browser.newBrowserCDPSession();
      this.browserCdp.catch(() => { this.browserCdp = undefined; });
    }
    return this.browserCdp;
  }

  private async watchHttpAuth(page: Page): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    this.cdpSessions.add(cdp);
    const attempted = new Set<string>();
    cdp.on("Fetch.requestPaused", (e) => {
      cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
    });
    cdp.on("Fetch.authRequired", (e) => {
      const reply = (authChallengeResponse: { response: "ProvideCredentials" | "CancelAuth"; username?: string; password?: string }) =>
        cdp.send("Fetch.continueWithAuth", { requestId: e.requestId, authChallengeResponse });
      this.open({
        page,
        info: {
          kind: "http_auth",
          url: e.request.url,
          realm: e.authChallenge.realm,
          scheme: e.authChallenge.scheme,
          source: e.authChallenge.source ?? "Server",
          credentials_rejected: attempted.has(e.requestId),
        },
        answer: async (a) => {
          if (a.action === "dismiss") {
            await reply({ response: "CancelAuth" });
            return;
          }
          attempted.add(e.requestId);
          await reply({ response: "ProvideCredentials", username: a.username, password: a.password });
        },
        cancel: () => {
          reply({ response: "CancelAuth" }).catch(() => {});
        },
      });
    });
    page.on("close", () => {
      this.cdpSessions.delete(cdp);
    });
    await cdp.send("Fetch.enable", {
      handleAuthRequests: true,
      patterns: [{ urlPattern: "*", resourceType: "Document" }],
    });
  }
}

/**
 * page.goto for session setup (open_session / open_tab url) that stops
 * waiting when the page opens a prompt: a held dialog or HTTP login would
 * otherwise keep the navigation, and the tool call, waiting until timeout.
 * Navigation errors are swallowed; the next page call shows them.
 */
export async function gotoUntilPrompt(prompts: PromptTracker, page: Page, url: string): Promise<void> {
  const next = prompts.nextOpenOn(page);
  const nav = page.goto(url, { waitUntil: "load", timeout: 30000 }).catch(() => {});
  try {
    await Promise.race([nav, next.promise]);
  } finally {
    next.stop();
  }
}

async function answerDialog(dialog: Dialog, a: PromptAnswer): Promise<void> {
  if (a.action === "accept") await dialog.accept(a.text);
  else await dialog.dismiss();
}

/** One line per waiting prompt, for tool results. */
export function describePrompt(p: PromptInfo): string {
  const where = `tab ${p.tab_id ?? "(untracked)"}`;
  if (p.kind === "dialog") {
    return `${p.prompt_id}: ${p.dialog_type}() on ${where}: ${JSON.stringify(p.message ?? "")}`;
  }
  if (p.kind === "permission") {
    return `${p.prompt_id}: permission request for ${p.permissions?.join(" + ")} from ${p.url} on ${where}`;
  }
  return (
    `${p.prompt_id}: HTTP login (${p.scheme}, realm ${JSON.stringify(p.realm ?? "")}) for ${p.url} on ${where}` +
    (p.credentials_rejected ? ", the last credentials were rejected" : "")
  );
}

export const RESPOND_HINT =
  'Answer with respond_prompt({ session_id, prompt_id, action: "accept" | "dismiss" }) ' +
  "(accept a prompt() with text, an HTTP login with username and password).";

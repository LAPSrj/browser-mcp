import { createRequire } from "node:module";
import { getBrowserStackCredentials } from "./browserstack.js";

// browserstack-local is a CommonJS package that wraps the BrowserStackLocal
// binary (downloaded on first start). Load it lazily via createRequire so the
// dependency is only pulled in when a Local session is actually requested.
interface LocalInstance {
  start(options: Record<string, unknown>, callback: (error?: Error) => void): void;
  isRunning(): boolean;
  stop(callback: () => void): void;
}

/**
 * Singleton BrowserStack Local tunnel, ref-counted across sessions.
 *
 * BrowserStack routes a session's traffic through a Local tunnel only when the
 * session's caps carry `browserstack.local: "true"` (+ a matching
 * `browserstack.localIdentifier`). The tunnel itself is a daemon that must run
 * on the machine hosting this MCP server. One tunnel per process is enough for
 * any number of concurrent sessions, so we start it lazily on the first Local
 * session and tear it down when the last one releases. The identifier is
 * pid-scoped so concurrent browser-mcp processes (or a hand-run tunnel) don't
 * collide on the same localIdentifier.
 */
class BrowserStackLocalTunnel {
  private local?: LocalInstance;
  private refs = 0;
  private startPromise?: Promise<string>;
  private stopPromise?: Promise<void>;
  private readonly identifier = `browser-mcp-${process.pid}`;

  /**
   * Ensure the tunnel is up and register interest in it. Returns the
   * localIdentifier to inject into the session caps. Callers MUST pair every
   * successful acquire() with exactly one release().
   */
  async acquire(): Promise<string> {
    this.refs++;
    // If a teardown is mid-flight, let it settle before deciding to restart —
    // otherwise we could spawn a second binary while the first is still exiting.
    if (this.stopPromise) {
      try { await this.stopPromise; } catch { /* ignore — we're about to (re)start */ }
    }
    if (this.local?.isRunning()) return this.identifier;
    if (!this.startPromise) this.startPromise = this.start();
    try {
      return await this.startPromise;
    } catch (err) {
      // Roll back this acquire's ref and reset so the next attempt starts clean.
      this.refs = Math.max(0, this.refs - 1);
      this.startPromise = undefined;
      this.local = undefined;
      throw err;
    }
  }

  private start(): Promise<string> {
    const { accessKey } = getBrowserStackCredentials();
    const require = createRequire(import.meta.url);
    const { Local } = require("browserstack-local") as { Local: new () => LocalInstance };
    const local = new Local();
    this.local = local;
    return new Promise<string>((resolve, reject) => {
      local.start(
        {
          key: accessKey,
          localIdentifier: this.identifier,
          // Skip Live/App-Live plumbing we don't use.
          onlyAutomate: true,
          // Deliberately NOT force:true — that kills any other BrowserStackLocal
          // daemon on the machine (e.g. a tunnel started by hand). A unique
          // localIdentifier is what lets tunnels coexist.
        },
        (err?: Error) => (err ? reject(err) : resolve(this.identifier)),
      );
    });
  }

  /** Drop one interest in the tunnel; stop the daemon when the last one leaves. */
  async release(): Promise<void> {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return;
    const local = this.local;
    this.local = undefined;
    this.startPromise = undefined;
    if (!local || !local.isRunning()) return;
    this.stopPromise = new Promise<void>((res) => local.stop(() => res()));
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = undefined;
    }
  }
}

export const browserStackLocalTunnel = new BrowserStackLocalTunnel();

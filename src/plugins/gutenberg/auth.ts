import type { BrowserContext, Page } from "playwright";
import type { ResolvedPluginConfig } from "../types.js";

interface StorageStateData {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

/**
 * Manages WordPress authentication via wp-login.php.
 *
 * Logs in once via Playwright form submission, caches the storageState
 * (cookies + localStorage), and injects it into subsequent browser contexts.
 * Handles session expiry and concurrent login races.
 */
export class WpAuth {
  private cachedState: StorageStateData | null = null;
  private cachedAt = 0;
  private loginLock: Promise<StorageStateData> | null = null;
  private sessionTtl: number;

  constructor(private config: ResolvedPluginConfig) {
    this.sessionTtl = parseInt(config.wpSessionTtl ?? "3600", 10) * 1000;
  }

  /** Get storageState for a new browser context. Logs in if needed. */
  async getStorageState(page: Page): Promise<StorageStateData> {
    // Return cached state if fresh
    if (this.cachedState && (Date.now() - this.cachedAt) < this.sessionTtl) {
      return this.cachedState;
    }

    // Prevent concurrent login races: if a login is already in progress, wait for it
    if (this.loginLock) {
      return this.loginLock;
    }

    this.loginLock = this.performLogin(page);
    try {
      const state = await this.loginLock;
      return state;
    } finally {
      this.loginLock = null;
    }
  }

  /** Inject cached auth into a browser context (add cookies). */
  async injectAuth(context: BrowserContext): Promise<boolean> {
    if (!this.cachedState) return false;
    if ((Date.now() - this.cachedAt) >= this.sessionTtl) {
      this.invalidate();
      return false;
    }
    await context.addCookies(this.cachedState.cookies);
    return true;
  }

  /** Mark cached state as invalid (e.g. after detecting a redirect to login page). */
  invalidate(): void {
    this.cachedState = null;
    this.cachedAt = 0;
  }

  /** Check if a page ended up on the login page (session expired). */
  isOnLoginPage(page: Page): boolean {
    const url = page.url();
    // Check for standard WP login page and custom login URLs
    if (url.includes("wp-login.php")) return true;
    // Check if we were redirected to the configured custom login URL
    if (this.config.wpLoginUrl && url.startsWith(this.config.wpLoginUrl)) return true;
    return false;
  }

  private getLoginUrl(): string {
    if (this.config.wpLoginUrl) {
      return this.config.wpLoginUrl;
    }
    const base = this.config.wpUrl.replace(/\/+$/, "");
    return `${base}/wp-login.php`;
  }

  private async performLogin(page: Page): Promise<StorageStateData> {
    const loginUrl = this.getLoginUrl();

    try {
      await page.goto(loginUrl, { waitUntil: "load", timeout: 30000 });
    } catch (error) {
      throw new Error(
        `Could not reach WordPress at ${loginUrl}. ` +
        `Verify the site is running and WP_URL is correct. ` +
        `(${(error as Error).message})`
      );
    }

    // Verify we're on a WordPress login page
    const loginForm = await page.$("#loginform");
    if (!loginForm) {
      const userField = await page.$("#user_login");
      if (!userField) {
        throw new Error(
          `Login form not found at ${loginUrl}. ` +
          `The site may use a custom login URL. Set WP_LOGIN_URL to override.`
        );
      }
    }

    // Clear any existing values and fill credentials
    await page.fill("#user_login", "");
    await page.fill("#user_login", this.config.wpUsername);
    await page.fill("#user_pass", "");
    await page.fill("#user_pass", this.config.wpPassword);

    // Click submit. WordPress either redirects to wp-admin (success) or
    // re-renders the login page with an #login_error (failure).
    await page.click("#wp-submit");

    // Wait for either: successful redirect away from wp-login.php, OR the
    // login error div to appear. Whichever happens first ends the wait.
    try {
      await Promise.race([
        page.waitForURL(
          (url) => !url.toString().includes("wp-login.php"),
          { timeout: 30000 },
        ),
        page.waitForSelector("#login_error", { timeout: 30000 }),
      ]);
    } catch {
      // Both raced promises timed out — treat as a login failure below
    }

    // Check for login errors (re-rendered login page with error message)
    const loginError = await page.$("#login_error");
    if (loginError) {
      const errorText = await loginError.textContent();
      throw new Error(`WordPress login failed: ${errorText?.trim() || "Unknown error"}`);
    }

    // Still on login page with no error element = ambiguous failure
    if (this.isOnLoginPage(page)) {
      throw new Error(
        `WordPress login failed: still on login page after form submission. ` +
        `Verify WP_USERNAME and WP_PASSWORD are correct.`
      );
    }

    // Extract and cache storageState
    const state = await page.context().storageState() as StorageStateData;
    this.cachedState = state;
    this.cachedAt = Date.now();

    return state;
  }
}

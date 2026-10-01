#!/usr/bin/env node
/**
 * WpAuth login against a mock wp-login.php, covering WordPress's
 * "Confirm your administration email" screen. WordPress redirects admins to
 * wp-login.php?action=confirm_admin_email after a successful login every
 * 6 months; the auth cookie is already set by then, so WpAuth must treat it
 * as a successful login and must not answer the prompt.
 *
 * Coverage:
 *  1. Plain login → /wp-admin/ succeeds.
 *  2. Login → confirm screen succeeds, carries the auth cookie, and doesn't
 *     submit the confirm form.
 *  3. Wrong password still fails with the #login_error text.
 *  4. Custom WP_LOGIN_URL → confirm screen on that URL succeeds.
 *  5. isOnLoginPage: confirm screen is not a login page; the form is.
 *
 * Run after `npm run build` (or `npx tsc`).
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const { WpAuth } = await import(path.join(root, "dist/plugins/wp/auth.js"));

let pass = 0, fail = 0;
function check(cond, name, detail) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}

const AUTH_COOKIE = "wordpress_logged_in_test";
const PASSWORD = "p,a,s,s";

// Mock WordPress. `confirmAdminEmail` toggles the post-login redirect to the
// confirmation screen; `confirmPosts` counts answers to that screen.
const state = { confirmAdminEmail: false, confirmPosts: 0 };

const loginForm = (loginPath, error) => `<!doctype html><html><body>
  ${error ? `<div id="login_error"><strong>Error:</strong> ${error}</div>` : ""}
  <form name="loginform" id="loginform" action="${loginPath}" method="post">
    <input type="text" name="log" id="user_login">
    <input type="password" name="pwd" id="user_pass">
    <input type="submit" name="wp-submit" id="wp-submit" value="Log In">
  </form></body></html>`;

const confirmScreen = (loginPath) => `<!doctype html><html><body>
  <form class="admin-email-confirm-form" name="admin-email-confirm-form"
        action="${loginPath}?action=confirm_admin_email" method="post">
    <h1 class="admin-email__heading">Administration email verification</h1>
    <input type="submit" name="correct-admin-email" id="correct-admin-email" value="The email is correct">
  </form></body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => resolve(new URLSearchParams(body)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const loggedIn = (req.headers.cookie ?? "").includes(`${AUTH_COOKIE}=`);
  const isLoginPath = url.pathname === "/wp-login.php" || url.pathname === "/secret-login";
  const html = (body) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(body); };
  const redirect = (to, headers = {}) => { res.writeHead(302, { Location: to, ...headers }); res.end(); };

  if (isLoginPath && url.searchParams.get("action") === "confirm_admin_email") {
    if (!loggedIn) return redirect(url.pathname);
    if (req.method === "POST") { state.confirmPosts++; return redirect("/wp-admin/"); }
    return html(confirmScreen(url.pathname));
  }
  if (isLoginPath && req.method === "POST") {
    const form = await readBody(req);
    if (form.get("log") !== "admin" || form.get("pwd") !== PASSWORD) {
      return html(loginForm(url.pathname, "The password you entered is incorrect."));
    }
    const to = state.confirmAdminEmail
      ? `${url.pathname}?action=confirm_admin_email&wp_lang=en_US`
      : "/wp-admin/";
    return redirect(to, { "Set-Cookie": `${AUTH_COOKIE}=1; Path=/; HttpOnly` });
  }
  if (isLoginPath) return html(loginForm(url.pathname));
  if (url.pathname.startsWith("/wp-admin")) {
    if (!loggedIn) return redirect("/wp-login.php");
    return html("<!doctype html><html><body><h1>Dashboard</h1></body></html>");
  }
  res.writeHead(404); res.end();
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

async function login(config) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const auth = new WpAuth({ wpUrl: base, wpUsername: "admin", wpPassword: PASSWORD, ...config });
  try {
    const storage = await auth.getStorageState(page);
    return { storage, page, auth, error: null };
  } catch (error) {
    return { storage: null, page, auth, error };
  } finally {
    await context.close();
  }
}
const hasAuthCookie = (storage) => Boolean(storage?.cookies.some((c) => c.name === AUTH_COOKIE));

try {
  console.log("\n=== 1. Plain login lands on wp-admin ===");
  state.confirmAdminEmail = false;
  let r = await login({});
  check(!r.error, "login succeeds", r.error?.message);
  check(hasAuthCookie(r.storage), "storage carries the auth cookie");

  console.log("\n=== 2. Login lands on the admin email confirmation screen ===");
  state.confirmAdminEmail = true;
  state.confirmPosts = 0;
  const t0 = Date.now();
  r = await login({});
  check(!r.error, "login succeeds", r.error?.message);
  check(hasAuthCookie(r.storage), "storage carries the auth cookie");
  check(state.confirmPosts === 0, "confirm form left unanswered", `posts=${state.confirmPosts}`);
  check(Date.now() - t0 < 15000, "doesn't wait out the 30s login timeout", `${Date.now() - t0}ms`);

  console.log("\n=== 3. Wrong password still fails ===");
  state.confirmAdminEmail = false;
  r = await login({ wpPassword: "wrong" });
  check(/WordPress login failed: .*incorrect/.test(r.error?.message ?? ""), "throws with #login_error text", r.error?.message);

  console.log("\n=== 4. Custom login URL with confirmation screen ===");
  state.confirmAdminEmail = true;
  r = await login({ wpLoginUrl: `${base}/secret-login` });
  check(!r.error, "login succeeds", r.error?.message);
  check(hasAuthCookie(r.storage), "storage carries the auth cookie");

  console.log("\n=== 5. isOnLoginPage ===");
  const auth = new WpAuth({ wpUrl: base });
  const fakePage = (url) => ({ url: () => url });
  check(!auth.isOnLoginPage(fakePage(`${base}/wp-login.php?action=confirm_admin_email&wp_lang=en_US`)), "confirm screen is not a login page");
  check(auth.isOnLoginPage(fakePage(`${base}/wp-login.php?redirect_to=x`)), "login form is a login page");
  check(!auth.isOnLoginPage(fakePage(`${base}/wp-admin/post.php?post=1&action=edit`)), "editor is not a login page");
} finally {
  await browser.close();
  server.close();
}

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);

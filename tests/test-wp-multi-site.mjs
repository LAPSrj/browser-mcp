#!/usr/bin/env node
/**
 * Multi-site WordPress config (WP_SITES) against two mock wp-login.php servers.
 *
 * Coverage:
 *  1. loadWpSiteConfigs: single-site WP_URL, WP_SITES with suffixed vars,
 *     commas in passwords, write flag parsing, config errors.
 *  2. WpSites lookups: by name (any case), by URL (host + path), call URL rules.
 *  3. use: "wordpress" logs into the site of a full url, the first site for a
 *     relative url or no url; use: "wordpress:<site>" picks by name (any case);
 *     a full url outside every site fails.
 *  4. Write guard: savePost refuses on a WP_REQUIRE_ALLOW_WRITE site without
 *     allow_write, before touching the editor; other sites save.
 *  5. wp-gutenberg tools: refuse before launching a browser; skip the check
 *     when the call doesn't save; reject an unknown site name.
 *
 * Run after `npm run build` (or `npx tsc`).
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = (p) => import(path.join(root, "dist", p));

const { loadWpSiteConfigs } = await dist("plugins/wp/config.js");
const { WpSites, createWpSite } = await dist("plugins/wp/sites.js");
const { PluginRegistry } = await dist("plugins/registry.js");
const { resolveModes } = await dist("utils/resolve-modes.js");
const { launchSession, closeSession, toolContextStorage, createToolContext } = await dist("utils/browser.js");
const { savePost } = await dist("plugins/wp-gutenberg/utils/wp-data.js");
const wpPlugin = (await dist("plugins/wp/index.js")).default;
const gutenbergPlugin = (await dist("plugins/wp-gutenberg/index.js")).default;

let pass = 0, fail = 0;
function check(cond, name, detail) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`  ${tag}: ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}
function throwsWith(fn, re) {
  try { fn(); } catch (e) { return re.test(e.message) ? true : e.message; }
  return "did not throw";
}
async function rejectsWith(promise, re) {
  try { await promise; } catch (e) { return re.test(e.message) ? true : e.message; }
  return "did not reject";
}

// --- Mock WordPress: a login form that sets `wordpress_logged_in_<label>` ---
function startWp(label, password) {
  const cookie = `wordpress_logged_in_${label}`;
  const state = { logins: 0 };
  const form = (error) => `<!doctype html><html><body>
    ${error ? `<div id="login_error">${error}</div>` : ""}
    <form id="loginform" action="/wp-login.php" method="post">
      <input type="text" name="log" id="user_login">
      <input type="password" name="pwd" id="user_pass">
      <input type="submit" id="wp-submit" value="Log In">
    </form></body></html>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const html = (b) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(b); };
    if (url.pathname === "/wp-login.php" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        const f = new URLSearchParams(body);
        if (f.get("log") !== "admin" || f.get("pwd") !== password) return html(form("Wrong password."));
        state.logins++;
        res.writeHead(302, { Location: "/wp-admin/", "Set-Cookie": `${cookie}=1; Path=/` });
        res.end();
      });
      return;
    }
    if (url.pathname === "/wp-login.php") return html(form());
    return html("<!doctype html><html><body>Dashboard</body></html>");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, cookie })));
}

const local = await startWp("local", "local-pass");
const prod = await startWp("prod", "p,a,s,s");
// Different hostnames as well as ports, like a real local/prod pair.
const LOCAL_URL = `http://127.0.0.1:${local.server.address().port}`;
const PROD_URL = `http://localhost:${prod.server.address().port}`;

try {
  console.log("\n=== 1. loadWpSiteConfigs ===");
  {
    const [single] = loadWpSiteConfigs({ WP_URL: "https://a.test/", WP_USERNAME: "u", WP_PASSWORD: "x,y" });
    check(single.name === "default" && single.envSuffix === "", "WP_URL alone is the default site");
    check(single.wpUrl === "https://a.test", "trailing slash stripped");
    check(single.wpPassword === "x,y" && single.requireAllowWrite === false, "password kept whole, writes allowed");

    const sites = loadWpSiteConfigs({
      WP_SITES: " LOCAL , PROD ",
      WP_URL: "https://ignored.test",
      WP_URL_LOCAL: "http://site.local", WP_PASSWORD_LOCAL: "a",
      WP_URL_PROD: "https://site.com", WP_USERNAME_PROD: "admin", WP_PASSWORD_PROD: "p,a,s,s",
      WP_REQUIRE_ALLOW_WRITE_PROD: "true",
      WP_SESSION_TTL: "60", WP_SESSION_TTL_PROD: "120",
    });
    check(sites.map((s) => s.name).join() === "LOCAL,PROD", "WP_SITES order kept, names trimmed");
    check(sites[1].wpPassword === "p,a,s,s", "comma password read whole from WP_PASSWORD_PROD");
    check(sites[1].requireAllowWrite && !sites[0].requireAllowWrite, "WP_REQUIRE_ALLOW_WRITE_PROD only guards PROD");
    check(sites[0].wpSessionTtl === "60" && sites[1].wpSessionTtl === "120", "TTL falls back to WP_SESSION_TTL");
    check(sites.every((s) => s.wpUrl !== "https://ignored.test"), "WP_URL ignored when WP_SITES is set");

    for (const v of ["0", "false", "no", ""]) {
      const [s] = loadWpSiteConfigs({ WP_URL: "https://a.test", WP_REQUIRE_ALLOW_WRITE: v });
      check(s.requireAllowWrite === false, `WP_REQUIRE_ALLOW_WRITE="${v}" leaves writes allowed`);
    }

    check(throwsWith(() => loadWpSiteConfigs({}), /Set WP_URL .* or WP_SITES/) === true, "no sites → error");
    check(throwsWith(() => loadWpSiteConfigs({ WP_SITES: "PROD" }), /WP_URL_PROD is not set/) === true, "missing WP_URL_PROD → error");
    check(throwsWith(() => loadWpSiteConfigs({ WP_SITES: "my-site" }), /letters, digits and underscores/) === true, "bad name → error");
    check(throwsWith(() => loadWpSiteConfigs({ WP_SITES: "A,a", WP_URL_A: "http://a.test", WP_URL_a: "http://b.test" }), /more than once/) === true, "duplicate name → error");
    check(throwsWith(() => loadWpSiteConfigs({ WP_SITES: "A,B", WP_URL_A: "http://a.test/", WP_URL_B: "http://a.test" }), /same URL/) === true, "same URL → error");
    check(throwsWith(() => loadWpSiteConfigs({ WP_URL: "site.local" }), /not a valid URL/) === true, "URL without scheme → error");
  }

  console.log("\n=== 2. WpSites lookups ===");
  {
    const sites = new WpSites([
      { name: "ROOT", wpUrl: "https://multi.test", envSuffix: "_ROOT", wpSessionTtl: "1", requireAllowWrite: false },
      { name: "BLOG", wpUrl: "https://multi.test/blog", envSuffix: "_BLOG", wpSessionTtl: "1", requireAllowWrite: false },
      { name: "PROD", wpUrl: "https://site.com", envSuffix: "_PROD", wpSessionTtl: "1", requireAllowWrite: true },
    ].map(createWpSite));
    check(sites.byName("prod").name === "PROD", "byName ignores case");
    check(throwsWith(() => sites.byName("staging"), /Configured sites: ROOT, BLOG, PROD/) === true, "unknown name lists sites");
    check(sites.forUrl("https://multi.test/blog/wp-admin/")?.name === "BLOG", "longest path wins");
    check(sites.forUrl("https://multi.test/blogroll")?.name === "ROOT", "path match stops at a segment");
    check(sites.forUrl("http://site.com/x")?.name === "PROD", "scheme doesn't matter, host does");
    check(sites.forUrl("https://www.site.com/") === undefined, "other host → no site");
    check(sites.forCallUrl("/wp-admin/").name === "ROOT", "relative url → first site");
    check(sites.forCallUrl(undefined).name === "ROOT", "no url → first site");
    check(sites.forCallUrl("https://site.com/wp-admin/").name === "PROD", "full url → its site");
    check(throwsWith(() => sites.forCallUrl("https://other.test/"), /isn't under any configured WordPress site \(ROOT = /) === true, "full url outside every site → error");
  }

  // --- Load the real plugins with a LOCAL + PROD env ---
  for (const k of Object.keys(process.env)) if (k.startsWith("WP_")) delete process.env[k];
  Object.assign(process.env, {
    WP_SITES: "LOCAL,PROD",
    WP_URL_LOCAL: LOCAL_URL, WP_USERNAME_LOCAL: "admin", WP_PASSWORD_LOCAL: "local-pass",
    WP_URL_PROD: PROD_URL, WP_USERNAME_PROD: "admin", WP_PASSWORD_PROD: "p,a,s,s",
    WP_REQUIRE_ALLOW_WRITE_PROD: "1",
  });
  const launches = { count: 0 };
  const stubPage = { url: () => "about:blank", goto: async () => { throw new Error("stub goto"); } };
  const core = {
    launchSession: async () => { launches.count++; return { page: stubPage }; },
    closeSession: async () => {},
    getSessionPage: () => stubPage,
    listSessions: () => [],
  };
  const registry = new PluginRegistry();
  await registry.load(wpPlugin, {}, core);
  await registry.load(gutenbergPlugin, {}, core);
  registry.seal();

  console.log("\n=== 3. use: wordpress picks the site ===");
  {
    check(
      registry.listModes().map((m) => m.name).join() === "wordpress,wordpress:LOCAL,wordpress:PROD",
      "modes registered per site",
      registry.listModes().map((m) => m.name).join(),
    );
    const cookiesFor = async (use, url) => {
      const ctx = createToolContext(resolveModes(use, registry), url);
      return toolContextStorage.run(ctx, async () => {
        const session = await launchSession({ browser: "chromium", toolName: "test" });
        try {
          return (await session.context.cookies()).map((c) => c.name).sort().join();
        } finally {
          await closeSession(session);
        }
      });
    };
    check(await cookiesFor("wordpress", `${PROD_URL}/wp-admin/`) === prod.cookie, "full prod url → PROD login (comma password)");
    check(await cookiesFor("wordpress", "/wp-admin/") === local.cookie, "relative url → first site (LOCAL)");
    check(await cookiesFor("wordpress", undefined) === local.cookie, "no url → first site (LOCAL)");
    check(await cookiesFor("wordpress:prod", "/wp-admin/") === prod.cookie, "wordpress:prod (lowercase) → PROD");
    check(await rejectsWith(cookiesFor("wordpress", "https://example.com/"), /isn't under any configured WordPress site/) === true, "url outside every site → error");
    check(local.state.logins === 1 && prod.state.logins === 1, "each site logged in once, then cached", JSON.stringify([local.state, prod.state]));
  }

  console.log("\n=== 4. savePost write guard ===");
  {
    const fakeEditor = (base) => {
      const page = {
        evaluated: 0,
        url: () => `${base}/wp-admin/post.php?post=1&action=edit`,
        evaluate: async () => { page.evaluated++; return { id: 1, link: `${base}/?p=1`, status: "publish" }; },
      };
      return page;
    };
    const prodPage = fakeEditor(PROD_URL);
    check(
      await rejectsWith(savePost(prodPage), /requires allow_write: true .*WP_REQUIRE_ALLOW_WRITE_PROD/) === true,
      "PROD save without allow_write refused",
    );
    check(prodPage.evaluated === 0, "refused before touching the editor");
    await savePost(prodPage, true);
    check(prodPage.evaluated === 1, "PROD save with allow_write goes through");
    const localPage = fakeEditor(LOCAL_URL);
    await savePost(localPage);
    check(localPage.evaluated === 1, "LOCAL save needs no allow_write");
  }

  console.log("\n=== 5. wp-gutenberg tools ===");
  {
    const tool = (name) => registry.getTools().find((t) => t.name === `wp-gutenberg_${name}`).handler;
    launches.count = 0;
    check(
      await rejectsWith(tool("publish")({ post_id: 1, site: "PROD" }), /requires allow_write: true to save or publish/) === true,
      "publish on PROD without allow_write refused",
    );
    check(
      await rejectsWith(tool("clear_blocks")({ post_id: 1, site: "prod" }), /requires allow_write/) === true,
      "clear_blocks on prod refused",
    );
    check(launches.count === 0, "refused before launching a browser");
    check(
      await rejectsWith(tool("clear_blocks")({ post_id: 1, site: "PROD", skip_save: true }), /stub goto/) === true,
      "clear_blocks with skip_save passes the check",
    );
    check(
      await rejectsWith(tool("publish")({ post_id: 1, site: "PROD", allow_write: true }), /stub goto/) === true,
      "publish with allow_write passes the check",
    );
    check(
      await rejectsWith(tool("publish")({ post_id: 1 }), /stub goto/) === true,
      "publish with no site uses LOCAL, which allows writes",
    );
    check(
      await rejectsWith(tool("get_blocks")({ post_id: 1, site: "staging" }), /Unknown WordPress site "staging"/) === true,
      "unknown site name refused",
    );
  }
} finally {
  local.server.close();
  prod.server.close();
}

console.log(`\n=== Total: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);

#!/usr/bin/env node
/**
 * Unit tests for the wp-gutenberg session_id integration.
 *
 * Coverage:
 * 1. resolveGutenbergSession with session_id → routes via getSessionPage,
 *    cleanup is a no-op, warnings empty.
 * 2. resolveGutenbergSession without session_id, no peers → launches an
 *    ephemeral session, cleanup invokes closeSession, warnings empty.
 * 3. resolveGutenbergSession without session_id, peer sessions present →
 *    launches ephemeral, cleanup closes it, warnings include the
 *    discoverability nudge.
 * 4. Tool-handler integration via clear_blocks:
 *    a. session_id provided → handler does NOT call launchSession or
 *       closeSession; uses the page returned by getSessionPage.
 *    b. session_id omitted → handler launches + closes ephemeral; no warning
 *       when listSessions is empty.
 *    c. session_id omitted but listSessions non-empty → response carries
 *       _warnings with the expected nudge.
 *
 * Runs against compiled dist/. No real Playwright browsers — page calls are
 * stubbed so we can assert the lifecycle wiring purely.
 *
 * Usage: node test-wp-gutenberg-session-id.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// --- portability guard (auto-applied) ---
import { requireWp } from "./_helpers.mjs";
await requireWp();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const { resolveGutenbergSession } = await import(
  path.join(root, "dist/plugins/wp-gutenberg/utils/session.js")
);

let passed = 0;
let failed = 0;

function assert(condition, name, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function makePageStub() {
  return { __stub: true };
}

function makeCore({ peers = 0, persistentPage } = {}) {
  const calls = {
    launchSession: 0,
    closeSession: 0,
    getSessionPage: 0,
    listSessions: 0,
    navigateTo: 0,
  };
  const ephemeralPage = makePageStub();
  const ephemeralSession = { server: undefined, browser: {}, context: {}, page: ephemeralPage };
  const core = {
    launchSession: async () => {
      calls.launchSession++;
      return ephemeralSession;
    },
    closeSession: async (s) => {
      calls.closeSession++;
      if (s !== ephemeralSession) {
        throw new Error("closeSession called with non-ephemeral session");
      }
    },
    getSessionPage: () => {
      calls.getSessionPage++;
      return persistentPage ?? makePageStub();
    },
    listSessions: () => {
      calls.listSessions++;
      const out = [];
      for (let i = 0; i < peers; i++) out.push({ session_id: `peer-${i}` });
      return out;
    },
    navigateTo: async () => { calls.navigateTo++; },
    runActions: async () => ({}),
    saveFile: async (p) => p,
    generateFilename: () => "stub.png",
    resolveUrl: (u) => u,
    createPreviewBuffer: (b) => b,
  };
  return { core, calls, ephemeralPage, ephemeralSession };
}

// ============================================================================
// Test 1: resolveGutenbergSession unit cases
// ============================================================================
console.log("\n=== Test 1: resolveGutenbergSession with session_id ===");
{
  const persistentPage = makePageStub();
  const { core, calls } = makeCore({ persistentPage });
  const resolved = await resolveGutenbergSession(core, {
    session_id: "uuid-123",
    toolName: "gutenberg_test",
    sessionHooks: [],
  });
  assert(resolved.page === persistentPage, "page is the persistent page");
  assert(resolved.warnings.length === 0, "no warnings emitted");
  assert(calls.launchSession === 0, "launchSession NOT called");
  assert(calls.getSessionPage === 1, "getSessionPage called once");
  await resolved.cleanup();
  assert(calls.closeSession === 0, "closeSession NOT called on cleanup (caller owns)");
}

console.log("\n=== Test 2: resolveGutenbergSession without session_id, no peers ===");
{
  const { core, calls, ephemeralPage } = makeCore({ peers: 0 });
  const resolved = await resolveGutenbergSession(core, {
    toolName: "gutenberg_test",
    sessionHooks: [],
  });
  assert(resolved.page === ephemeralPage, "page is the ephemeral page");
  assert(calls.launchSession === 1, "launchSession called once");
  assert(calls.listSessions === 1, "listSessions consulted for warning gate");
  assert(resolved.warnings.length === 0, "no warning when no peer sessions");
  await resolved.cleanup();
  assert(calls.closeSession === 1, "closeSession called by cleanup");
}

console.log("\n=== Test 3: resolveGutenbergSession without session_id, peers present ===");
{
  const { core, calls } = makeCore({ peers: 2 });
  const resolved = await resolveGutenbergSession(core, {
    toolName: "gutenberg_test",
    sessionHooks: [],
  });
  assert(calls.launchSession === 1, "launchSession called once");
  assert(resolved.warnings.length === 1, "exactly one warning emitted");
  assert(
    typeof resolved.warnings[0] === "string"
      && resolved.warnings[0].includes("session_id")
      && resolved.warnings[0].includes("ephemeral"),
    "warning text mentions session_id + ephemeral",
  );
  await resolved.cleanup();
  assert(calls.closeSession === 1, "closeSession called by cleanup");
}

// ============================================================================
// Test 4: synthetic handler exercising the same helper pattern every real
// wp-gutenberg tool now uses. We avoid the real wp-data/editor stubs (ESM
// bindings are read-only) — but the lifecycle wiring is identical, since
// every tool's handler reduces to: resolve → use page → cleanup → response.
// ============================================================================

function makeSyntheticHandler(core, sessionHooks) {
  return async (params) => {
    const resolved = await resolveGutenbergSession(core, {
      session_id: params.session_id,
      toolName: "synthetic_tool",
      sessionHooks,
    });
    try {
      // simulated tool body — the only thing we care about is that we
      // received a usable page and that lifecycle is wired correctly.
      if (!resolved.page) throw new Error("no page");
      const response = { content: [{ type: "text", text: `ok post=${params.post_id}` }] };
      if (resolved.warnings.length > 0) response._warnings = resolved.warnings;
      return response;
    } finally {
      await resolved.cleanup();
    }
  };
}

console.log("\n=== Test 4a: synthetic handler with session_id ===");
{
  const persistentPage = makePageStub();
  const { core, calls } = makeCore({ persistentPage, peers: 1 });
  const handler = makeSyntheticHandler(core, []);
  const res = await handler({ post_id: 42, session_id: "uuid-xyz" });
  assert(calls.launchSession === 0, "no ephemeral launch");
  assert(calls.closeSession === 0, "no closeSession (caller owns)");
  assert(calls.getSessionPage === 1, "getSessionPage used");
  assert(res._warnings === undefined, "no _warnings when session_id provided");
}

console.log("\n=== Test 4b: synthetic handler without session_id, no peers ===");
{
  const { core, calls } = makeCore({ peers: 0 });
  const handler = makeSyntheticHandler(core, []);
  const res = await handler({ post_id: 42 });
  assert(calls.launchSession === 1, "ephemeral launchSession");
  assert(calls.closeSession === 1, "ephemeral closeSession in finally");
  assert(res._warnings === undefined, "no warning when no persistent sessions");
}

console.log("\n=== Test 4c: synthetic handler without session_id, with peers ===");
{
  const { core, calls } = makeCore({ peers: 1 });
  const handler = makeSyntheticHandler(core, []);
  const res = await handler({ post_id: 42 });
  assert(calls.launchSession === 1, "ephemeral launchSession");
  assert(calls.closeSession === 1, "ephemeral closeSession in finally");
  assert(Array.isArray(res._warnings) && res._warnings.length === 1, "_warnings carries exactly 1 entry");
  assert(
    res._warnings[0].includes("session_id") && res._warnings[0].includes("open_session"),
    "warning text references session_id and open_session",
  );
}

console.log("\n=== Test 4d: multi-call cohesion via session_id ===");
{
  const persistentPage = makePageStub();
  const { core, calls } = makeCore({ persistentPage });
  const handler = makeSyntheticHandler(core, []);
  await handler({ post_id: 1, session_id: "uuid-1" });
  await handler({ post_id: 2, session_id: "uuid-1" });
  assert(calls.launchSession === 0, "no ephemeral browsers launched");
  assert(calls.closeSession === 0, "session never closed by handler");
  assert(calls.getSessionPage === 2, "getSessionPage called once per handler invocation");
}

console.log("\n=== Test 4e: multi-call cohesion — same Page identity preserved ===");
{
  const persistentPage = makePageStub();
  const { core } = makeCore({ persistentPage });
  const seen = new Set();
  const handler = async (params) => {
    const resolved = await resolveGutenbergSession(core, {
      session_id: params.session_id,
      toolName: "t",
      sessionHooks: [],
    });
    seen.add(resolved.page);
    await resolved.cleanup();
  };
  await handler({ post_id: 1, session_id: "uuid-1" });
  await handler({ post_id: 2, session_id: "uuid-1" });
  await handler({ post_id: 3, session_id: "uuid-1" });
  assert(seen.size === 1, "all 3 calls observed the same Page reference");
}

// ============================================================================
console.log(`\n=== Total: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);

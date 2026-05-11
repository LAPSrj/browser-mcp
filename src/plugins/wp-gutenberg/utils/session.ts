import type { Page } from "playwright";
import type { CoreUtils, SessionHook } from "../../types.js";

const NO_SESSION_ID_WARNING =
  "No session_id passed; ran ephemeral. State won't carry to your next call. " +
  "Pass session_id from open_session() for multi-call cohesion.";

export interface ResolvedGutenbergSession {
  page: Page;
  /** Run on tool exit. No-op when caller-owned (session_id provided). */
  cleanup: () => Promise<void>;
  /** Append to ToolResponse._warnings. May be empty. */
  warnings: string[];
}

export interface ResolveSessionOpts {
  session_id?: string;
  toolName: string;
  sessionHooks: SessionHook[];
  viewport?: { width: number; height: number };
}

/**
 * Bridge between persistent (sessionManager-owned) and ephemeral
 * (per-call launchSession) page lifecycles. When session_id is provided,
 * route through the persistent session and leave lifecycle to the caller.
 * When omitted, preserve byte-for-byte the ephemeral launch + close pattern
 * the wp-gutenberg tools shipped with — and emit a discoverability warning
 * if the caller has open sessions but didn't pass one.
 */
export async function resolveGutenbergSession(
  core: CoreUtils,
  opts: ResolveSessionOpts,
): Promise<ResolvedGutenbergSession> {
  if (opts.session_id) {
    const page = core.getSessionPage(opts.session_id);
    return {
      page,
      cleanup: async () => {
        // caller owns the session
      },
      warnings: [],
    };
  }

  const session = await core.launchSession({
    browser: "chromium",
    viewport: opts.viewport ?? { width: 1280, height: 720 },
    sessionHooks: opts.sessionHooks,
    toolName: opts.toolName,
  });

  const warnings: string[] = [];
  try {
    if (core.listSessions().length > 0) {
      warnings.push(NO_SESSION_ID_WARNING);
    }
  } catch {
    // Listing sessions should never fail; if it does, just skip the warning.
  }

  return {
    page: session.page,
    cleanup: async () => {
      await core.closeSession(session);
    },
    warnings,
  };
}

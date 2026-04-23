import type { SessionHook } from "../plugins/types.js";
import type { PluginRegistry } from "../plugins/registry.js";

export type UseParam = string | string[] | undefined;

/**
 * Resolve a core tool's `use` parameter into session hooks, using the
 * plugin registry's mode map. Shared between server.ts (MCP tool wrapper)
 * and cli.ts so the resolution logic lives in one place.
 *
 * Throws with the list of available modes on unknown names so callers
 * don't have to guess at the namespace.
 */
export function resolveModes(
  use: UseParam,
  registry: PluginRegistry | undefined,
): SessionHook[] {
  if (!use) return [];
  const names = Array.isArray(use) ? use : [use];
  if (names.length === 0) return [];

  const hooks: SessionHook[] = [];
  for (const name of names) {
    const mode = registry?.getMode(name);
    if (!mode) {
      const available = registry?.listModes().map((m) => m.name) ?? [];
      const list = available.length > 0 ? available.join(", ") : "(none registered)";
      throw new Error(
        `Unknown mode "${name}". Available modes: ${list}. ` +
        `Modes are registered by plugins loaded via BROWSER_MCP_PLUGINS.`,
      );
    }
    hooks.push(...mode.hooks);
  }
  return hooks;
}

/**
 * Strip the `use` param from a params object before passing to a tool
 * handler. Prevents `use` from leaking into tool implementations that
 * don't know about it.
 */
export function stripUse<T extends { use?: UseParam }>(params: T): Omit<T, "use"> {
  const { use: _unused, ...rest } = params;
  return rest;
}

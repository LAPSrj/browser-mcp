import { execFile } from "node:child_process";
import { z } from "zod";
import type { Page } from "playwright";
import type { ScreenshotPlugin, PluginContext, PluginConfigSchema, ResolvedPluginConfig, ToolResponse } from "../types.js";
import { sessionManager } from "../../core/sessions.js";
import { locate, frameNote } from "../../utils/frames.js";
import { typeText } from "../../utils/input.js";
import { loadCustomConfig, fillArgv, targetParam, type CustomTool } from "./config.js";

// Tools defined by a JSON file (see config.ts). Fill steps type a command's
// output into a field the agent names and never return it.

const DEFAULT_TIMEOUT_MS = 15000;
const STDERR_CAP = 500;

const ok = (text: string): ToolResponse => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResponse => ({ content: [{ type: "text", text }], isError: true });

interface RunResult { code: number; stdout: string; stderr: string }

function runCommand(argv: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.code === "ENOENT") {
        return reject(new Error(`"${argv[0]}" is not on the MCP server's PATH. Add its folder to PATH in the server's env.`));
      }
      if (e.killed) return reject(new Error(`"${argv[0]}" didn't finish within ${timeoutMs} ms.`));
      if (typeof e.code === "number") return resolve({ code: e.code, stdout, stderr });
      reject(new Error(`Couldn't run "${argv[0]}": ${e.message}`));
    });
  });
}

function exitMessage(tool: CustomTool, argv0: string, r: RunResult): string {
  const stderr = r.stderr.trim().slice(0, STDERR_CAP);
  const template = tool.errors?.[String(r.code)] ?? tool.errors?.default;
  if (template) return template.replaceAll("{stderr}", stderr);
  // `#!/usr/bin/env <interpreter>` exits 127 when the interpreter isn't on PATH.
  const hint = r.code === 127 ? " (127 usually means the command or its interpreter isn't on the MCP server's PATH)" : "";
  return `"${argv0}" exited with code ${r.code}${hint}: ${stderr}`;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Origin of a page values may be typed into: https, or http on this machine. */
function typingOrigin(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`The field's page has no usable URL (${url}).`);
  }
  // *.localhost is reserved for this machine (RFC 6761), and Chromium resolves it to loopback itself.
  const local = LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith(".localhost");
  if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u.origin;
  throw new Error(`Refusing to type into ${u.origin}: values are only typed on https pages or on localhost.`);
}

function hide(message: string, value: string): string {
  return value ? message.split(value).join("[hidden]") : message;
}

async function fillTool(page: Page, tool: CustomTool, p: Record<string, string | undefined>): Promise<ToolResponse> {
  const timeoutMs = tool.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const steps = tool.fill!.filter((s) => p[targetParam(s.target)!]);
  if (steps.length === 0) {
    const names = tool.fill!.map((s) => targetParam(s.target)).join(", ");
    return fail(`Pass at least one of: ${names}.`);
  }
  const lines: string[] = [];
  const stop = (message: string) => fail([...lines, message].join("\n"));
  for (const step of steps) {
    const param = targetParam(step.target)!;
    const asked = p[param]!;
    const { locator, selector } = await locate(page, asked);
    const handle = await locator.elementHandle({ timeout: 10000 });
    if (!handle) throw new Error(`${param}: ${asked} matches nothing.`);
    try {
      const frame = await handle.ownerFrame();
      if (!frame) throw new Error(`${param}: ${asked} is no longer on the page.`);
      const origin = typingOrigin(frame.url());
      const argv = fillArgv(step.run, { ...p, url: frame.url() });
      const r = await runCommand(argv, timeoutMs);
      if (r.code !== 0) return stop(exitMessage(tool, argv[0], r));
      const value = r.stdout.replace(/\r?\n$/, "");
      if (!value) return stop(`${param}: the command printed nothing, so nothing was typed.`);
      if (frame.isDetached() || new URL(frame.url()).origin !== origin) {
        return stop(`${param}: the page moved to another site while the value was read, so nothing was typed.`);
      }
      try {
        await typeText(locator, selector, value, { timeout: 10000 });
      } catch (e) {
        throw new Error(hide((e as Error).message, value));
      }
      lines.push(`Filled ${param} (${[...value].length} chars)${frameNote(asked, selector)}`);
    } finally {
      await handle.dispose().catch(() => {});
    }
  }
  return ok(lines.join("\n"));
}

async function returnTool(page: Page, tool: CustomTool, p: Record<string, string | undefined>): Promise<ToolResponse> {
  const argv = fillArgv(tool.run!, { ...p, url: page.url() });
  const r = await runCommand(argv, tool.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  if (r.code !== 0) return fail(exitMessage(tool, argv[0], r));
  return ok(r.stdout.trim());
}

function toolSchema(tool: CustomTool): Record<string, unknown> {
  const shape: Record<string, unknown> = {
    session_id: z.string().describe("open_session id"),
    tab_id: z.string().optional().describe("Session tab (default: active)"),
  };
  for (const [name, def] of Object.entries(tool.params ?? {})) {
    shape[name] = def.required ? z.string().describe(def.description) : z.string().optional().describe(def.description);
  }
  return shape;
}

const customPlugin: ScreenshotPlugin = {
  name: "custom",
  version: "1.0.0",

  getConfigSchema(): PluginConfigSchema {
    return {
      configFile: {
        envVar: "BROWSER_MCP_CUSTOM_CONFIG",
        required: true,
        description: "Path to the JSON file that defines the custom tools",
      },
    };
  },

  register(ctx: PluginContext, resolved: ResolvedPluginConfig): void {
    const config = loadCustomConfig(resolved.configFile);
    for (const [name, tool] of Object.entries(config.tools)) {
      const note = tool.fill ? " Types each value into the field you name and never returns it." : "";
      ctx.registerTool({
        name,
        description: tool.description + note,
        schema: toolSchema(tool),
        handler: async (p) => {
          if (tool.fill && sessionManager.isTracing(p.session_id)) {
            return fail("A trace is recording on this session and would save the typed values. Call trace_stop first.");
          }
          const page = ctx.core.getSessionPage(p.session_id, p.tab_id);
          return tool.fill ? fillTool(page, tool, p) : returnTool(page, tool, p);
        },
      });
    }
  },
};

export default customPlugin;

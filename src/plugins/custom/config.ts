import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// The JSON file named by BROWSER_MCP_CUSTOM_CONFIG. Data only: each tool runs
// commands from the file and either returns their output or types it into
// fields the agent picks.

const NAME = /^[a-z][a-z0-9_]*$/;
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;
const RESERVED_PARAMS = new Set(["url", "session_id", "tab_id", "timeout"]);
const ERROR_KEY = /^([1-9][0-9]{0,2}|default)$/;

const argvSchema = z.array(z.string()).min(1);

const toolSchema = z.strictObject({
  description: z.string().min(1),
  params: z.record(z.string(), z.strictObject({
    description: z.string().min(1),
    required: z.boolean().optional(),
  })).optional(),
  run: argvSchema.optional(),
  output: z.literal("return").optional(),
  fill: z.array(z.strictObject({ target: z.string(), run: argvSchema })).min(1).optional(),
  errors: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const fileSchema = z.strictObject({
  version: z.literal(1),
  tools: z.record(z.string(), toolSchema),
});

export type CustomTool = z.infer<typeof toolSchema>;
export type CustomConfig = z.infer<typeof fileSchema>;

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** The single placeholder a fill target is made of, e.g. "{password_selector}" → "password_selector". */
export function targetParam(target: string): string | null {
  const m = /^\{([a-z][a-z0-9_]*)\}$/.exec(target);
  return m ? m[1] : null;
}

function checkTool(name: string, tool: CustomTool): string[] {
  const problems: string[] = [];
  const at = `tools.${name}`;
  if (!NAME.test(name)) problems.push(`${at}: tool names must match ${NAME}`);
  const params = tool.params ?? {};
  for (const p of Object.keys(params)) {
    if (!NAME.test(p)) problems.push(`${at}.params.${p}: param names must match ${NAME}`);
    if (RESERVED_PARAMS.has(p)) problems.push(`${at}.params.${p}: "${p}" is reserved`);
  }
  const checkArgv = (argv: string[], where: string) => {
    for (const arg of argv) {
      for (const [, ph] of arg.matchAll(PLACEHOLDER)) {
        if (ph !== "url" && !(ph in params)) problems.push(`${where}: {${ph}} is not "url" or a declared param`);
      }
    }
  };
  if (tool.run && tool.fill) problems.push(`${at}: use either "run" or "fill", not both`);
  if (!tool.run && !tool.fill) problems.push(`${at}: needs "run" (with "output": "return") or "fill"`);
  if (tool.run) {
    if (tool.output !== "return") problems.push(`${at}: "run" needs "output": "return"`);
    checkArgv(tool.run, `${at}.run`);
  } else if (tool.output) {
    problems.push(`${at}: "output" only goes with "run"`);
  }
  tool.fill?.forEach((step, i) => {
    const where = `${at}.fill[${i}]`;
    const param = targetParam(step.target);
    if (!param || !(param in params)) problems.push(`${where}.target: must be one placeholder naming a declared param, like "{password_selector}"`);
    checkArgv(step.run, `${where}.run`);
  });
  for (const key of Object.keys(tool.errors ?? {})) {
    if (!ERROR_KEY.test(key)) problems.push(`${at}.errors.${key}: keys are exit codes ("1", "2", …) or "default"`);
  }
  return problems;
}

/** Read and check the file. Throws one error listing every problem. */
export function loadCustomConfig(file: string): CustomConfig {
  const full = path.resolve(expandHome(file));
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    throw new Error(`custom plugin: can't read ${full}: ${(e as Error).message}`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`);
    throw new Error(`custom plugin: ${full} is not a valid version 1 file:\n  ${issues.join("\n  ")}`);
  }
  const problems = Object.entries(parsed.data.tools).flatMap(([name, tool]) => checkTool(name, tool));
  if (Object.keys(parsed.data.tools).length === 0) problems.push("tools: the file defines no tools");
  if (problems.length) throw new Error(`custom plugin: ${full} has problems:\n  ${problems.join("\n  ")}`);
  return parsed.data;
}

/** Replace {name} placeholders in each argument. A param value starting with "-" is refused so it can't become a flag. */
export function fillArgv(argv: string[], values: Record<string, string | undefined>): string[] {
  return argv.map((arg) =>
    arg.replace(PLACEHOLDER, (_, name: string) => {
      const v = values[name];
      if (v === undefined || v === "") throw new Error(`Missing value for {${name}}.`);
      if (name !== "url" && v.startsWith("-")) throw new Error(`${name} can't start with "-".`);
      return v;
    }),
  );
}

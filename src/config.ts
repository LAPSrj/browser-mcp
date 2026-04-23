export interface ServerConfig {
  baseUrl?: string;
  outputDir?: string;
  /** Browser launch timeout in ms (default: 30000) */
  launchTimeout?: number;
  /** Number of browser launch retries (default: 2) */
  launchRetries?: number;
  /** Global tool execution timeout in ms (default: 90000) */
  toolTimeout?: number;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

export function loadConfig(): ServerConfig {
  const baseUrl = process.env.BROWSER_MCP_BASE_URL?.replace(/\/+$/, "");
  const outputDir = process.env.BROWSER_MCP_OUTPUT_DIR;

  return {
    baseUrl: baseUrl || undefined,
    outputDir: outputDir || undefined,
    launchTimeout: parseIntEnv("BROWSER_MCP_LAUNCH_TIMEOUT", 30000),
    launchRetries: parseIntEnv("BROWSER_MCP_LAUNCH_RETRIES", 2),
    toolTimeout: parseIntEnv("BROWSER_MCP_TOOL_TIMEOUT", 90000),
  };
}

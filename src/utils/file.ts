import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function saveFile(filePath: string, data: Buffer | string): Promise<string> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fs.writeFile(filePath, data);
  return path.resolve(filePath);
}

export function generateFilename(parts: {
  prefix?: string;
  browser?: string;
  viewport?: string;
  extension: string;
}): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const segments = [parts.prefix, parts.browser, parts.viewport, timestamp].filter(Boolean);
  return `${segments.join("_")}.${parts.extension}`;
}

import { readFileSync } from "node:fs";

let cached: boolean | undefined;

export function isWsl(): boolean {
  if (cached !== undefined) return cached;
  if (process.platform !== "linux") {
    cached = false;
    return cached;
  }
  if (process.env.WSL_DISTRO_NAME) {
    cached = true;
    return cached;
  }
  try {
    const v = readFileSync("/proc/version", "utf8");
    cached = /microsoft|WSL/i.test(v);
  } catch {
    cached = false;
  }
  return cached;
}

export function readWslGatewayIp(): string | null {
  try {
    const v = readFileSync("/proc/net/route", "utf8");
    for (const line of v.split("\n").slice(1)) {
      const [, dest, gw] = line.split(/\s+/);
      if (dest === "00000000" && gw && gw !== "00000000") {
        const b = gw.match(/.{2}/g) ?? [];
        if (b.length === 4) {
          return `${parseInt(b[3], 16)}.${parseInt(b[2], 16)}.${parseInt(b[1], 16)}.${parseInt(b[0], 16)}`;
        }
      }
    }
  } catch {
    // fall through
  }
  return null;
}

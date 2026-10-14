// Playwright error messages are written for a terminal: ANSI colour codes in
// the call log, and a strict-mode violation lists up to 10 matches with their
// outerHTML. Agents read every character, so shorten them before returning.

const ANSI = /\x1b\[[0-9;]*m/g;
const STRICT = /strict mode violation: (.+?) resolved to (\d+) elements:/;
const MATCH_LINE = /^\s+\d+\) /;
const STRICT_KEEP = 3;
const MATCH_MAX_CHARS = 160;

export function compactErrorMessage(message: string): string {
  const text = message.replace(ANSI, "");
  const strict = text.match(STRICT);
  if (!strict) return text;

  const lines = text.split("\n");
  const head = lines.find((l) => STRICT.test(l)) ?? strict[0];
  const matches = lines.filter((l) => MATCH_LINE.test(l));
  const kept = matches.slice(0, STRICT_KEEP).map((l) => {
    const t = l.trim();
    return `  ${t.length > MATCH_MAX_CHARS ? `${t.slice(0, MATCH_MAX_CHARS)}…` : t}`;
  });
  const total = Number(strict[2]);
  const more = total > kept.length ? [`  … ${total - kept.length} more`] : [];
  return [
    head.trim(),
    ...kept,
    ...more,
    "Make the selector match one element, or append ` >> nth=0` for the first match.",
  ].join("\n");
}

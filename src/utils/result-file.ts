import { createHash } from "node:crypto";
import path from "node:path";
import { saveFile } from "./file.js";

/**
 * Apply a tool's `result_path` param to its result.
 *
 * Without a path, the result is returned inline as usual (minus the internal
 * `_summary` field). With a path, every text part of the result is written to
 * that file, joined by newlines, so the file holds exactly the text the tool
 * would have returned inline. The text parts are then replaced by one line:
 *
 *   Result written to <absolute path> (<bytes> bytes, sha256 <hex>). <summary>
 *
 * `<summary>` is the tool's optional `_summary` string. Image parts stay
 * inline. Error results stay inline and write no file, so the caller sees the
 * error directly.
 */
export async function applyResultPath(
  result: any,
  resultPath: string | undefined,
  outputDir: string,
): Promise<any> {
  if (!result || !Array.isArray(result.content)) return result;
  const { _summary: summary, ...rest } = result;
  if (!resultPath || rest.isError) return rest;

  const texts = rest.content.filter((c: { type: string }) => c.type === "text");
  if (texts.length === 0) {
    return {
      ...rest,
      content: [
        ...rest.content,
        { type: "text", text: `result_path ignored: this result has no text to write.` },
      ],
    };
  }

  const body = texts.map((c: { text: string }) => c.text).join("\n");
  const filePath = path.isAbsolute(resultPath) ? resultPath : path.join(outputDir, resultPath);
  const absPath = await saveFile(filePath, body);
  const bytes = Buffer.byteLength(body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const line =
    `Result written to ${absPath} (${bytes} bytes, sha256 ${sha256}).` +
    (typeof summary === "string" && summary ? ` ${summary}` : "");

  return {
    ...rest,
    content: [
      { type: "text", text: line },
      ...rest.content.filter((c: { type: string }) => c.type !== "text"),
    ],
  };
}

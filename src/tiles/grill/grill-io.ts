import { invoke } from "@tauri-apps/api/core";
import type { WriteResult } from "../../domain/grill/write";

/** File access for the grill Answer view (ADR 034). */
export interface GrillIo {
  /** The file's text with LF line endings, and a hash of its bytes on disk. */
  read(path: string): Promise<{ text: string; hash: string }>;
  /** Writes only if the file still has `expectedHash`; otherwise throws `{ kind: "ExternalModified" }`. */
  write(path: string, text: string, expectedHash: string): Promise<void>;
  readBase64(path: string): Promise<string>;
}

interface ReadTextFileResult { content: string; hash_hex: string; line_ending: "lf" | "crlf" | "mixed"; has_trailing_newline: boolean }

const endings = new Map<string, { lineEnding: "lf" | "crlf" | "mixed"; trailing: boolean }>();

export const tauriGrillIo: GrillIo = {
  async read(path) {
    const result = await invoke<ReadTextFileResult>("read_text_file", { path });
    endings.set(path, { lineEnding: result.line_ending, trailing: result.has_trailing_newline });
    return { text: result.content.replace(/\r\n/g, "\n"), hash: result.hash_hex };
  },
  async write(path, text, expectedHash) {
    const ending = endings.get(path) ?? { lineEnding: "lf", trailing: true };
    // Writing normalises every line ending, which would touch lines other than
    // the answer's; refuse instead, so the one-slot promise holds.
    if (ending.lineEnding === "mixed") {
      throw new Error("this file mixes CRLF and LF line endings; answer it in Edit mode, or save it once there to make them consistent");
    }
    try {
      await invoke("write_text_file", {
        args: { path, content: text, expected_hash_hex: expectedHash, line_ending: ending.lineEnding, ensure_trailing_newline: ending.trailing },
      });
    } catch (error) {
      const parsed = typeof error === "string" ? safeJson(error) : error;
      if (parsed && typeof parsed === "object" && (parsed as { kind?: string }).kind === "ExternalModified") {
        throw Object.assign(new Error("The file changed on disk"), { kind: "ExternalModified" });
      }
      throw error instanceof Error ? error : new Error(typeof error === "string" ? error : JSON.stringify(error));
    }
  },
  readBase64: (path) => invoke<string>("read_file_base64", { path }),
};

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

const ATTEMPTS = 3;

/**
 * Reads the file, applies `edit` to what is on disk now, and writes it only if
 * the file has not changed since; on a change (the agent appending a round,
 * say) the edit is re-applied to the new text. So an answer never overwrites
 * anything written meanwhile.
 */
export async function updateGrillFile(io: GrillIo, path: string, edit: (text: string) => WriteResult): Promise<WriteResult> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const { text, hash } = await io.read(path);
    const result = edit(text);
    if (!result.ok || result.text === text) return result;
    try {
      await io.write(path, result.text, hash);
      return result;
    } catch (error) {
      if ((error as { kind?: string }).kind === "ExternalModified") continue;
      return { ok: false, error: `Could not save the answer: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: false, error: "The file kept changing while saving; try again." };
}

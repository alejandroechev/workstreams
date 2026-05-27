import { writeTextToClipboard } from "./clipboard";

/**
 * Decode an OSC 52 payload of the form "<targets>;<base64>" and write the
 * decoded UTF-8 text to the system clipboard.
 *
 * OSC 52 ("manipulate selection data") is the standard escape sequence used
 * by terminal applications (e.g. Copilot CLI, tmux, vim) to copy text to the
 * host's clipboard. xterm.js does NOT handle OSC 52 by default — terminals
 * that don't register a handler silently drop the payload, which is why
 * "Copying to clipboard..." messages from a TUI never reach the OS.
 *
 * Returns true on success so xterm reports the OSC as handled.
 */
export async function handleOsc52(payload: string): Promise<boolean> {
  const semi = payload.indexOf(";");
  if (semi < 0) return false;
  const b64 = payload.slice(semi + 1);
  if (b64 === "?") {
    // Read query — we don't expose clipboard reads via OSC for safety.
    return false;
  }
  let text: string;
  try {
    text = decodeBase64Utf8(b64);
  } catch {
    return false;
  }
  if (!text) return false;
  try {
    await writeTextToClipboard(text);
    return true;
  } catch {
    return false;
  }
}

function decodeBase64Utf8(b64: string): string {
  if (typeof atob !== "function") return "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  return bin;
}

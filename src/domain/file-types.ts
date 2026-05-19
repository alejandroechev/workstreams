/**
 * File type helpers — extension-based classification used by tiles to
 * decide how to render a file (text editor vs markdown vs audio player).
 *
 * Pure functions, all extensions are normalised to lowercase before
 * lookup so callers can pass raw paths.
 */

const AUDIO_EXTS = new Set<string>([
  "mp3",
  "wav",
  "ogg",
  "flac",
  "m4a",
  "aac",
  "opus",
  "webm",
]);

/**
 * Map audio extension → MIME type for use with HTML5 `<audio>` Blob URLs.
 *
 * The browser/WebView2 picks a decoder based on the MIME hint; we still
 * defer to the format byte stream so a wrong MIME mostly still works,
 * but the right one helps with codec selection.
 */
const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/ogg; codecs=opus",
  webm: "audio/webm",
};

function getExt(path: string): string {
  const slashIdx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** True if the path has an audio extension we know how to play. */
export function isAudioFile(path: string): boolean {
  return AUDIO_EXTS.has(getExt(path));
}

/**
 * MIME type to use when wrapping audio bytes in a Blob. Falls back to
 * `audio/mpeg` (the most-compatible) for unknown audio-ish extensions.
 * Returns null for non-audio paths so callers can branch.
 */
export function mimeForAudio(path: string): string | null {
  const ext = getExt(path);
  if (!AUDIO_EXTS.has(ext)) return null;
  return AUDIO_MIME[ext] ?? "audio/mpeg";
}

/** Exposed for tests / debugging. */
export const SUPPORTED_AUDIO_EXTS: ReadonlyArray<string> = Array.from(AUDIO_EXTS);

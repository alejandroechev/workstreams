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

const IMAGE_EXTS = new Set<string>([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
  "avif",
]);

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
};

/** True if the path has an image extension we know how to render inline. */
export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(getExt(path));
}

/** MIME type for an image path, or null when the extension isn't known. */
export function mimeForImage(path: string): string | null {
  const ext = getExt(path);
  if (!IMAGE_EXTS.has(ext)) return null;
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}

export const SUPPORTED_IMAGE_EXTS: ReadonlyArray<string> = Array.from(IMAGE_EXTS);

/**
 * Decode a base64 string (as returned by Rust's `read_file_base64`) into
 * a Uint8Array. Browser-native, no Buffer dependency. Exposed so tiles
 * can reuse the same loader.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Build an object URL + raw bytes for an audio file path, given a
 * base64-encoded payload. The caller is responsible for revoking the
 * URL when the player unmounts.
 */
export function makeAudioBlobUrl(path: string, b64: string): { url: string; bytes: ArrayBuffer; size: number; mime: string } {
  const bytes = base64ToBytes(b64);
  const mime = mimeForAudio(path) || "audio/mpeg";
  const blob = new Blob([bytes], { type: mime });
  return { url: URL.createObjectURL(blob), bytes: bytes.buffer, size: bytes.length, mime };
}

/**
 * Build an object URL + raw bytes for an image file path. Mirrors the
 * audio loader. Caller revokes the URL on unmount / next swap.
 */
export function makeImageBlobUrl(path: string, b64: string): { url: string; bytes: ArrayBuffer; size: number; mime: string } {
  const bytes = base64ToBytes(b64);
  const mime = mimeForImage(path) || "application/octet-stream";
  const blob = new Blob([bytes], { type: mime });
  return { url: URL.createObjectURL(blob), bytes: bytes.buffer, size: bytes.length, mime };
}

/**
 * Resolve a relative path (as found in a markdown image src) against a
 * base directory. Absolute paths and URLs with schemes are returned
 * unchanged so http(s)/data/blob URLs continue to work as-is.
 *
 * Works for both Windows (`\`) and POSIX (`/`) separators. The result
 * preserves the base directory's separator style.
 */
export function resolveRelativePath(basePath: string, relativePath: string): string {
  if (!relativePath) return relativePath;
  if (/^[a-z][a-z0-9+.-]*:/i.test(relativePath)) return relativePath; // scheme present
  if (relativePath.startsWith("//")) return relativePath; // protocol-relative
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(relativePath)) return relativePath; // absolute

  const sep = basePath.includes("\\") && !basePath.includes("/") ? "\\" : "/";
  // Normalise the relative path to the base's separator.
  const normalisedRel = relativePath.replace(/[\\/]+/g, sep);
  // Split + collapse `..` / `.` segments.
  const baseSegments = basePath.replace(/[\\/]+$/, "").split(/[\\/]+/);
  const relSegments = normalisedRel.split(sep);
  for (const seg of relSegments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (baseSegments.length > 0) baseSegments.pop();
    } else {
      baseSegments.push(seg);
    }
  }
  return baseSegments.join(sep);
}

/**
 * Directory portion of a file path, with trailing separator stripped.
 * Works for both `\` and `/` separators. Returns "" for bare filenames.
 */
export function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx < 0) return "";
  return path.slice(0, idx);
}

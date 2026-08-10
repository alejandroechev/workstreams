/**
 * Platform detection + path helpers.
 *
 * The app was originally Windows-only, so a number of defaults (`C:\` roots,
 * backslash path joins) were hardcoded. Those break on macOS/Linux, where the
 * Tauri WebView is WKWebView/WebKitGTK rather than WebView2.
 *
 * Detection reads the WebView user agent, which is reliable across all three
 * Tauri backends and needs no extra Tauri plugin/permission. Path *reading*
 * elsewhere in the codebase already splits on `[\\/]`, so only construction
 * and defaults need to go through here.
 */

type PlatformKind = "windows" | "unix";

let override: PlatformKind | null = null;

/**
 * Force a platform for tests. Pass `null` to restore real detection.
 * Not used by production code.
 */
export function __setPlatformOverrideForTests(kind: PlatformKind | null): void {
  override = kind;
}

/**
 * True when running on Windows.
 *
 * Falls back to `true` when the user agent can't be read: the app shipped
 * Windows-only, so an undetectable environment should preserve historical
 * behaviour rather than silently switching path separators.
 */
export function isWindowsPlatform(): boolean {
  if (override !== null) return override === "windows";
  const ua =
    typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
      ? navigator.userAgent
      : "";
  if (!ua) return true;
  if (/Windows/i.test(ua)) return true;
  if (/Macintosh|Mac OS X|Linux|X11/i.test(ua)) return false;
  return true;
}

/** The platform's path separator. */
export function pathSeparator(): string {
  return isWindowsPlatform() ? "\\" : "/";
}

/**
 * Filesystem root used as a last-resort fallback when no directory is known.
 * (`C:\` is meaningless on macOS/Linux.)
 */
export function defaultRootDir(): string {
  return isWindowsPlatform() ? "C:\\" : "/";
}

/**
 * Join path segments with the platform separator, normalising any separators
 * that appear *inside* the supplied segments. This matters because relative
 * paths are persisted in the DB and may have been captured on another
 * platform, so a stored `features\a` must not leak a backslash into a unix
 * path (or vice versa).
 */
export function joinPath(base: string, ...segments: string[]): string {
  const sep = pathSeparator();
  const normalise = (s: string) => s.replace(/[\\/]+/g, sep);

  let out = normalise(base);
  for (const raw of segments) {
    if (!raw) continue;
    const seg = normalise(raw).replace(new RegExp(`^\\${sep}+`), "");
    if (!seg) continue;
    out = out.endsWith(sep) ? `${out}${seg}` : `${out}${sep}${seg}`;
  }
  return out;
}

/**
 * The containing directory of `path`, or `null` when already at a filesystem
 * root (or when `path` has no separator at all).
 *
 * Accepts either separator in the input, because paths are persisted in SQLite
 * and may have been captured on a different platform. A trailing separator is
 * ignored, so "up" from `/a/b/` is `/a` rather than `/a/b`.
 */
export function parentDir(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return null;

  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return null;

  const parent = trimmed.slice(0, idx);
  // Unix: the last separator was the leading one, so the parent is `/`.
  if (!parent) return "/";
  // Windows: a bare drive letter is the root and needs its trailing slash
  // back ("C:" is the *current directory* on that drive, not its root).
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

/**
 * Shell command to persist in a terminal tile's config.
 *
 * On Windows this stays `pwsh.exe` (unchanged behaviour). On macOS/Linux it
 * returns `null` so nothing is persisted and the Rust side resolves the user's
 * login shell (`$SHELL`) at spawn time — persisting `pwsh.exe` there would be
 * replayed verbatim when the tile is restored and the spawn would fail.
 */
export function defaultTerminalCommand(): string | null {
  return isWindowsPlatform() ? "pwsh.exe" : null;
}

/** WSL is a Windows-only feature; the menu entry is hidden elsewhere. */
export function supportsWsl(): boolean {
  return isWindowsPlatform();
}

/**
 * Menu/tile label for a plain terminal. The tile runs PowerShell on Windows
 * but the user's login shell on macOS/Linux, so the label must not claim
 * "PowerShell" there.
 */
export function terminalTileLabel(): string {
  return isWindowsPlatform() ? "PowerShell" : "Terminal";
}

/**
 * Render an app shortcut for display, using the modifier name that actually
 * appears on the user's keyboard.
 *
 * The shortcuts are physically identical — the app matches on
 * `KeyboardEvent.code` — but a Mac keyboard has no key labelled "Alt", so
 * showing "Alt+T" there sends the user hunting for a key that doesn't exist.
 * macOS convention is the bare ⌥ glyph with no separator.
 */
export function shortcutLabel(key: string): string {
  return isWindowsPlatform() ? `Alt+${key}` : `⌥${key}`;
}

/**
 * Folders for workstreams without a repo: created from the phone (ADR 033)
 * or from the desktop's New workstream form with no repo selected.
 */

export function expandHome(root: string, home: string): string {
  const trimmedHome = home.replace(/\/+$/, "");
  let path = root.trim();
  if (path === "~") path = trimmedHome;
  else if (path.startsWith("~/")) path = `${trimmedHome}/${path.slice(2)}`;
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`The folder for workstreams without a repo must be an absolute path, not "${root}".`);
  }
  return path.replace(/[\\/]+$/, "") || "/";
}

const MAX_ATTEMPTS = 100;

/**
 * Creates `<root>/<slug>`, or `<slug>-2`, `-3`… if taken. Never reuses an
 * existing folder: an agent started with `--yolo` must get an empty sandbox.
 * `createDirectory` must fail when the path exists (the Tauri command does).
 */
export async function createUniqueFolder(
  root: string,
  slug: string,
  createDirectory: (path: string) => Promise<void>,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const path = `${root}/${attempt === 1 ? slug : `${slug}-${attempt}`}`;
    try {
      await createDirectory(path);
      return path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists/i.test(message)) throw error;
    }
  }
  throw new Error(`Could not find a free folder name for "${slug}" in ${root}.`);
}

/**
 * A folder name from a workstream name: ASCII, lowercase, dashes, ≤50 chars.
 * Never contains a path separator or dot segment, whatever the phone sent.
 */
export function folderSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Letters with no Unicode decomposition to a plain ASCII base.
    .replace(/[øœæßđłþð]/g, (c) => ({ ø: "o", œ: "oe", æ: "ae", ß: "ss", đ: "d", ł: "l", þ: "th", ð: "d" })[c] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug || "workstream";
}

/**
 * A fresh, empty folder for a new workstream without a repo:
 * `<root>/<slug of name>`, or a numbered variant if that is taken. `~` in the
 * root is the user's home folder.
 */
export async function createStandaloneFolder(input: {
  root: string;
  name: string;
  homeDir: () => Promise<string>;
  createDirectory: (path: string) => Promise<void>;
}): Promise<string> {
  const home = input.root.trim().startsWith("~") ? await input.homeDir() : "";
  return createUniqueFolder(expandHome(input.root, home), folderSlug(input.name), input.createDirectory);
}

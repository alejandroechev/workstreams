/** Folders for workstreams created from the phone (ADR 033). */

export function expandHome(root: string, home: string): string {
  const trimmedHome = home.replace(/\/+$/, "");
  let path = root.trim();
  if (path === "~") path = trimmedHome;
  else if (path.startsWith("~/")) path = `${trimmedHome}/${path.slice(2)}`;
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`The folder for phone workstreams must be an absolute path, not "${root}".`);
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

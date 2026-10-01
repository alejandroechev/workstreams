/** A 1-based, inclusive line range in the shape Monaco's `IRange` subset uses. */
export interface LineRange {
  startLineNumber: number;
  endLineNumber: number;
}

/**
 * Diff file list label: the file name first, then its directory. Long paths
 * used to force horizontal scrolling just to find out which file a row was.
 */
export function diffFileLabel(path: string): { name: string; dir: string } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? path;
  return { name, dir: parts.join("/") };
}

/** How a language spells comments, and which quotes start strings to skip. */
export interface CommentSyntax {
  line: string[];
  block: Array<[open: string, close: string]>;
  strings: string[];
}

const C_LIKE: CommentSyntax = { line: ["//"], block: [["/*", "*/"]], strings: ['"', "'", "`"] };
// No `'`: Rust lifetimes (`&'a str`) would open a string that never closes.
const RUST: CommentSyntax = { line: ["//"], block: [["/*", "*/"]], strings: ['"'] };
const HASH: CommentSyntax = { line: ["#"], block: [], strings: ['"', "'"] };
const DASH: CommentSyntax = { line: ["--"], block: [["/*", "*/"]], strings: ["'", '"'] };
const MARKUP: CommentSyntax = { line: [], block: [["<!--", "-->"]], strings: [] };
const CSS: CommentSyntax = { line: [], block: [["/*", "*/"]], strings: ['"', "'"] };
const INI: CommentSyntax = { line: [";", "#"], block: [], strings: [] };
const PHP: CommentSyntax = { line: ["//", "#"], block: [["/*", "*/"]], strings: ['"', "'"] };

const BY_EXTENSION: Record<string, CommentSyntax> = {
  ts: C_LIKE, tsx: C_LIKE, js: C_LIKE, jsx: C_LIKE, mjs: C_LIKE, cjs: C_LIKE,
  java: C_LIKE, kt: C_LIKE, kts: C_LIKE, scala: C_LIKE, swift: C_LIKE, go: C_LIKE,
  c: C_LIKE, h: C_LIKE, cc: C_LIKE, cpp: C_LIKE, hpp: C_LIKE, cs: C_LIKE, m: C_LIKE,
  dart: C_LIKE, groovy: C_LIKE, gradle: C_LIKE, proto: C_LIKE, scss: C_LIKE, less: C_LIKE,
  rs: RUST,
  py: HASH, rb: HASH, sh: HASH, bash: HASH, zsh: HASH, fish: HASH, pl: HASH, r: HASH,
  ps1: HASH, psm1: HASH, yml: HASH, yaml: HASH, toml: HASH, cmake: HASH, mk: HASH,
  nix: HASH, tf: HASH, graphql: HASH, gql: HASH, dockerfile: HASH,
  sql: DASH, lua: DASH, hs: DASH,
  html: MARKUP, htm: MARKUP, xml: MARKUP, svg: MARKUP, md: MARKUP, mdx: MARKUP, vue: MARKUP,
  svelte: MARKUP, xaml: MARKUP, csproj: MARKUP,
  css: CSS,
  ini: INI, cfg: INI, conf: INI, properties: INI,
  php: PHP,
};

const BY_FILE_NAME: Record<string, CommentSyntax> = {
  dockerfile: HASH, makefile: HASH, gemfile: HASH, rakefile: HASH, ".gitignore": HASH,
  ".editorconfig": INI, ".env": HASH,
};

/** Comment syntax for a path, or null when its comments cannot be recognised. */
export function commentSyntaxFor(path: string): CommentSyntax | null {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  if (BY_FILE_NAME[name]) return BY_FILE_NAME[name];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] ?? null : null;
}

/**
 * Which lines contain a comment — whole-line, trailing, or inside a block.
 * Markers inside strings are skipped. Strings other than template literals end
 * at the line break, so an unbalanced quote cannot swallow the rest of a file.
 */
export function commentLineMask(text: string, syntax: CommentSyntax): boolean[] {
  const lines = text.split(/\r?\n/);
  const mask = lines.map(() => false);
  let blockClose: string | null = null;
  let template = false;

  lines.forEach((line, index) => {
    let quote: string | null = template ? "`" : null;
    let i = 0;
    if (blockClose) mask[index] = true;
    while (i < line.length) {
      if (blockClose) {
        const end = line.indexOf(blockClose, i);
        if (end === -1) return;
        i = end + blockClose.length;
        blockClose = null;
        continue;
      }
      const ch = line[i];
      if (quote) {
        if (ch === "\\") i += 2;
        else { if (ch === quote) quote = null; i += 1; }
        continue;
      }
      if (syntax.line.some((marker) => line.startsWith(marker, i))) {
        mask[index] = true;
        return;
      }
      const block = syntax.block.find(([open]) => line.startsWith(open, i));
      if (block) {
        mask[index] = true;
        blockClose = block[1];
        i += block[0].length;
        continue;
      }
      if (syntax.strings.includes(ch)) quote = ch;
      i += 1;
    }
    template = quote === "`";
  });
  return mask;
}

const MAX_EDIT_DISTANCE = 4000;

/**
 * Lines of `after` that the diff added or changed, 1-based. Myers' algorithm
 * over the region between the common prefix and suffix. Past a large edit
 * distance it falls back to "lines that do not appear in `before`", which is
 * close enough for a review filter and keeps memory bounded.
 */
export function changedLineNumbers(before: string, after: string): number[] {
  const a = before === "" ? [] : before.split(/\r?\n/);
  const b = after === "" ? [] : after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const added = myersAdded(midA, midB) ?? fallbackAdded(midA, midB);
  return added.map((index) => index + start + 1);
}

function fallbackAdded(a: string[], b: string[]): number[] {
  const remaining = new Map<string, number>();
  for (const line of a) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: number[] = [];
  b.forEach((line, index) => {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added.push(index);
  });
  return added;
}

/** 0-based indices of `b` that are insertions, or null past the edit cap. */
function myersAdded(a: string[], b: string[]): number[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, index) => index);
  if (m === 0) return [];
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[-(d+1)..d+1] as it was before round d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    if (d > MAX_EDIT_DISTANCE) return null;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): number[] {
  const added: number[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const at = (k: number) => trace[d][k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x -= 1; y -= 1; }
    if (down) added.push(prevY);
    x = prevX;
    y = prevY;
  }
  return added.reverse();
}

/** Changed lines of `after` (1-based) that contain a code comment. */
export function changedCommentLines(path: string, before: string, after: string): number[] {
  const syntax = commentSyntaxFor(path);
  if (!syntax) return [];
  const mask = commentLineMask(after, syntax);
  return changedLineNumbers(before, after).filter((line) => mask[line - 1]);
}

/**
 * Ranges to hide so only `visible` lines remain. Returns nothing when there is
 * nothing to show: hiding the whole file would leave an empty pane with no way
 * back to the code.
 */
export function hiddenRangesShowing(lineCount: number, visible: number[]): LineRange[] {
  const shown = [...new Set(visible)].filter((line) => line >= 1 && line <= lineCount).sort((x, y) => x - y);
  if (shown.length === 0) return [];
  const hidden: LineRange[] = [];
  let next = 1;
  for (const line of shown) {
    if (line > next) hidden.push({ startLineNumber: next, endLineNumber: line - 1 });
    next = line + 1;
  }
  if (next <= lineCount) hidden.push({ startLineNumber: next, endLineNumber: lineCount });
  return hidden;
}

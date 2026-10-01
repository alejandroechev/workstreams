import { describe, it, expect } from "vitest";
import {
  diffFileLabel,
  commentSyntaxFor,
  commentLineMask,
  changedLineNumbers,
  changedCommentLines,
  hiddenRangesShowing,
} from "../diff-comment-filter";

describe("diff file list labels", () => {
  it("puts the file name first and its directory after", () => {
    expect(diffFileLabel("src/tiles/RepoExplorerTile.tsx")).toEqual({
      name: "RepoExplorerTile.tsx",
      dir: "src/tiles",
    });
  });

  it("has no directory for a file at the repo root", () => {
    expect(diffFileLabel("README.md")).toEqual({ name: "README.md", dir: "" });
  });

  it("accepts Windows separators", () => {
    expect(diffFileLabel("src\\domain\\x.ts")).toEqual({ name: "x.ts", dir: "src/domain" });
  });
});

const mask = (path: string, text: string) => commentLineMask(text, commentSyntaxFor(path)!);

describe("finding code comments", () => {
  it("marks doc, line and trailing comments in Rust, not code", () => {
    expect(mask("a.rs", [
      "/// Docs.",
      "#[cfg(unix)]",
      "const X: &str = \"en_US\"; // why",
      "fn f() {}",
      "    // indented",
    ].join("\n"))).toEqual([true, false, true, false, true]);
  });

  it("marks every line of a block comment, including its blank lines", () => {
    expect(mask("a.ts", [
      "/**",
      " * Explains.",
      "",
      " */",
      "const x = 1; /* inline */ const y = 2;",
      "const z = 3;",
    ].join("\n"))).toEqual([true, true, true, true, true, false]);
  });

  // A URL in a string is the classic false positive.
  it("ignores comment markers inside strings", () => {
    expect(mask("a.ts", [
      'const url = "https://example.com";',
      "const s = 'a // b';",
      "const t = `/* not */`;",
      'const e = "quote \\" // still string";',
    ].join("\n"))).toEqual([false, false, false, false]);
  });

  // Rust lifetimes would otherwise open a string that swallows the comment.
  it("does not treat a Rust lifetime as a string", () => {
    expect(mask("a.rs", "fn f<'a>(x: &'a str) {} // note")).toEqual([true]);
  });

  it("knows hash, dash and markup comment styles", () => {
    expect(mask("run.py", "x = 1  # why\ny = '#not'")).toEqual([true, false]);
    expect(mask("deploy.sh", "# setup\necho hi")).toEqual([true, false]);
    expect(mask("q.sql", "-- pick\nSELECT 1")).toEqual([true, false]);
    expect(mask("README.md", "<!-- hidden\nstill -->\ntext")).toEqual([true, true, false]);
    expect(mask("Dockerfile", "# base\nFROM x")).toEqual([true, false]);
  });

  it("has no syntax for files it cannot reason about", () => {
    expect(commentSyntaxFor("image.png")).toBeNull();
    expect(commentSyntaxFor("data.json")).toBeNull();
  });
});

describe("finding changed lines", () => {
  it("reports added and modified lines on the new side, 1-based", () => {
    expect(changedLineNumbers("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([2, 4]);
  });

  it("does not report lines that only moved because of an insertion above", () => {
    expect(changedLineNumbers("a\nb\nc", "new\na\nb\nc")).toEqual([1]);
  });

  it("reports every line of a new file and none of an unchanged one", () => {
    expect(changedLineNumbers("", "x\ny")).toEqual([1, 2]);
    expect(changedLineNumbers("x\ny", "x\ny")).toEqual([]);
  });
});

describe("changed code comments", () => {
  const before = [
    "#[cfg(unix)]",
    "fn old() {}",
  ].join("\n");
  const after = [
    "#[cfg(unix)]",
    "fn old() {}",
    "",
    "/// The locale advertised to a spawned shell.",
    "///",
    "#[cfg(unix)]",
    'const DEFAULT_LOCALE: &str = "en_US.UTF-8";',
    "let x = 1; // trailing",
  ].join("\n");

  it("keeps only comment lines that the diff changed", () => {
    expect(changedCommentLines("pty.rs", before, after)).toEqual([4, 5, 8]);
  });

  it("ignores comments that were already there", () => {
    expect(changedCommentLines("a.rs", "// old\nfn f() {}", "// old\nfn g() {}")).toEqual([]);
  });

  it("finds nothing in files with no known comment syntax", () => {
    expect(changedCommentLines("a.json", "", "// x")).toEqual([]);
  });
});

describe("hiding everything but chosen lines", () => {
  it("hides the gaps around the visible lines", () => {
    expect(hiddenRangesShowing(10, [3, 4, 8])).toEqual([
      { startLineNumber: 1, endLineNumber: 2 },
      { startLineNumber: 5, endLineNumber: 7 },
      { startLineNumber: 9, endLineNumber: 10 },
    ]);
  });

  it("does not hide past either end", () => {
    expect(hiddenRangesShowing(3, [1, 3])).toEqual([{ startLineNumber: 2, endLineNumber: 2 }]);
  });

  // Hiding every line would leave an empty pane with no way back to the code.
  it("hides nothing when there is nothing to show", () => {
    expect(hiddenRangesShowing(10, [])).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { inferLanguage } from "../FileEditorView";

/**
 * Regression test: FileEditorView used to ship its own ~10-extension
 * inferLanguage() switch which silently lost syntax highlighting for
 * everything else (notably .cs, .go, .java, .c, .cpp, .sh, .php, .rb,
 * .swift, .kt, .sql, .xml). It now delegates to the shared
 * detectLanguage map. Lock that in.
 */
describe("inferLanguage", () => {
  it.each([
    ["Program.cs", "csharp"],
    ["script.csx", "csharp"],
    ["app.go", "go"],
    ["Main.java", "java"],
    ["main.c", "c"],
    ["util.h", "c"],
    ["widget.cpp", "cpp"],
    ["widget.hpp", "cpp"],
    ["build.sh", "shell"],
    ["index.php", "php"],
    ["app.rb", "ruby"],
    ["View.swift", "swift"],
    ["App.kt", "kotlin"],
    ["query.sql", "sql"],
    ["doc.xml", "xml"],
  ])("returns the correct Monaco language id for %s", (path, expected) => {
    expect(inferLanguage(path)).toBe(expected);
  });

  it("still resolves the previously hardcoded extensions", () => {
    expect(inferLanguage("a.ts")).toBe("typescript");
    expect(inferLanguage("a.tsx")).toBe("typescript");
    expect(inferLanguage("a.js")).toBe("javascript");
    expect(inferLanguage("a.json")).toBe("json");
    expect(inferLanguage("a.md")).toBe("markdown");
    expect(inferLanguage("a.py")).toBe("python");
    expect(inferLanguage("a.rs")).toBe("rust");
    expect(inferLanguage("a.toml")).toBe("toml");
    expect(inferLanguage("a.yml")).toBe("yaml");
    expect(inferLanguage("a.yaml")).toBe("yaml");
    expect(inferLanguage("a.html")).toBe("html");
    expect(inferLanguage("a.css")).toBe("css");
  });

  it("falls back to plaintext for unknown extensions", () => {
    expect(inferLanguage("readme")).toBe("plaintext");
    expect(inferLanguage("file.xyz")).toBe("plaintext");
  });

  it("is case-insensitive", () => {
    expect(inferLanguage("Program.CS")).toBe("csharp");
    expect(inferLanguage("APP.GO")).toBe("go");
  });
});

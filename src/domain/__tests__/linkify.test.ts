import { describe, it, expect } from "vitest";

import { splitLinks, hasLink } from "../linkify";

describe("splitLinks", () => {
  it("returns nothing for an empty string", () => {
    expect(splitLinks("")).toEqual([]);
  });

  it("returns a single text segment when there is no URL", () => {
    expect(splitLinks("just a plain note")).toEqual([
      { kind: "text", value: "just a plain note" },
    ]);
  });

  it("splits a URL out of the surrounding prose", () => {
    expect(splitLinks("see https://example.com/x for details")).toEqual([
      { kind: "text", value: "see " },
      { kind: "link", value: "https://example.com/x" },
      { kind: "text", value: " for details" },
    ]);
  });

  it("handles a URL at the very start and end", () => {
    expect(splitLinks("https://a.dev")).toEqual([
      { kind: "link", value: "https://a.dev" },
    ]);
  });

  it("recognises http:// as well as https://", () => {
    expect(splitLinks("http://localhost:1420/")).toEqual([
      { kind: "link", value: "http://localhost:1420/" },
    ]);
  });

  it("matches the scheme case-insensitively", () => {
    expect(splitLinks("HTTPS://Example.COM/A")).toEqual([
      { kind: "link", value: "HTTPS://Example.COM/A" },
    ]);
  });

  it("keeps several URLs in one string apart", () => {
    expect(splitLinks("a https://one.dev b https://two.dev c")).toEqual([
      { kind: "text", value: "a " },
      { kind: "link", value: "https://one.dev" },
      { kind: "text", value: " b " },
      { kind: "link", value: "https://two.dev" },
      { kind: "text", value: " c" },
    ]);
  });

  it("leaves trailing sentence punctuation outside the link", () => {
    expect(splitLinks("read https://example.com/x.")).toEqual([
      { kind: "text", value: "read " },
      { kind: "link", value: "https://example.com/x" },
      { kind: "text", value: "." },
    ]);
    expect(splitLinks("https://example.com/x, then")).toEqual([
      { kind: "link", value: "https://example.com/x" },
      { kind: "text", value: ", then" },
    ]);
  });

  it("leaves an unbalanced closing paren outside the link but keeps balanced ones", () => {
    expect(splitLinks("(see https://example.com/x)")).toEqual([
      { kind: "text", value: "(see " },
      { kind: "link", value: "https://example.com/x" },
      { kind: "text", value: ")" },
    ]);
    expect(splitLinks("https://en.wikipedia.org/wiki/A_(b)")).toEqual([
      { kind: "link", value: "https://en.wikipedia.org/wiki/A_(b)" },
    ]);
  });

  it("does not treat markup as a link", () => {
    expect(splitLinks("<b>hi</b>")).toEqual([{ kind: "text", value: "<b>hi</b>" }]);
  });

  it("splits across newlines without swallowing them", () => {
    expect(splitLinks("one\nhttps://a.dev\ntwo")).toEqual([
      { kind: "text", value: "one\n" },
      { kind: "link", value: "https://a.dev" },
      { kind: "text", value: "\ntwo" },
    ]);
  });
});

describe("hasLink", () => {
  it("is false for empty and link-free text", () => {
    expect(hasLink("")).toBe(false);
    expect(hasLink("no links here")).toBe(false);
  });

  it("is true when at least one URL is present", () => {
    expect(hasLink("go to https://example.com")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { parseGrill } from "../parse";
import { navigableQuestions, roundQuestions, IMPORTANCE_COLORS, assetPath, prototypeDocument, optionAnswer, selectedOption, PROTOTYPE_CSP } from "../view";
import newFormat from "./fixtures/new-format.md?raw";

const grill = parseGrill(newFormat);

describe("which questions you navigate", () => {
  it("lists a round's questions in file order", () => {
    expect(roundQuestions(grill, 2).map((q) => q.id)).toEqual(["A1", "A2", "A3"]);
  });

  it("filters by an importance threshold", () => {
    expect(navigableQuestions(grill, 1, { threshold: "All", unansweredOnly: false }).map((q) => q.id)).toEqual(["A1", "A2", "Z1"]);
    expect(navigableQuestions(grill, 1, { threshold: "High", unansweredOnly: false }).map((q) => q.id)).toEqual(["A1"]);
    expect(navigableQuestions(grill, 2, { threshold: "Blocking", unansweredOnly: false }).map((q) => q.id)).toEqual(["A1"]);
    expect(navigableQuestions(grill, 2, { threshold: "Medium", unansweredOnly: false }).map((q) => q.id)).toEqual(["A1", "A2", "A3"]);
  });

  it("can hide answered questions", () => {
    expect(navigableQuestions(grill, 2, { threshold: "All", unansweredOnly: true }).map((q) => q.id)).toEqual(["A1", "A3"]);
  });

  it("colours every level distinctly", () => {
    expect(new Set(Object.values(IMPORTANCE_COLORS)).size).toBe(4);
  });
});

describe("answers from options", () => {
  it("writes the option key, with a note when given", () => {
    expect(optionAnswer("b", "")).toBe("b");
    expect(optionAnswer("b", "  only on the phone ")).toBe("b — only on the phone");
  });
});

describe("visual asset paths", () => {
  const dir = "/s/files/features/x";
  it("resolves files inside the grill's assets folder", () => {
    expect(assetPath(dir, "grill-assets/A2/today.png")).toBe("/s/files/features/x/grill-assets/A2/today.png");
  });

  it("refuses anything outside it", () => {
    for (const bad of ["../secret.png", "grill-assets/../../x.html", "/etc/passwd", "other/a.png", "grill-assets\\..\\x", "https://x.example/a.png", ""]) {
      expect(assetPath(dir, bad)).toBeNull();
    }
  });
});

describe("prototype documents", () => {
  it("adds a policy that forbids the network, and inlines its own images", () => {
    const doc = prototypeDocument('<html><head><title>t</title></head><body><img src="logo.png"><img src="https://evil.example/x.png"><script>fetch("https://x")</script></body></html>', { "logo.png": "data:image/png;base64,AAA" });
    expect(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${PROTOTYPE_CSP}">`)).toBe(true);
    expect(doc).toContain('src="data:image/png;base64,AAA"');
    expect(doc).toContain('src="https://evil.example/x.png"');
  });

  it("puts the policy before anything the page says, comments included", () => {
    const doc = prototypeDocument("<p>hi</p>", {});
    expect(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    const commented = prototypeDocument("<!-- <head> fake </head> --><html><head></head><body></body></html>", {});
    expect(commented.indexOf("default-src 'none'")).toBeLessThan(commented.indexOf("<!--"));
    const sneaky = prototypeDocument('<meta http-equiv="Content-Security-Policy" content="default-src *"><p>x</p>', {});
    expect(sneaky.indexOf("default-src 'none'")).toBeLessThan(sneaky.indexOf("default-src *"));
  });
});

describe("reading an option answer back", () => {
  const options = [{ key: "a", text: "A" }, { key: "b", text: "B" }];
  it("finds the option and the note", () => {
    expect(selectedOption("b — only on the phone", options)).toEqual({ key: "b", note: "only on the phone" });
    expect(selectedOption("a", options)).toEqual({ key: "a", note: "" });
  });
  it("is null for free text, unknown keys and reco", () => {
    expect(selectedOption("", options)).toBeNull();
    expect(selectedOption("c", options)).toBeNull();
    expect(selectedOption("reco", options)).toBeNull();
    expect(selectedOption("about the same", options)).toBeNull();
  });
});

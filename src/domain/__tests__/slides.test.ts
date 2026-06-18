import { describe, it, expect } from "vitest";
import { splitSlides } from "../slides";

describe("splitSlides", () => {
  describe("hr strategy (default)", () => {
    it("splits on --- thematic breaks", () => {
      const { slides } = splitSlides("# One\n\n---\n\n# Two\n\n---\n\n# Three");
      expect(slides).toHaveLength(3);
      expect(slides[0]).toContain("# One");
      expect(slides[1]).toContain("# Two");
      expect(slides[2]).toContain("# Three");
    });

    it("returns a single slide when there is no separator", () => {
      const { slides } = splitSlides("# Only\n\nsome body");
      expect(slides).toHaveLength(1);
      expect(slides[0]).toContain("# Only");
    });

    it("splits on *** and ___ thematic breaks too", () => {
      expect(splitSlides("a\n\n***\n\nb").slides).toHaveLength(2);
      expect(splitSlides("a\n\n___\n\nb").slides).toHaveLength(2);
    });

    it("does not treat a setext underline / table-ish --- inside text as a break when not a standalone rule", () => {
      // A --- directly under text is a setext H2 underline, not a thematic break.
      const { slides } = splitSlides("Heading\n---\nbody");
      expect(slides).toHaveLength(1);
    });

    it("trims surrounding whitespace from each slide", () => {
      const { slides } = splitSlides("\n\n# One\n\n---\n\n# Two\n\n");
      expect(slides[0]).toBe("# One");
      expect(slides[1]).toBe("# Two");
    });

    it("ignores empty leading/trailing slides created by boundary separators", () => {
      const { slides } = splitSlides("---\n\n# One\n\n---");
      expect(slides).toEqual(["# One"]);
    });

    it("yields a single empty slide for an all-blank document", () => {
      expect(splitSlides("   \n\n  ").slides).toEqual([""]);
      expect(splitSlides("").slides).toEqual([""]);
    });

    it("normalizes CRLF line endings", () => {
      const { slides } = splitSlides("# One\r\n\r\n---\r\n\r\n# Two");
      expect(slides).toHaveLength(2);
      expect(slides[1]).toContain("# Two");
    });
  });

  describe("frontmatter as deck config", () => {
    it("consumes leading frontmatter into config and does not emit it as a slide", () => {
      const { config, slides } = splitSlides("---\nfontScale: 1.5\ntitle: My Talk\n---\n# One\n\n---\n\n# Two");
      expect(config.fontScale).toBe(1.5);
      expect(config.title).toBe("My Talk");
      expect(slides).toHaveLength(2);
      expect(slides[0]).toContain("# One");
      expect(slides[0]).not.toContain("fontScale");
    });

    it("leaves config empty when there is no frontmatter", () => {
      const { config } = splitSlides("# One\n\n---\n\n# Two");
      expect(config.fontScale).toBeUndefined();
      expect(config.title).toBeUndefined();
    });

    it("ignores a non-numeric fontScale", () => {
      const { config } = splitSlides("---\nfontScale: huge\n---\n# One");
      expect(config.fontScale).toBeUndefined();
    });
  });

  describe("heading strategy", () => {
    it("splits before each top-level heading", () => {
      const { slides } = splitSlides("# One\nbody1\n# Two\nbody2", { strategy: "heading" });
      expect(slides).toHaveLength(2);
      expect(slides[0]).toContain("# One");
      expect(slides[1]).toContain("# Two");
    });

    it("keeps content before the first heading as its own slide", () => {
      const { slides } = splitSlides("intro\n# One\nbody", { strategy: "heading" });
      expect(slides[0]).toContain("intro");
      expect(slides[1]).toContain("# One");
    });

    it("still consumes frontmatter under the heading strategy", () => {
      const { config, slides } = splitSlides("---\ntitle: T\n---\n# One\n# Two", { strategy: "heading" });
      expect(config.title).toBe("T");
      expect(slides).toHaveLength(2);
    });
  });
});

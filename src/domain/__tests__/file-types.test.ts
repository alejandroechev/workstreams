import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isAudioFile,
  mimeForAudio,
  SUPPORTED_AUDIO_EXTS,
  base64ToBytes,
  makeAudioBlobUrl,
  isImageFile,
  mimeForImage,
  makeImageBlobUrl,
  resolveRelativePath,
  dirnameOf,
  classifyLinkTarget,
  isMarkdownFile,
} from "../file-types";

describe("file-types", () => {
  describe("isAudioFile", () => {
    it.each(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "webm"])(
      "returns true for .%s",
      (ext) => {
        expect(isAudioFile(`song.${ext}`)).toBe(true);
        expect(isAudioFile(`C:\\music\\track.${ext}`)).toBe(true);
        expect(isAudioFile(`/home/user/track.${ext}`)).toBe(true);
      },
    );

    it("is case-insensitive", () => {
      expect(isAudioFile("song.MP3")).toBe(true);
      expect(isAudioFile("song.Ogg")).toBe(true);
      expect(isAudioFile("song.FLAC")).toBe(true);
    });

    it("returns false for non-audio extensions", () => {
      expect(isAudioFile("script.ts")).toBe(false);
      expect(isAudioFile("image.png")).toBe(false);
      expect(isAudioFile("doc.pdf")).toBe(false);
      expect(isAudioFile("clip.mp4")).toBe(false); // video, not audio
      expect(isAudioFile("song.wma")).toBe(false); // WMA explicitly excluded
    });

    it("returns false for paths without an extension", () => {
      expect(isAudioFile("Makefile")).toBe(false);
      expect(isAudioFile("")).toBe(false);
      expect(isAudioFile("folder/")).toBe(false);
    });

    it("handles paths with multiple dots correctly", () => {
      expect(isAudioFile("podcast.episode.42.mp3")).toBe(true);
      expect(isAudioFile("backup.flac.tmp")).toBe(false);
    });
  });

  describe("mimeForAudio", () => {
    it.each<[string, string]>([
      ["song.mp3", "audio/mpeg"],
      ["song.wav", "audio/wav"],
      ["song.ogg", "audio/ogg"],
      ["song.flac", "audio/flac"],
      ["song.m4a", "audio/mp4"],
      ["song.aac", "audio/aac"],
      ["song.opus", "audio/ogg; codecs=opus"],
      ["song.webm", "audio/webm"],
    ])("returns correct MIME for %s", (path, expected) => {
      expect(mimeForAudio(path)).toBe(expected);
    });

    it("returns null for non-audio extensions", () => {
      expect(mimeForAudio("script.ts")).toBeNull();
      expect(mimeForAudio("song.wma")).toBeNull();
      expect(mimeForAudio("noext")).toBeNull();
    });

    it("is case-insensitive on the extension", () => {
      expect(mimeForAudio("X.MP3")).toBe("audio/mpeg");
    });
  });

  describe("SUPPORTED_AUDIO_EXTS", () => {
    it("exposes exactly the documented set", () => {
      expect(new Set(SUPPORTED_AUDIO_EXTS)).toEqual(
        new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "webm"]),
      );
    });
  });

  describe("base64ToBytes", () => {
    it("decodes a small ASCII payload byte-for-byte", () => {
      // "hello" → "aGVsbG8="
      const out = base64ToBytes("aGVsbG8=");
      expect(Array.from(out)).toEqual([104, 101, 108, 108, 111]);
    });

    it("handles empty input", () => {
      expect(base64ToBytes("").length).toBe(0);
    });
  });

  describe("makeAudioBlobUrl", () => {
    const realCreate = URL.createObjectURL;
    afterEach(() => { URL.createObjectURL = realCreate; });

    it("creates a blob URL with the right MIME and size", () => {
      URL.createObjectURL = vi.fn(() => "blob:fake");
      const r = makeAudioBlobUrl("song.mp3", "aGVsbG8=");
      expect(r.url).toBe("blob:fake");
      expect(r.size).toBe(5);
      expect(r.mime).toBe("audio/mpeg");
      expect(r.bytes.byteLength).toBe(5);
    });
  });

  describe("isImageFile", () => {
    it.each(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"])(
      "returns true for .%s",
      (ext) => {
        expect(isImageFile(`pic.${ext}`)).toBe(true);
        expect(isImageFile(`C:\\img\\shot.${ext}`)).toBe(true);
      },
    );
    it("is case-insensitive", () => {
      expect(isImageFile("pic.PNG")).toBe(true);
      expect(isImageFile("pic.JpEg")).toBe(true);
    });
    it("returns false for non-image extensions", () => {
      expect(isImageFile("doc.md")).toBe(false);
      expect(isImageFile("song.mp3")).toBe(false);
      expect(isImageFile("video.mp4")).toBe(false);
      expect(isImageFile("Makefile")).toBe(false);
    });
  });

  describe("mimeForImage", () => {
    it("maps known extensions", () => {
      expect(mimeForImage("a.png")).toBe("image/png");
      expect(mimeForImage("a.jpg")).toBe("image/jpeg");
      expect(mimeForImage("a.jpeg")).toBe("image/jpeg");
      expect(mimeForImage("a.svg")).toBe("image/svg+xml");
      expect(mimeForImage("a.ico")).toBe("image/x-icon");
    });
    it("returns null for non-images", () => {
      expect(mimeForImage("a.txt")).toBe(null);
    });
  });

  describe("makeImageBlobUrl", () => {
    const realCreate = URL.createObjectURL;
    afterEach(() => { URL.createObjectURL = realCreate; });
    it("creates a blob URL with the right image MIME", () => {
      URL.createObjectURL = vi.fn(() => "blob:img");
      const r = makeImageBlobUrl("pic.png", "aGVsbG8=");
      expect(r.url).toBe("blob:img");
      expect(r.mime).toBe("image/png");
      expect(r.size).toBe(5);
    });
  });

  describe("dirnameOf", () => {
    it("returns the parent directory for posix paths", () => {
      expect(dirnameOf("/a/b/c.md")).toBe("/a/b");
    });
    it("returns the parent directory for windows paths", () => {
      expect(dirnameOf("C:\\a\\b\\c.md")).toBe("C:\\a\\b");
    });
    it("returns empty for bare filenames", () => {
      expect(dirnameOf("foo.md")).toBe("");
    });
  });

  describe("resolveRelativePath", () => {
    it("leaves absolute paths unchanged", () => {
      expect(resolveRelativePath("/base", "/other/x.png")).toBe("/other/x.png");
      expect(resolveRelativePath("C:\\base", "D:\\other\\x.png")).toBe("D:\\other\\x.png");
    });
    it("leaves URLs with schemes unchanged", () => {
      expect(resolveRelativePath("/base", "https://example.com/x.png")).toBe("https://example.com/x.png");
      expect(resolveRelativePath("/base", "data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
      expect(resolveRelativePath("/base", "blob:abc")).toBe("blob:abc");
    });
    it("joins relative paths against the base", () => {
      expect(resolveRelativePath("/a/b", "c/d.png")).toBe("/a/b/c/d.png");
      expect(resolveRelativePath("/a/b", "./c.png")).toBe("/a/b/c.png");
    });
    it("walks up with ..", () => {
      expect(resolveRelativePath("/a/b/c", "../d.png")).toBe("/a/b/d.png");
      expect(resolveRelativePath("/a/b/c", "../../e.png")).toBe("/a/e.png");
    });
    it("preserves windows separators", () => {
      expect(resolveRelativePath("C:\\a\\b", "c\\d.png")).toBe("C:\\a\\b\\c\\d.png");
      expect(resolveRelativePath("C:\\a\\b", "images/01.png")).toBe("C:\\a\\b\\images\\01.png");
    });
    it("handles trailing separators on the base", () => {
      expect(resolveRelativePath("/a/b/", "c.png")).toBe("/a/b/c.png");
    });
    it("returns the input unchanged when relative path is empty", () => {
      expect(resolveRelativePath("/a/b", "")).toBe("");
    });
    it("returns protocol-relative URLs unchanged", () => {
      expect(resolveRelativePath("/a/b", "//cdn.example.com/x.png")).toBe("//cdn.example.com/x.png");
    });
    it("does not pop below the root when too many '..' segments are present", () => {
      // Should not throw; we just stop popping once empty.
      expect(resolveRelativePath("/a", "../../../x.png")).toBe("x.png");
    });
  });

  describe("isMarkdownFile + classifyLinkTarget", () => {
    it("isMarkdownFile detects .md / .mdx / .markdown", () => {
      expect(isMarkdownFile("README.md")).toBe(true);
      expect(isMarkdownFile("notes.mdx")).toBe(true);
      expect(isMarkdownFile("doc.markdown")).toBe(true);
      expect(isMarkdownFile("script.ts")).toBe(false);
    });
    it("classifyLinkTarget routes by extension", () => {
      expect(classifyLinkTarget("a.md")).toBe("markdown");
      expect(classifyLinkTarget("a.png")).toBe("image");
      expect(classifyLinkTarget("a.mp3")).toBe("audio");
      expect(classifyLinkTarget("a.ts")).toBe("file");
      expect(classifyLinkTarget("noext")).toBe("file");
    });
  });
});

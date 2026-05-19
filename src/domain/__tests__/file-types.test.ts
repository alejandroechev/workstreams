import { describe, it, expect, vi, afterEach } from "vitest";
import { isAudioFile, mimeForAudio, SUPPORTED_AUDIO_EXTS, base64ToBytes, makeAudioBlobUrl } from "../file-types";

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
});

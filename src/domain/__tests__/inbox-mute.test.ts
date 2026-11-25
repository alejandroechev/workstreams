import { describe, it, expect } from "vitest";
import { digestRunItemId, muteBannerText } from "../inbox-mute";

describe("inbox mute", () => {
  it("says it is muted, and until when", () => {
    expect(muteBannerText({ muted: false, until: null })).toBeNull();
    expect(muteBannerText(undefined)).toBeNull();
    expect(muteBannerText({ muted: true, until: null })).toMatch(/^Muted until you turn it off\. .*dropped/);
    expect(muteBannerText({ muted: true, until: "2026-12-01T11:00:00.000Z" }, (d) => d.toISOString()))
      .toMatch(/^Muted until 2026-12-01T11:00:00.000Z\./);
  });

  it("names a digest's run like the native side", () => {
    expect(digestRunItemId("d1", 42)).toBe("drun:d1:42");
  });
});

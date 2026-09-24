import { describe, it, expect } from "vitest";
import { supportsPrInbox } from "../pr-inbox";

describe("ADO inbox eligibility", () => {
  it("accepts supported clone URLs, not lookalike hosts or malformed paths", () => {
    for (const remote of [
      "https://user@dev.azure.com/org/proj/_git/repo",
      "https://org.visualstudio.com/proj/_git/repo",
      "git@ssh.dev.azure.com:v3/org/proj/repo",
      "ssh://git@ssh.dev.azure.com/v3/org/proj/repo",
    ]) expect(supportsPrInbox(remote)).toBe(true);
    for (const remote of [null, "", "bad", "https://github.com/org/repo",
      "https://dev.azure.com.evil/org/proj/_git/repo", "http://dev.azure.com/org/proj/_git/repo",
      "https://dev.azure.com/org/proj/_git/repo/extra",
      "https://dev.azure.com/org/proj/_git/%2F", "https://dev.azure.com/org/proj/_git/%FF",
      "https://dev.azure.com/org/proj/_git/repo?x=1",
      "https://org.evil.visualstudio.com/proj/_git/repo",
    ]) expect(supportsPrInbox(remote)).toBe(false);
  });
});

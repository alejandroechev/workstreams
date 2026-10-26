import { describe, it, expect } from "vitest";
import { resultColor } from "../pipeline-result";

describe("resultColor", () => {
  it("gives failures, successes and partial successes their own colour", () => {
    expect(["failed", "succeeded", "partiallySucceeded", "canceled"].map(resultColor))
      .toEqual(["#f38ba8", "#a6e3a1", "#f9e2af", "#6c7086"]);
  });
});

import { describe, expect, it } from "vitest";

import {
  cargoBuildArgs,
  parseTestList,
  testListArgs,
} from "../trace-test-list.mjs";

describe("trace-tests CLI", () => {
  it("maps a package to Cargo -p", () => {
    expect(cargoBuildArgs("core-lib")).toEqual([
      "test",
      "--no-run",
      "--message-format=json",
      "-p",
      "core-lib",
    ]);
    expect(cargoBuildArgs(null)).toEqual(["test", "--no-run", "--message-format=json"]);
  });

  it("passes a name filter to libtest", () => {
    expect(testListArgs("shell path")).toEqual(["--list", "shell path"]);
    expect(testListArgs("")).toEqual(["--list"]);
  });

  it("keeps tests and ignores benchmarks + summary lines", () => {
    expect(parseTestList("a::b: test\nc::d: benchmark\n1 test, 1 benchmark\n")).toEqual(["a::b"]);
  });
});

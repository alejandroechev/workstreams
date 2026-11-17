import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { FileIcon } from "../FileIcon";

afterEach(cleanup);

describe("FileIcon", () => {
  it("colors folders, code, markdown, audio and other files differently", () => {
    const color = (name: string, isDir = false) => (render(<FileIcon name={name} isDir={isDir} />).container.firstElementChild as SVGElement).style.color;
    expect(new Set([color("src", true), color("a.rs"), color("audio.mp3"), color("x.bin")]).size).toBe(4);
    expect(color("a.md")).toBe(color("a.ts"));
  });

  it("takes a size", () => {
    const svg = render(<FileIcon name="a.rs" isDir={false} size={12} />).container.firstElementChild as SVGElement;
    expect(svg.style.width).toBe("12px");
  });
});

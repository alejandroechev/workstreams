import { describe, it, expect } from "vitest";
import { preprocessMermaidCode } from "../preprocessMermaid";

describe("preprocessMermaidCode", () => {
  it("escapes generic type angle brackets in message text", () => {
    expect(preprocessMermaidCode("Conv->>Conv: Create Channel<AudioFrame>")).toBe(
      "Conv->>Conv: Create Channel#lt;AudioFrame#gt;",
    );
  });

  it("escapes Vec<T> patterns", () => {
    expect(preprocessMermaidCode("Cosmos-->>SW: Vec<PublicationSegment>")).toBe(
      "Cosmos-->>SW: Vec#lt;PublicationSegment#gt;",
    );
  });

  it("preserves valid HTML tags", () => {
    const tags = [
      "<br/>",
      "<br>",
      "<b>x</b>",
      "<i>x</i>",
      "<em>x</em>",
      "<strong>x</strong>",
      "<sub>2</sub>",
      "<sup>2</sup>",
      "<u>x</u>",
      "<s>x</s>",
    ];
    for (const tag of tags) {
      expect(preprocessMermaidCode(`A->>B: ${tag}`)).toBe(`A->>B: ${tag}`);
    }
  });

  it("preserves arrow syntax", () => {
    expect(preprocessMermaidCode("A->>B: msg")).toBe("A->>B: msg");
    expect(preprocessMermaidCode("A-->>B: resp")).toBe("A-->>B: resp");
    expect(preprocessMermaidCode("A <--> B")).toBe("A <--> B");
  });

  it("preserves HTML comments", () => {
    expect(preprocessMermaidCode("<!-- comment -->")).toBe("<!-- comment -->");
  });

  it("converts &lt; and &gt; entities to mermaid escapes", () => {
    expect(preprocessMermaidCode("Channel&lt;AudioFrame&gt;")).toBe(
      "Channel#lt;AudioFrame#gt;",
    );
  });

  it("converts numeric entities", () => {
    expect(preprocessMermaidCode("Vec&#60;Item&#62;")).toBe("Vec#lt;Item#gt;");
  });

  it("does not double-escape existing #lt;/#gt;", () => {
    expect(preprocessMermaidCode("Channel#lt;AudioFrame#gt;")).toBe(
      "Channel#lt;AudioFrame#gt;",
    );
  });

  it("handles empty input", () => {
    expect(preprocessMermaidCode("")).toBe("");
  });

  it("handles full diagram with mixed cases", () => {
    const diagram = [
      "sequenceDiagram",
      "    participant App as App<br/>(DvrForm)",
      "    App->>Conv: Send<Data>",
      "    Conv-->>App: Vec&lt;Result&gt;",
    ].join("\n");
    const result = preprocessMermaidCode(diagram);
    expect(result).toContain("App<br/>(DvrForm)");
    expect(result).toContain("Send#lt;Data#gt;");
    expect(result).toContain("Vec#lt;Result#gt;");
    expect(result).toContain("App->>Conv");
  });
});

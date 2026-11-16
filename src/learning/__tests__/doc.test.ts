import { describe, expect, it } from "vitest";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { openAutomergeDoc } from "../../companion/automerge-doc";
import { createInMemoryLearningHub, fromCompanionDoc } from "../doc";
import { emptyLearningDocument } from "../protocol";

describe("learning document", () => {
  it("stores relayed text as one immutable value over Automerge, read back as a plain string", async () => {
    const { port1 } = new MessageChannel();
    const opened = await openAutomergeDoc({ network: [new MessageChannelNetworkAdapter(port1)], docUrl: null, storage: false, initial: emptyLearningDocument() });
    const { ImmutableString } = await import("@automerge/automerge-repo/slim");
    const doc = fromCompanionDoc(opened.doc, ImmutableString);
    expect(doc.text("x")).toBeInstanceOf(ImmutableString);
    doc.change((d) => { d.results.a1 = doc.text('{"body":1}'); });
    expect(doc.read().results.a1).toBe('{"body":1}');
    doc.close();
    port1.close();
  });

  it("keeps text as is in memory", () => {
    const peer = createInMemoryLearningHub().peer();
    expect(peer.text("x")).toBe("x");
  });
});

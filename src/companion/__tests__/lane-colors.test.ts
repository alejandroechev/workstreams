import { describe, it, expect } from "vitest";
import { laneColor as sidebarLaneColor } from "../../domain/work-lanes";
import { laneColor as protocolLaneColor } from "../protocol";

/**
 * The protocol module is copied into the phone app, so it cannot import the
 * sidebar's colour function; it carries its own copy. This keeps the copy
 * honest: a lane must be the same colour on the laptop and on the phone.
 */
describe("lane colours on the phone match the sidebar", () => {
  it("for no lane and for many lane ids", () => {
    const ids = [null, undefined, "", "a", "lane-1", "Ünïcødé", "f3b0c2d4-1111-4a2b-9c3d-0123456789ab"];
    for (let i = 0; i < 200; i += 1) ids.push(`${i}-${Math.random().toString(36).slice(2)}`);
    for (const id of ids) expect(protocolLaneColor(id), String(id)).toBe(sidebarLaneColor(id));
  });
});

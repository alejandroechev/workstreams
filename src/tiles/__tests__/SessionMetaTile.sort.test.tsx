import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendProvider } from "../../backend/context";
import type { Backend } from "../../backend/types";
import type { CopilotConfigItem } from "../../domain/types";
import SessionMetaTile from "../SessionMetaTile";
import { __setPlatformOverrideForTests } from "../../domain/platform";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

const STATE_ROOT = "C:\\Users\\me\\.copilot\\session-state\\session-1";

function item(name: string, category: string): CopilotConfigItem {
  return { name, category, source: "user", path: `C:\\c\\${name}`, description: null };
}

function createBackend(items: CopilotConfigItem[]): Backend {
  return {
    discoverCopilotConfig: vi.fn().mockResolvedValue(items),
    listDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(""),
  } as unknown as Backend;
}

beforeEach(() => {
  __setPlatformOverrideForTests("windows");
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => {
    if (command === "session_state_dir") return Promise.resolve(STATE_ROOT);
    if (command === "watch_directory" || command === "unwatch_directory") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected invoke ${command}`));
  });
  listenMock.mockResolvedValue(vi.fn());
});

afterEach(() => {
  __setPlatformOverrideForTests(null);
  cleanup();
  vi.clearAllMocks();
});

describe("SessionMetaTile config ordering", () => {
  it("renders skills alphabetically (case-insensitive) while keeping category order", async () => {
    const unsorted = [
      item("zeta-skill", "skill"),
      item("Alpha-skill", "skill"),
      item("beta-skill", "skill"),
      item("Gamma-skill", "skill"),
      item("some-extension", "extension"),
    ];
    render(
      <BackendProvider backend={createBackend(unsorted)}>
        <SessionMetaTile
          tileId="meta"
          isFocused={false}
          workstreamDir="C:\\repo"
          linkedSessionIds={["session-1"]}
        />
      </BackendProvider>,
    );

    await screen.findByText("Alpha-skill");
    const text = document.body.textContent ?? "";
    const order = ["Alpha-skill", "beta-skill", "Gamma-skill", "zeta-skill"].map((n) => text.indexOf(n));
    expect(order.every((v) => v >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(text.indexOf("Skills")).toBeLessThan(text.indexOf("Extensions"));
  });
});

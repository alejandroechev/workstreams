import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

// Mock invoke so the SQLite write path is a no-op in tests; cache state still
// updates synchronously via setAppSettings.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

import SettingsModal from "../SettingsModal";
import {
  _resetAppSettingsCacheForTests,
  getAppSettings,
  setAppSettings,
} from "../../domain/app-settings";

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.localStorage?.clear?.();
  _resetAppSettingsCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

import { afterEach } from "vitest";

const DEBOUNCE_MS = 300;

describe("SettingsModal", () => {
  it("returns null when closed", () => {
    const { container } = render(<SettingsModal open={false} onClose={() => {}} />);
    expect(container.querySelector("[data-testid=settings-modal]")).toBeNull();
  });

  it("renders current scroll speed and commits change after debounce", () => {
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("settings-tab-terminal"));
    const slider = screen.getByTestId("settings-scroll-speed") as HTMLInputElement;
    expect(parseFloat(slider.value)).toBe(getAppSettings().terminalScrollSpeed);
    fireEvent.change(slider, { target: { value: "1.5" } });
    // Local optimistic value updates immediately, but the global commit is
    // debounced. Cache value should NOT have changed yet.
    expect(getAppSettings().terminalScrollSpeed).not.toBe(1.5);
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(getAppSettings().terminalScrollSpeed).toBe(1.5);
  });

  it("renders three font inputs (text, markdown, terminal) and commits each", () => {
    render(<SettingsModal open onClose={() => {}} />);
    const textRange = screen.getByTestId("settings-font-text-range") as HTMLInputElement;
    const mdRange = screen.getByTestId("settings-font-markdown-range") as HTMLInputElement;
    const termRange = screen.getByTestId("settings-font-terminal-range") as HTMLInputElement;
    expect(parseInt(textRange.value, 10)).toBe(getAppSettings().textFontSize);
    expect(parseInt(mdRange.value, 10)).toBe(getAppSettings().markdownFontSize);
    expect(parseInt(termRange.value, 10)).toBe(getAppSettings().terminalFontSize);

    // Drive each input separately, advancing the debounce timer in between
    // so each commit lands. Mirrors a real user adjusting sliders one at a
    // time rather than batch-firing onChange synchronously.
    fireEvent.change(textRange, { target: { value: "17" } });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    expect(getAppSettings().textFontSize).toBe(17);

    fireEvent.change(mdRange, { target: { value: "18" } });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    expect(getAppSettings().markdownFontSize).toBe(18);

    fireEvent.change(termRange, { target: { value: "16" } });
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    expect(getAppSettings().terminalFontSize).toBe(16);
  });

  it("reset button restores defaults immediately (no debounce)", () => {
    setAppSettings({ terminalScrollSpeed: 2.4, textFontSize: 18, markdownFontSize: 20, terminalFontSize: 16 });
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("settings-reset"));
    expect(getAppSettings().terminalScrollSpeed).toBe(0.5);
    expect(getAppSettings().textFontSize).toBe(12);
    expect(getAppSettings().markdownFontSize).toBe(12);
    expect(getAppSettings().terminalFontSize).toBe(12);
  });

  it("toggles disable-WebGL and commits after debounce", () => {
    // Defaults to true (DOM renderer). Toggling turns GPU rendering back on.
    expect(getAppSettings().disableWebglRenderer).toBe(true);
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("settings-tab-rendering"));
    const checkbox = screen.getByTestId("settings-disable-webgl") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    // Debounced commit — cache not updated until the timer fires.
    expect(getAppSettings().disableWebglRenderer).toBe(true);
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    expect(getAppSettings().disableWebglRenderer).toBe(false);
  });

  it("close button fires onClose", () => {
    let closed = false;
    render(<SettingsModal open onClose={() => (closed = true)} />);
    fireEvent.click(screen.getByTestId("settings-modal-close"));
    expect(closed).toBe(true);
  });

  describe("tabs", () => {
    const TABS = [
      ["fonts", "Fonts", "settings-font-text-range"],
      ["terminal", "Terminal", "settings-scroll-speed"],
      ["copilot", "Copilot CLI", "settings-copilot-command"],
      ["devlog", "Devlog export", "settings-devlog-directory"],
      ["rendering", "Rendering", "settings-disable-webgl"],
      ["app", "App behavior", "settings-confirm-close"],
      ["companion", "Phone companion", "companion-settings"],
    ] as const;

    it("shows one tab per section, in order, with Fonts selected first", () => {
      render(<SettingsModal open onClose={() => {}} />);
      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual(TABS.map(([, label]) => label));
      expect(screen.getByTestId("settings-tab-fonts").getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("settings-tab-fonts");
    });

    it("renders only the selected section", async () => {
      render(<SettingsModal open onClose={() => {}} />);
      for (const [id, , control] of TABS) {
        fireEvent.click(screen.getByTestId(`settings-tab-${id}`));
        // The companion section loads its settings before rendering.
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByTestId(`settings-tab-${id}`).getAttribute("aria-selected")).toBe("true");
        expect(screen.queryByTestId(control)).not.toBeNull();
        for (const [, , other] of TABS) {
          if (other !== control) expect(screen.queryByTestId(other)).toBeNull();
        }
      }
    });

    it("moves between tabs with the arrow keys", () => {
      render(<SettingsModal open onClose={() => {}} />);
      fireEvent.keyDown(screen.getByTestId("settings-tab-fonts"), { key: "ArrowDown" });
      expect(screen.getByTestId("settings-tab-terminal").getAttribute("aria-selected")).toBe("true");
      fireEvent.keyDown(screen.getByTestId("settings-tab-terminal"), { key: "ArrowUp" });
      fireEvent.keyDown(screen.getByTestId("settings-tab-fonts"), { key: "ArrowUp" });
      expect(screen.getByTestId("settings-tab-companion").getAttribute("aria-selected")).toBe("true");
    });

    it("keeps Reset defaults reachable from every tab", () => {
      render(<SettingsModal open onClose={() => {}} />);
      for (const [id] of TABS) {
        fireEvent.click(screen.getByTestId(`settings-tab-${id}`));
        expect(screen.queryByTestId("settings-reset")).not.toBeNull();
      }
    });
  });
});


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
    expect(getAppSettings().textFontSize).toBe(13);
    expect(getAppSettings().markdownFontSize).toBe(14);
    expect(getAppSettings().terminalFontSize).toBe(14);
  });

  it("close button fires onClose", () => {
    let closed = false;
    render(<SettingsModal open onClose={() => (closed = true)} />);
    fireEvent.click(screen.getByTestId("settings-modal-close"));
    expect(closed).toBe(true);
  });

  it("no-verify blocking checkbox reflects current setting and toggles it", () => {
    render(<SettingsModal open onClose={() => {}} />);
    const cb = screen.getByTestId("settings-no-verify-blocking") as HTMLInputElement;
    expect(cb.checked).toBe(true); // default
    fireEvent.click(cb);
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    expect(getAppSettings().noVerifyBlockingEnabled).toBe(false);
    fireEvent.click(cb);
    act(() => vi.advanceTimersByTime(DEBOUNCE_MS));
    expect(getAppSettings().noVerifyBlockingEnabled).toBe(true);
  });
});

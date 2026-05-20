import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import SettingsModal from "../SettingsModal";
import {
  _resetAppSettingsCacheForTests,
  getAppSettings,
  setAppSettings,
} from "../../domain/app-settings";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  _resetAppSettingsCacheForTests();
});

describe("SettingsModal", () => {
  it("returns null when closed", () => {
    const { container } = render(<SettingsModal open={false} onClose={() => {}} />);
    expect(container.querySelector("[data-testid=settings-modal]")).toBeNull();
  });

  it("renders current scroll speed and updates on slider change", () => {
    render(<SettingsModal open onClose={() => {}} />);
    const slider = screen.getByTestId("settings-scroll-speed") as HTMLInputElement;
    expect(parseFloat(slider.value)).toBe(getAppSettings().terminalScrollSpeed);
    fireEvent.change(slider, { target: { value: "1.5" } });
    expect(getAppSettings().terminalScrollSpeed).toBe(1.5);
  });

  it("reset button restores defaults", () => {
    setAppSettings({ terminalScrollSpeed: 2.4 });
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("settings-reset"));
    expect(getAppSettings().terminalScrollSpeed).toBe(0.5);
  });

  it("close button fires onClose", () => {
    let closed = false;
    render(<SettingsModal open onClose={() => (closed = true)} />);
    fireEvent.click(screen.getByTestId("settings-modal-close"));
    expect(closed).toBe(true);
  });
});

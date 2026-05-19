import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import AudioPlayer from "../AudioPlayer";

// Stub Tauri opener plugin (used by the "open in system player" fallback).
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn().mockResolvedValue(undefined) }));

// AudioWaveform tries to decode the bytes with WebAudio. Stub it out so the
// jsdom environment doesn't blow up.
vi.mock("../AudioWaveform", () => ({
  AudioWaveform: () => null,
}));

describe("AudioPlayer", () => {
  afterEach(() => cleanup());

  const defaultProps = {
    url: "blob:fake-url",
    path: "C:\\music\\song.mp3",
    sizeBytes: 4_500_000,
  };

  it("renders the filename and size", () => {
    render(<AudioPlayer {...defaultProps} />);
    expect(screen.getByText("song.mp3")).toBeTruthy();
    expect(screen.getByTestId("audio-size").textContent).toBe("4.3 MB");
  });

  it("renders an <audio> element with the supplied url", () => {
    render(<AudioPlayer {...defaultProps} />);
    const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
    expect(audio.tagName).toBe("AUDIO");
    expect(audio.src).toBe("blob:fake-url");
    expect(audio.controls).toBe(true);
  });

  it("speed button cycles 1x → 1.5x → 2x → 1x", () => {
    render(<AudioPlayer {...defaultProps} />);
    const btn = screen.getByTestId("audio-speed-btn");
    expect(btn.textContent).toContain("1x");
    fireEvent.click(btn);
    expect(btn.textContent).toContain("1.5x");
    fireEvent.click(btn);
    expect(btn.textContent).toContain("2x");
    fireEvent.click(btn);
    expect(btn.textContent).toContain("1x");
  });

  it("speed button sets playbackRate on the audio element", () => {
    render(<AudioPlayer {...defaultProps} />);
    const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
    fireEvent.click(screen.getByTestId("audio-speed-btn")); // 1.5x
    expect(audio.playbackRate).toBe(1.5);
    fireEvent.click(screen.getByTestId("audio-speed-btn")); // 2x
    expect(audio.playbackRate).toBe(2);
  });

  it("loop button toggles the audio loop attribute and aria-pressed", () => {
    render(<AudioPlayer {...defaultProps} />);
    const btn = screen.getByTestId("audio-loop-btn");
    const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(audio.loop).toBe(false);
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(audio.loop).toBe(true);
    fireEvent.click(btn);
    expect(audio.loop).toBe(false);
  });

  it("Space toggles play/pause when focused", () => {
    render(<AudioPlayer {...defaultProps} isFocused />);
    const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
    const play = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
    Object.defineProperty(audio, "paused", { value: true, configurable: true });
    fireEvent.keyDown(window, { key: " " });
    expect(play).toHaveBeenCalled();
    Object.defineProperty(audio, "paused", { value: false, configurable: true });
    fireEvent.keyDown(window, { key: " " });
    expect(pause).toHaveBeenCalled();
  });

  it("ArrowRight seeks forward 5 seconds", () => {
    render(<AudioPlayer {...defaultProps} isFocused />);
    const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
    Object.defineProperty(audio, "currentTime", { value: 10, writable: true });
    Object.defineProperty(audio, "duration", { value: 60, configurable: true });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(audio.currentTime).toBe(15);
  });

  it("ArrowLeft seeks back 5 seconds and clamps to 0", () => {
    render(<AudioPlayer {...defaultProps} isFocused />);
    const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
    Object.defineProperty(audio, "currentTime", { value: 2, writable: true });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(audio.currentTime).toBe(0);
  });

  it("keyboard shortcuts are inactive when not focused", () => {
    render(<AudioPlayer {...defaultProps} />);
    const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
    const play = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    Object.defineProperty(audio, "paused", { value: true, configurable: true });
    fireEvent.keyDown(window, { key: " " });
    expect(play).not.toHaveBeenCalled();
  });

  it("does not hijack keys when focus is inside an input", () => {
    render(
      <div>
        <input data-testid="text" />
        <AudioPlayer {...defaultProps} isFocused />
      </div>,
    );
    const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
    const play = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    Object.defineProperty(audio, "paused", { value: true, configurable: true });
    const input = screen.getByTestId("text");
    input.focus();
    // Fire keydown with input as the target (simulates typing in the input).
    fireEvent.keyDown(input, { key: " " });
    expect(play).not.toHaveBeenCalled();
  });

  it("shows decode-error notice and system-player button on <audio> error", () => {
    render(<AudioPlayer {...defaultProps} />);
    const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
    fireEvent.error(audio);
    expect(screen.getByTestId("audio-decode-error")).toBeTruthy();
    expect(screen.getByTestId("audio-open-system")).toBeTruthy();
  });
});

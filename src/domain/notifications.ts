// @test-skip: Browser APIs (Notification, AudioContext) — covered by E2E
import { getCurrentWindow } from "@tauri-apps/api/window";

let audioCtx: AudioContext | null = null;

/** Play a short notification beep using Web Audio API */
export function playBell() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.frequency.value = 800;
    oscillator.type = "sine";
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 0.15);
  } catch { /* audio not available */ }
}

/** Flash the taskbar/window to get user attention */
export async function flashWindow() {
  try {
    const win = getCurrentWindow();
    // Request attention — flashes taskbar on Windows
    await win.requestUserAttention(2); // 2 = Informational
  } catch { /* ignore */ }
}

/** Notify the user that a session finished working */
export function notifySessionIdle(sessionName: string) {
  playBell();
  flashWindow();

  // Also try browser Notification API as fallback
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Copilot Session Idle", {
      body: `${sessionName} is waiting for input`,
      silent: true, // we already played our own sound
    });
  } else if ("Notification" in window && Notification.permission !== "denied") {
    Notification.requestPermission().catch(() => {});
  }
}

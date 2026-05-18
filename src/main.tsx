import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { BackendProvider } from "./backend/context";
import { TauriBackend } from "./backend/tauri-backend";
import { MemoryBackend } from "./backend/memory-backend";
import type { Backend } from "./backend/types";
import "@xterm/xterm/css/xterm.css";
import "./styles/theme.css";

// In E2E browser mode (Vite served without Tauri host), use MemoryBackend
// pre-seeded with a demo project so the create form has a Repo to pick.
const isE2E = import.meta.env.VITE_E2E === "1";

async function makeBackend(): Promise<Backend> {
  if (!isE2E) return new TauriBackend();
  const memory = new MemoryBackend();
  await memory.createProject("Demo", "C:\\repos\\demo", "#89b4fa");
  return memory;
}

const backend = await makeBackend();

if (isE2E && typeof window !== "undefined") {
  (window as unknown as { __WS_BACKEND__?: unknown }).__WS_BACKEND__ = backend;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BackendProvider backend={backend}>
      <App />
    </BackendProvider>
  </React.StrictMode>
);

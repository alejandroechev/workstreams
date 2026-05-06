import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { BackendProvider } from "./backend/context";
import { TauriBackend } from "./backend/tauri-backend";
import "@xterm/xterm/css/xterm.css";
import "./styles/theme.css";

const backend = new TauriBackend();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BackendProvider backend={backend}>
      <App />
    </BackendProvider>
  </React.StrictMode>
);

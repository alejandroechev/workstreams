/**
 * Singleton Workbench store backed by the Tauri settings table. This is
 * the production instance the dispatcher writes through. Tests can
 * substitute their own via {@link setWorkbenchStoreForDispatcher}.
 */
import { invoke } from "@tauri-apps/api/core";
import { createWorkbenchStore, type WorkbenchStore } from "./workbench-store";

export const workbenchStore: WorkbenchStore = createWorkbenchStore({
  getSetting: (key) => invoke<string | null>("get_setting", { key }),
  setSetting: (key, value) => invoke<void>("set_setting", { key, value }),
});

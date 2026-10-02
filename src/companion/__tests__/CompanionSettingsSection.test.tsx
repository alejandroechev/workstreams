import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { CompanionSettingsSection } from "../CompanionSettingsSection";
import { createMemorySettingsStore, loadCompanionSettings, type EnableDeps } from "../settings";
import { decodePairing } from "../protocol";

afterEach(cleanup);

const deps = (over: Partial<EnableDeps> = {}): EnableDeps => ({
  authRequired: vi.fn(async () => true),
  register: vi.fn(async () => ({ token: "jwt" })),
  createDocument: vi.fn(async () => "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh"),
  generateSecret: vi.fn(() => "s".repeat(43)),
  deviceName: "Workstreams on test",
  ...over,
});

describe("Phone companion settings", () => {
  it("is off by default and connects to nothing", async () => {
    const d = deps();
    render(<CompanionSettingsSection store={createMemorySettingsStore()} deps={d} />);
    expect(await screen.findByTestId("companion-enable")).toBeInTheDocument();
    expect(screen.queryByTestId("companion-qr")).not.toBeInTheDocument();
    expect(d.createDocument).not.toHaveBeenCalled();
    expect(d.authRequired).not.toHaveBeenCalled();
  });

  it("asks for the registration key, then shows a QR code carrying the pairing secret", async () => {
    const store = createMemorySettingsStore();
    render(<CompanionSettingsSection store={store} deps={deps()} />);
    fireEvent.click(await screen.findByTestId("companion-enable"));
    const key = await screen.findByTestId("companion-registration-key");
    fireEvent.change(key, { target: { value: "key" } });
    fireEvent.click(screen.getByTestId("companion-enable"));

    const qr = await screen.findByTestId("companion-qr");
    await waitFor(() => expect(qr.querySelector("svg")).not.toBeNull());
    const code = screen.getByTestId("companion-pairing-code") as HTMLInputElement;
    expect(decodePairing(code.value)).toEqual({ doc: "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh", secret: "s".repeat(43) });
    expect((await loadCompanionSettings(store)).enabled).toBe(true);
  });

  it("shows the server's reason when enabling fails", async () => {
    render(<CompanionSettingsSection store={createMemorySettingsStore()} deps={deps({ authRequired: vi.fn(async () => { throw new Error("Could not reach the sync server at https://x"); }) })} />);
    fireEvent.click(await screen.findByTestId("companion-enable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the sync server at https://x");
  });

  it("pairs a new phone only after confirmation, changing the secret", async () => {
    const store = createMemorySettingsStore({
      "companion.enabled": "1", "companion.doc_url": "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh", "companion.secret": "s".repeat(43),
    });
    const d = deps({ generateSecret: vi.fn(() => "n".repeat(43)) });
    render(<CompanionSettingsSection store={store} deps={d} />);
    fireEvent.click(await screen.findByTestId("companion-repair"));
    expect((await loadCompanionSettings(store)).secret).toBe("s".repeat(43));
    fireEvent.click(await screen.findByTestId("companion-repair-confirm"));
    await waitFor(async () => expect((await loadCompanionSettings(store)).secret).toBe("n".repeat(43)));
    const code = await screen.findByTestId("companion-pairing-code") as HTMLInputElement;
    await waitFor(() => expect(decodePairing(code.value)?.secret).toBe("n".repeat(43)));
  });

  it("can be turned off, and remembers the folder root", async () => {
    const store = createMemorySettingsStore({
      "companion.enabled": "1", "companion.doc_url": "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh", "companion.secret": "s".repeat(43),
    });
    render(<CompanionSettingsSection store={store} deps={deps()} />);
    const root = await screen.findByTestId("companion-folder-root");
    fireEvent.change(root, { target: { value: "~/Phone work" } });
    fireEvent.blur(root);
    await waitFor(async () => expect((await loadCompanionSettings(store)).folderRoot).toBe("~/Phone work"));
    fireEvent.click(screen.getByTestId("companion-disable"));
    await waitFor(async () => expect((await loadCompanionSettings(store)).enabled).toBe(false));
    expect(await screen.findByTestId("companion-enable")).toBeInTheDocument();
  });

  it.each([
    [{ state: "on" }, /connected/i],
    [{ state: "connecting" }, /connecting/i],
    [{ state: "dev-disabled" }, /development build/i],
    [{ state: "update-needed" }, /update Workstreams/i],
    [{ state: "error", error: "401 Unauthorized" }, /401 Unauthorized/],
  ] as const)("shows the service status %j while enabled", async (status, text) => {
    const store = createMemorySettingsStore({
      "companion.enabled": "1", "companion.doc_url": "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh", "companion.secret": "s".repeat(43),
    });
    render(<CompanionSettingsSection store={store} deps={deps()} status={status} />);
    expect(await screen.findByTestId("companion-status")).toHaveTextContent(text);
  });
});


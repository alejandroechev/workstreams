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
    expect(d.register).not.toHaveBeenCalled();
  });

  it("asks for the registration key, then shows a QR code carrying the pairing secret", async () => {
    const store = createMemorySettingsStore();
    render(<CompanionSettingsSection store={store} deps={deps()} />);
    // The server is asked up front, so the key field is there before the first click.
    const key = await screen.findByTestId("companion-registration-key");
    fireEvent.change(key, { target: { value: "key" } });
    fireEvent.click(screen.getByTestId("companion-enable"));

    const qr = await screen.findByTestId("companion-qr");
    await waitFor(() => expect(qr.querySelector("svg")).not.toBeNull());
    const code = screen.getByTestId("companion-pairing-code") as HTMLInputElement;
    expect(decodePairing(code.value)).toEqual({ doc: "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh", secret: "s".repeat(43) });
    expect((await loadCompanionSettings(store)).enabled).toBe(true);
  });

  it("enables in one click, with no key field, on a server without auth", async () => {
    const store = createMemorySettingsStore();
    const d = deps({ authRequired: vi.fn(async () => false) });
    render(<CompanionSettingsSection store={store} deps={d} />);
    await waitFor(() => expect(d.authRequired).toHaveBeenCalled());
    expect(screen.queryByTestId("companion-registration-key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("companion-enable"));
    expect(await screen.findByTestId("companion-qr")).toBeInTheDocument();
  });

  it("hides the key field once this laptop is registered with that server", async () => {
    const store = createMemorySettingsStore({ "companion.token": "jwt" });
    const d = deps();
    render(<CompanionSettingsSection store={store} deps={d} />);
    expect(await screen.findByTestId("companion-enable")).toBeInTheDocument();
    expect(screen.queryByTestId("companion-registration-key")).not.toBeInTheDocument();
    expect(d.authRequired).not.toHaveBeenCalled();
  });

  it("asks again when the server address changes", async () => {
    const d = deps({ authRequired: vi.fn(async (url: string) => url.includes("locked")) });
    render(<CompanionSettingsSection store={createMemorySettingsStore()} deps={d} />);
    await waitFor(() => expect(d.authRequired).toHaveBeenCalled());
    expect(screen.queryByTestId("companion-registration-key")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("companion-server"), { target: { value: "https://locked.example" } });
    expect(await screen.findByTestId("companion-registration-key")).toBeInTheDocument();
  });

  it("disables Enable until the key is typed when one is needed", async () => {
    render(<CompanionSettingsSection store={createMemorySettingsStore()} deps={deps()} />);
    await screen.findByTestId("companion-registration-key");
    expect(screen.getByTestId("companion-enable")).toBeDisabled();
    fireEvent.change(screen.getByTestId("companion-registration-key"), { target: { value: "k" } });
    expect(screen.getByTestId("companion-enable")).toBeEnabled();
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


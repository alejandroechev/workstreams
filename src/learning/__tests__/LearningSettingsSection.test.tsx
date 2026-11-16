import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LearningSettingsSection } from "../LearningSettingsSection";
import { createMemorySettingsStore, loadCompanionSettings } from "../../companion/settings";
import { loadLearningSettings, type SetUpDeps } from "../settings";
import { decodeLearningPairing } from "../protocol";

afterEach(cleanup);

const DOC = "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh";
const deps = (over: Partial<SetUpDeps> = {}): SetUpDeps => ({
  authRequired: vi.fn(async () => true),
  register: vi.fn(async () => ({ token: "jwt" })),
  createDocument: vi.fn(async () => DOC),
  deviceName: "Workstreams on test",
  ...over,
});
const COMPANION = {
  "companion.enabled": "1",
  "companion.server_url": "https://sync.example",
  "companion.token": "companion-jwt",
  "companion.doc_url": "automerge:companion",
  "companion.secret": "c".repeat(43),
};

describe("Rust Pocket settings", () => {
  it("connects to nothing until set up", async () => {
    const d = deps();
    render(<LearningSettingsSection store={createMemorySettingsStore(COMPANION)} deps={d} />);
    expect(await screen.findByTestId("learning-setup")).toBeInTheDocument();
    expect(screen.queryByTestId("learning-qr")).not.toBeInTheDocument();
    expect(d.createDocument).not.toHaveBeenCalled();
  });

  it("sets up with the companion's enrolment and shows its own pairing QR", async () => {
    const store = createMemorySettingsStore(COMPANION);
    render(<LearningSettingsSection store={store} deps={deps()} />);
    fireEvent.click(await screen.findByTestId("learning-setup"));
    const qr = await screen.findByTestId("learning-qr");
    await waitFor(() => expect(qr.querySelector("svg")).not.toBeNull());
    const code = decodeLearningPairing((screen.getByTestId("learning-pairing-code") as HTMLInputElement).value);
    expect(code).toMatchObject({ doc: DOC, server: "https://sync.example" });
    expect(code!.secret).not.toBe(COMPANION["companion.secret"]);
  });

  it("asks for a registration key when no enrolment can be reused", async () => {
    const store = createMemorySettingsStore();
    render(<LearningSettingsSection store={store} deps={deps()} />);
    fireEvent.click(await screen.findByTestId("learning-setup"));
    const key = await screen.findByTestId("learning-registration-key");
    fireEvent.change(key, { target: { value: "k" } });
    fireEvent.click(screen.getByTestId("learning-setup"));
    expect(await screen.findByTestId("learning-qr")).toBeInTheDocument();
  });

  it("shows a setup error", async () => {
    render(<LearningSettingsSection store={createMemorySettingsStore(COMPANION)} deps={deps({ createDocument: async () => { throw new Error("offline"); } })} />);
    fireEvent.click(await screen.findByTestId("learning-setup"));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  });

  it("unpairs and pairs again without touching the companion", async () => {
    const store = createMemorySettingsStore({ ...COMPANION, "learning.server_url": "https://sync.example", "learning.doc_url": DOC, "learning.secret": "a".repeat(64) });
    render(<LearningSettingsSection store={store} deps={deps()} />);
    fireEvent.click(await screen.findByTestId("learning-unpair"));
    fireEvent.click(await screen.findByTestId("learning-unpair-confirm"));
    expect(await screen.findByTestId("learning-pair")).toBeInTheDocument();
    expect(screen.queryByTestId("learning-qr")).not.toBeInTheDocument();
    expect((await loadLearningSettings(store)).secret).toBe("");
    expect(await loadCompanionSettings(store)).toMatchObject({ enabled: true, secret: COMPANION["companion.secret"] });

    fireEvent.click(screen.getByTestId("learning-pair"));
    expect(await screen.findByTestId("learning-qr")).toBeInTheDocument();
    const secret = (await loadLearningSettings(store)).secret;
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(secret).not.toBe("a".repeat(64));
  });

  it("shows the service's status while paired", async () => {
    const store = createMemorySettingsStore({ "learning.doc_url": DOC, "learning.secret": "a".repeat(64) });
    render(<LearningSettingsSection store={store} deps={deps()} status="Connected." />);
    expect(await screen.findByTestId("learning-status")).toHaveTextContent("Connected.");
  });

  it("cancels an unpair", async () => {
    const store = createMemorySettingsStore({ "learning.doc_url": DOC, "learning.secret": "a".repeat(64) });
    render(<LearningSettingsSection store={store} deps={deps()} />);
    fireEvent.click(await screen.findByTestId("learning-unpair"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByTestId("learning-qr")).toBeInTheDocument();
    expect((await loadLearningSettings(store)).secret).toBe("a".repeat(64));
  });
});

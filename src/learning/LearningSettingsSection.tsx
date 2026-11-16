import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { AcademicCapIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import { tauriSettingsStore, type SettingsStore } from "../companion/settings";
import { syncAuthRequired, registerSyncDevice, syncServerUrls } from "../companion/sync-server";
import { openAutomergeDoc } from "../companion/automerge-doc";
import { encodeLearningPairing, emptyLearningDocument } from "./protocol";
import { getLearningStatus, learningStatusText, onLearningStatus } from "./service";
import {
  loadLearningSettings,
  onLearningSettingsChanged,
  pairLearning,
  setUpLearning,
  unpairLearning,
  type LearningSettings,
  type SetUpDeps,
} from "./settings";

export const realSetUpDeps: SetUpDeps = {
  authRequired: (serverUrl) => syncAuthRequired(syncServerUrls(serverUrl, null).http),
  register: (serverUrl, deviceName, key) => registerSyncDevice(syncServerUrls(serverUrl, null).http, deviceName, key),
  async createDocument({ serverUrl, token }) {
    const { doc, url, flush } = await openAutomergeDoc({
      docUrl: null,
      wsUrl: syncServerUrls(serverUrl, token || null).ws,
      storage: true,
      waitForNetworkMs: 15_000,
      initial: emptyLearningDocument(),
    });
    await flush();
    doc.close();
    return url;
  },
  deviceName: "Workstreams laptop",
};

const inputStyle: React.CSSProperties = {
  width: "100%", background: "#11111b", color: "#cdd6f4", border: "1px solid #313244",
  borderRadius: 3, padding: "4px 6px", fontFamily: "monospace", fontSize: 12, boxSizing: "border-box",
};
const buttonStyle: React.CSSProperties = {
  background: "#313244", color: "#cdd6f4", border: "1px solid #45475a", borderRadius: 3,
  padding: "4px 10px", fontSize: 12, cursor: "pointer",
};
const helpStyle: React.CSSProperties = { marginTop: 4, fontSize: 11, color: "#6c7086" };

/**
 * Settings section for Rust Pocket (ADR 042): its own pairing, next to the
 * companion's and independent of it.
 */
export function LearningSettingsSection({
  store = tauriSettingsStore,
  deps = realSetUpDeps,
  status: statusOverride,
}: {
  store?: SettingsStore;
  deps?: SetUpDeps;
  /** For tests; otherwise the running service's state, shown when paired. */
  status?: string;
}) {
  const [liveStatus, setLiveStatus] = useState(getLearningStatus);
  useEffect(() => onLearningStatus(setLiveStatus), []);
  const status = statusOverride ?? learningStatusText(liveStatus);
  const [settings, setSettings] = useState<LearningSettings | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [registrationKey, setRegistrationKey] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"unpair" | "repair" | null>(null);
  const [qr, setQr] = useState<{ code: string; svg: string } | null>(null);

  const apply = useCallback((loaded: LearningSettings) => {
    setSettings(loaded);
    setServerUrl(loaded.serverUrl);
  }, []);
  const reload = useCallback(async () => apply(await loadLearningSettings(store)), [apply, store]);
  useEffect(() => {
    let cancelled = false;
    void loadLearningSettings(store).then((loaded) => { if (!cancelled) apply(loaded); });
    return () => { cancelled = true; };
  }, [apply, store]);
  useEffect(() => onLearningSettingsChanged(setSettings), []);

  const pairingCode = settings?.docUrl && settings.secret
    ? encodeLearningPairing({ doc: settings.docUrl, secret: settings.secret, server: settings.serverUrl })
    : null;
  useEffect(() => {
    if (!pairingCode) return;
    let cancelled = false;
    void QRCode.toString(pairingCode, { type: "svg", margin: 1, color: { dark: "#11111b", light: "#cdd6f4" } })
      .then((svg) => { if (!cancelled) setQr({ code: pairingCode, svg }); });
    return () => { cancelled = true; };
  }, [pairingCode]);
  const qrSvg = qr && qr.code === pairingCode ? qr.svg : null;

  const setUp = async () => {
    setBusy(true);
    setError(null);
    const result = await setUpLearning(store, deps, { serverUrl, registrationKey: registrationKey || undefined });
    setBusy(false);
    if (!result.ok) {
      setNeedsKey(Boolean(result.needsRegistrationKey));
      setError(result.needsRegistrationKey ? null : result.error);
      return;
    }
    setRegistrationKey("");
    setNeedsKey(false);
    await reload();
  };
  const act = (action: (store: SettingsStore) => Promise<void>) => async () => {
    await action(store);
    setConfirm(null);
    await reload();
  };

  if (!settings) return null;

  return (
    <div data-testid="learning-settings" style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid #313244" }}>
      <div style={{ fontSize: 11, color: "#89b4fa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5, display: "flex", alignItems: "center", gap: 6 }}>
        <AcademicCapIcon style={{ width: 13, height: 13 }} />
        Rust Pocket
      </div>

      {!settings.docUrl ? (
        <>
          <div style={{ ...helpStyle, marginTop: 0, marginBottom: 8 }}>
            Lets the Rust Pocket app check your answers with the real Rust compiler on this Mac, and ask
            Copilot for hints with no tools. It pairs with its own key, separate from the phone companion.
          </div>
          <label htmlFor="learning-server" style={{ display: "block", marginBottom: 4 }}>Sync server</label>
          <input id="learning-server" data-testid="learning-server" type="text" value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)} spellCheck={false} style={inputStyle} />
          {needsKey && (
            <>
              <label htmlFor="learning-key" style={{ display: "block", margin: "8px 0 4px" }}>Registration key</label>
              <input id="learning-key" data-testid="learning-registration-key" type="password" value={registrationKey}
                onChange={(e) => setRegistrationKey(e.target.value)} style={inputStyle} />
              <div style={helpStyle}>This server needs its registration key once, to enrol this laptop. The key is not stored.</div>
            </>
          )}
          <button data-testid="learning-setup" disabled={busy || (needsKey && registrationKey.trim() === "")}
            onClick={() => void setUp()} style={{ ...buttonStyle, marginTop: 10 }}>
            {busy ? "Setting up…" : "Set up Rust Pocket"}
          </button>
        </>
      ) : !settings.secret ? (
        <>
          <div style={{ ...helpStyle, marginTop: 0, marginBottom: 8 }}>Not paired. No phone can send checks to this Mac.</div>
          <button data-testid="learning-pair" onClick={() => void act(pairLearning)()} style={buttonStyle}>Pair Rust Pocket</button>
        </>
      ) : (
        <>
          <div data-testid="learning-status" style={{ marginBottom: 10, fontSize: 12, color: "#a6adc8" }}>{status}</div>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div data-testid="learning-qr" role="img" aria-label="Rust Pocket pairing QR code"
              style={{ width: 160, height: 160, flexShrink: 0, background: "#cdd6f4", borderRadius: 4 }}
              dangerouslySetInnerHTML={qrSvg ? { __html: qrSvg } : undefined} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ marginBottom: 6 }}>Scan this in Rust Pocket's settings to pair it.</div>
              <label htmlFor="learning-code" style={{ display: "block", fontSize: 11, color: "#6c7086", marginBottom: 2 }}>
                Can't scan? Paste this pairing code instead:
              </label>
              <input id="learning-code" data-testid="learning-pairing-code" readOnly value={pairingCode ?? ""}
                onFocus={(e) => e.currentTarget.select()} style={inputStyle} />
              <div style={helpStyle}>Whoever holds it can run Rust code on this Mac. It cannot drive the phone companion.</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            {confirm ? (
              <>
                <span style={{ color: "#f9e2af", fontSize: 12 }}>
                  {confirm === "unpair" ? "Rust Pocket will stop reaching this Mac." : "The current phone will stop working until it scans the new code."}
                </span>
                <button data-testid={`learning-${confirm}-confirm`} style={buttonStyle}
                  onClick={() => void act(confirm === "unpair" ? unpairLearning : pairLearning)()}>
                  {confirm === "unpair" ? "Unpair" : "Pair a new phone"}
                </button>
                <button onClick={() => setConfirm(null)} style={buttonStyle}>Cancel</button>
              </>
            ) : (
              <>
                <button data-testid="learning-repair" onClick={() => setConfirm("repair")} style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <ArrowPathIcon style={{ width: 12, height: 12 }} />
                  Pair a new phone…
                </button>
                <button data-testid="learning-unpair" onClick={() => setConfirm("unpair")} style={buttonStyle}>Unpair…</button>
              </>
            )}
          </div>
        </>
      )}

      {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: "#f38ba8" }}>{error}</div>}
    </div>
  );
}

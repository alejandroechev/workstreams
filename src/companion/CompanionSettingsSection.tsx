import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { DevicePhoneMobileIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  disableCompanion,
  enableCompanion,
  loadCompanionSettings,
  repairPhone,
  saveCompanionSettings,
  tauriSettingsStore,
  type CompanionSettings,
  type EnableDeps,
  type SettingsStore,
} from "./settings";
import { encodePairing, generateSecret } from "./protocol";
import { registerSyncDevice, syncAuthRequired, syncServerUrls } from "./sync-server";
import { openAutomergeDoc } from "./automerge-doc";

/** The real dependencies: the SyncEngine server and Automerge. */
export const realEnableDeps: EnableDeps = {
  authRequired: (serverUrl) => syncAuthRequired(syncServerUrls(serverUrl, null).http),
  register: (serverUrl, deviceName, key) => registerSyncDevice(syncServerUrls(serverUrl, null).http, deviceName, key),
  async createDocument({ serverUrl, token }) {
    const { doc, url } = await openAutomergeDoc({ docUrl: null, wsUrl: syncServerUrls(serverUrl, token || null).ws, storage: true });
    doc.close();
    return url;
  },
  generateSecret,
  deviceName: "Workstreams laptop",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#11111b",
  color: "#cdd6f4",
  border: "1px solid #313244",
  borderRadius: 3,
  padding: "4px 6px",
  fontFamily: "monospace",
  fontSize: 12,
  boxSizing: "border-box",
};
const buttonStyle: React.CSSProperties = {
  background: "#313244",
  color: "#cdd6f4",
  border: "1px solid #45475a",
  borderRadius: 3,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
};
const helpStyle: React.CSSProperties = { marginTop: 4, fontSize: 11, color: "#6c7086" };

/**
 * Settings section for the phone companion (ADR 033). Off by default; nothing
 * connects until the user enables it here.
 */
export function CompanionSettingsSection({
  store = tauriSettingsStore,
  deps = realEnableDeps,
}: {
  store?: SettingsStore;
  deps?: EnableDeps;
}) {
  const [settings, setSettings] = useState<CompanionSettings | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [registrationKey, setRegistrationKey] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [folderRoot, setFolderRoot] = useState("");
  const [qrSvg, setQrSvg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const loaded = await loadCompanionSettings(store);
    setSettings(loaded);
    setServerUrl(loaded.serverUrl);
    setFolderRoot(loaded.folderRoot);
  }, [store]);
  useEffect(() => { void reload(); }, [reload]);

  const pairingCode = settings?.enabled && settings.docUrl && settings.secret
    ? encodePairing({ doc: settings.docUrl, secret: settings.secret })
    : null;
  useEffect(() => {
    if (!pairingCode) { setQrSvg(null); return; }
    let cancelled = false;
    void QRCode.toString(pairingCode, { type: "svg", margin: 1, color: { dark: "#11111b", light: "#cdd6f4" } })
      .then((svg) => { if (!cancelled) setQrSvg(svg); });
    return () => { cancelled = true; };
  }, [pairingCode]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    const result = await enableCompanion(store, deps, { serverUrl, registrationKey: registrationKey || undefined });
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

  if (!settings) return null;

  return (
    <div data-testid="companion-settings">
      <div style={{ fontSize: 11, color: "#89b4fa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5, display: "flex", alignItems: "center", gap: 6 }}>
        <DevicePhoneMobileIcon style={{ width: 13, height: 13 }} />
        Phone companion
      </div>

      {!settings.enabled ? (
        <>
          <div style={{ ...helpStyle, marginTop: 0, marginBottom: 8 }}>
            Lets your paired phone see your workstreams, load them, create new ones and start Copilot
            sessions, through your sync server. Off until you enable it. Only requests signed by the
            phone you pair are ever run.
          </div>
          <label htmlFor="companion-server" style={{ display: "block", marginBottom: 4 }}>Sync server</label>
          <input
            id="companion-server"
            data-testid="companion-server"
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            spellCheck={false}
            style={inputStyle}
          />
          {needsKey && (
            <>
              <label htmlFor="companion-key" style={{ display: "block", margin: "8px 0 4px" }}>Registration key</label>
              <input
                id="companion-key"
                data-testid="companion-registration-key"
                type="password"
                value={registrationKey}
                onChange={(e) => setRegistrationKey(e.target.value)}
                style={inputStyle}
              />
              <div style={helpStyle}>Needed once, to enrol this laptop with the sync server. It is not stored.</div>
            </>
          )}
          <button
            data-testid="companion-enable"
            disabled={busy}
            onClick={() => void enable()}
            style={{ ...buttonStyle, marginTop: 10 }}
          >
            {busy ? "Enabling…" : "Enable phone companion"}
          </button>
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div
              data-testid="companion-qr"
              role="img"
              aria-label="Pairing QR code"
              style={{ width: 160, height: 160, flexShrink: 0, background: "#cdd6f4", borderRadius: 4 }}
              dangerouslySetInnerHTML={qrSvg ? { __html: qrSvg } : undefined}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ marginBottom: 6 }}>Scan this with the companion app to pair your phone.</div>
              <label htmlFor="companion-code" style={{ display: "block", fontSize: 11, color: "#6c7086", marginBottom: 2 }}>
                Can't scan? Paste this pairing code instead:
              </label>
              <input
                id="companion-code"
                data-testid="companion-pairing-code"
                readOnly
                value={pairingCode ?? ""}
                onFocus={(e) => e.currentTarget.select()}
                style={inputStyle}
              />
              <div style={helpStyle}>Treat it like a password: whoever holds it can start agents on this laptop.</div>
            </div>
          </div>

          <label htmlFor="companion-folder-root" style={{ display: "block", margin: "12px 0 4px" }}>
            Folder for workstreams created from the phone
          </label>
          <input
            id="companion-folder-root"
            data-testid="companion-folder-root"
            type="text"
            value={folderRoot}
            onChange={(e) => setFolderRoot(e.target.value)}
            onBlur={() => void saveCompanionSettings(store, { folderRoot: folderRoot.trim() || "~/Workstreams" }).then(reload)}
            spellCheck={false}
            style={inputStyle}
          />
          <div style={helpStyle}>Each new workstream gets its own empty folder here.</div>

          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            {confirmRepair ? (
              <>
                <span style={{ color: "#f9e2af", fontSize: 12 }}>The current phone will stop working until it scans the new code.</span>
                <button
                  data-testid="companion-repair-confirm"
                  onClick={() => void repairPhone(store, deps.generateSecret).then(() => { setConfirmRepair(false); return reload(); })}
                  style={buttonStyle}
                >
                  Pair a new phone
                </button>
                <button onClick={() => setConfirmRepair(false)} style={buttonStyle}>Cancel</button>
              </>
            ) : (
              <button data-testid="companion-repair" onClick={() => setConfirmRepair(true)} style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <ArrowPathIcon style={{ width: 12, height: 12 }} />
                Pair a new phone…
              </button>
            )}
            <button
              data-testid="companion-disable"
              onClick={() => void disableCompanion(store).then(reload)}
              style={buttonStyle}
            >
              Turn off
            </button>
          </div>
        </>
      )}

      {error && (
        <div role="alert" style={{ marginTop: 8, fontSize: 12, color: "#f38ba8" }}>{error}</div>
      )}
    </div>
  );
}

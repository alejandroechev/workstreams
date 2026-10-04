/** SyncEngine server addressing and device registration (ADR 033). */

export function syncServerUrls(base: string, token: string | null): { http: string; ws: string } {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`Not a valid sync server URL: ${base}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`The sync server URL must start with http:// or https://, not ${url.protocol}`);
  }
  const http = `${url.protocol}//${url.host}`;
  const ws = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  return { http, ws };
}

/** Whether the server needs a device token at all (local servers often don't). */
export async function syncAuthRequired(http: string): Promise<boolean> {
  const response = await fetch(`${http}/health`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`The sync server at ${http} answered ${response.status}`);
  const health = (await response.json()) as { authEnabled?: boolean };
  return health.authEnabled === true;
}

/** Enrols this machine with the server's registration key; returns its token. */
export async function registerSyncDevice(
  http: string,
  deviceName: string,
  registrationKey: string,
): Promise<{ token: string; deviceId: string }> {
  // A transport failure's own message ("Load failed") names neither the
  // server nor the cause, so it is reported with the address.
  const response = await fetch(`${http}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName, registrationKey }),
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
  if (response instanceof Error) {
    throw new Error(`Could not reach the sync server at ${http}: ${response.message}`);
  }
  // SyncEngine answers 201 with `{ jwt, deviceId }` (server/src/auth.ts).
  const body = (await response.json().catch(() => ({}))) as { jwt?: string; deviceId?: string; error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `The sync server at ${http} refused registration (${response.status})`);
  }
  if (typeof body.jwt !== "string" || body.jwt === "") {
    throw new Error(`The sync server at ${http} accepted the registration but returned no token`);
  }
  return { token: body.jwt, deviceId: body.deviceId ?? "" };
}

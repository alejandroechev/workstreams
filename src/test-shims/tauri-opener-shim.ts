// @test-skip: Browser shim; it only records what would have been opened.
type InvokeLog = Array<{ cmd: string; args: Record<string, unknown> }>;

/** Logged like an invoke, so E2E specs can assert which URL a click opened. */
export async function openUrl(url: string): Promise<void> {
  const w = window as unknown as { __WS_INVOKE_LOG__?: InvokeLog };
  if (!w.__WS_INVOKE_LOG__) w.__WS_INVOKE_LOG__ = [];
  w.__WS_INVOKE_LOG__.push({ cmd: "open_url", args: { url } });
}
export async function openPath(_path: string): Promise<void> {}
export async function revealItemInDir(_path: string | string[]): Promise<void> {}

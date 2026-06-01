// @test-skip: Browser shim; no-ops only.
export function getCurrentWindow() {
  return {
    onCloseRequested: async (_handler: unknown): Promise<() => void> => () => {},
    destroy: async (): Promise<void> => {},
    requestUserAttention: async (_kind?: unknown): Promise<void> => {},
    isFocused: async (): Promise<boolean> => true,
    setFocus: async (): Promise<void> => {},
  };
}

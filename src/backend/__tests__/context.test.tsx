import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { ReactNode } from "react";
import { BackendProvider, useBackend } from "../context";
import { MemoryBackend } from "../memory-backend";

describe("BackendContext", () => {
  it("useBackend returns provided backend", () => {
    const backend = new MemoryBackend();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <BackendProvider backend={backend}>{children}</BackendProvider>
    );
    const { result } = renderHook(() => useBackend(), { wrapper });
    expect(result.current).toBe(backend);
  });

  it("useBackend throws when used outside provider", () => {
    expect(() => {
      renderHook(() => useBackend());
    }).toThrow(/useBackend must be used within a BackendProvider/);
  });
});

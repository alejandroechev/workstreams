import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { BackendProvider } from "../../backend/context";
import { MemoryBackend } from "../../backend/memory-backend";
import { RepoContentSearch } from "../RepoContentSearch";

function renderWith(backend: MemoryBackend, onOpenMatch = vi.fn()) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <BackendProvider backend={backend}>{children}</BackendProvider>;
  }
  const utils = render(
    <RepoContentSearch
      currentDir="/repo"
      onOpenMatch={onOpenMatch}
      options={{ debounceMs: 5, minLength: 2, limit: 1000 }}
    />,
    { wrapper: Wrapper },
  );
  return { ...utils, onOpenMatch };
}

function type(text: string) {
  const input = screen.getByTestId("content-search-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
}

describe("RepoContentSearch", () => {
  it("renders an input and an empty prompt before searching", () => {
    renderWith(new MemoryBackend());
    expect(screen.getByTestId("content-search-input")).toBeInTheDocument();
  });

  it("renders matches grouped by file with relative path + count", async () => {
    const backend = new MemoryBackend();
    backend.seedFile("/repo/src/a.ts", "needle one\nplain\nneedle two");
    backend.seedFile("/repo/b.ts", "needle three");
    renderWith(backend);
    type("needle");

    await waitFor(() => expect(screen.getByTestId("content-search-group-src/a.ts")).toBeInTheDocument());
    expect(screen.getByTestId("content-search-group-b.ts")).toBeInTheDocument();
    // a.ts has 2 matches
    expect(screen.getByTestId("content-search-group-src/a.ts")).toHaveTextContent("2");
  });

  it("highlights the matched substring within a result line", async () => {
    const backend = new MemoryBackend();
    backend.seedFile("/repo/a.ts", "a needle b");
    const { container } = renderWith(backend);
    type("needle");
    await waitFor(() => expect(container.querySelector("mark")).toBeInTheDocument());
    expect(container.querySelector("mark")).toHaveTextContent("needle");
  });

  it("calls onOpenMatch with path + line when a result row is clicked", async () => {
    const backend = new MemoryBackend();
    backend.seedFile("/repo/a.ts", "x\nneedle here");
    const onOpenMatch = vi.fn();
    renderWith(backend, onOpenMatch);
    type("needle");
    await waitFor(() => expect(screen.getByTestId("content-search-match-/repo/a.ts-2")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("content-search-match-/repo/a.ts-2"));
    expect(onOpenMatch).toHaveBeenCalledWith("/repo/a.ts", 2);
  });

  it("opens the selected match on Enter and navigates with arrows", async () => {
    const backend = new MemoryBackend();
    backend.seedFile("/repo/a.ts", "needle 1\nneedle 2");
    const onOpenMatch = vi.fn();
    renderWith(backend, onOpenMatch);
    type("needle");
    await waitFor(() => expect(screen.getByTestId("content-search-match-/repo/a.ts-2")).toBeInTheDocument());
    const input = screen.getByTestId("content-search-input");
    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" }); // move to second match
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onOpenMatch).toHaveBeenCalledWith("/repo/a.ts", 2);
  });

  it("shows a truncated indicator when results are capped", async () => {
    const backend = new MemoryBackend();
    backend.seedFile("/repo/a.ts", "needle\nneedle\nneedle");
    function Wrapper({ children }: { children: ReactNode }) {
      return <BackendProvider backend={backend}>{children}</BackendProvider>;
    }
    render(
      <RepoContentSearch
        currentDir="/repo"
        onOpenMatch={vi.fn()}
        options={{ debounceMs: 5, minLength: 2, limit: 3 }}
      />,
      { wrapper: Wrapper },
    );
    type("needle");
    await waitFor(() => expect(screen.getByTestId("content-search-truncated")).toBeInTheDocument());
  });

  it("shows a no-results message when nothing matches", async () => {
    const backend = new MemoryBackend();
    backend.seedFile("/repo/a.ts", "nothing here");
    renderWith(backend);
    type("zzzzz");
    await waitFor(() => expect(screen.getByTestId("content-search-empty")).toBeInTheDocument());
  });
});

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PipelinesModal } from "../PipelinesModal";
import type { PipelineStatus } from "../../domain/pipeline-inbox";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

const pipeline = (over: Partial<PipelineStatus> = {}): PipelineStatus => ({
  id: "p1", organization: "skype", project: "SCC", definition_id: 33995, name: "Agency NgcServer Update",
  url: "https://dev.azure.com/skype/SCC/_build?definitionId=33995", mode: "both",
  last_result: "failed", last_run_number: "81724709", last_run_url: "https://dev.azure.com/skype/SCC/_build/results?buildId=81724709",
  last_finished_at: "2026-10-26T08:10:44Z", last_checked: "2026-10-26T09:00:00Z", error: null, ...over,
});

function setup(pipelines: PipelineStatus[] = [pipeline()], overrides: Partial<React.ComponentProps<typeof PipelinesModal>> = {}) {
  const props = {
    pipelines,
    onAdd: vi.fn().mockResolvedValue(undefined),
    onSetMode: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<PipelinesModal {...props} />);
  return props;
}

describe("Pipelines manager", () => {
  it("lists each pipeline with its project, mode, last result and error", () => {
    setup([pipeline(), pipeline({ id: "p2", name: "watchdog", mode: "off", last_result: null, last_run_number: null, last_run_url: null, error: "ADO access denied." })]);
    expect(screen.getByRole("dialog", { name: "Pipelines" })).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-row-p1")).toHaveTextContent("Agency NgcServer Update");
    expect(screen.getByTestId("pipeline-row-p1")).toHaveTextContent("SCC");
    expect(screen.getByTestId("pipeline-mode-p1")).toHaveValue("both");
    expect(screen.getByTestId("pipeline-last-p1")).toHaveTextContent("Failed · #81724709");
    expect(screen.getByTestId("pipeline-last-p2")).toHaveTextContent("No finished runs yet");
    expect(screen.getByTestId("pipeline-error-p2")).toHaveTextContent("ADO access denied.");
    expect(screen.queryByTestId("pipeline-error-p1")).toBeNull();
  });

  it("adds a pasted link, clears the field, and shows a refusal without clearing it", async () => {
    const props = setup();
    const input = screen.getByTestId("pipeline-url-input");
    expect(screen.getByTestId("pipeline-add")).toBeDisabled();
    fireEvent.change(input, { target: { value: "https://dev.azure.com/skype/SCC/_build/results?buildId=1" } });
    fireEvent.click(screen.getByTestId("pipeline-add"));
    await waitFor(() => expect(props.onAdd).toHaveBeenCalledWith("https://dev.azure.com/skype/SCC/_build/results?buildId=1"));
    await waitFor(() => expect(input).toHaveValue(""));

    vi.mocked(props.onAdd).mockRejectedValueOnce(new Error("Already watching “Agency NgcServer Update”."));
    fireEvent.change(input, { target: { value: "https://x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByTestId("pipeline-add-error")).toHaveTextContent("Already watching");
    expect(input).toHaveValue("https://x");
  });

  it("changes the mode, removes, opens the pipeline and its last run", async () => {
    const props = setup();
    fireEvent.change(screen.getByTestId("pipeline-mode-p1"), { target: { value: "off" } });
    await waitFor(() => expect(props.onSetMode).toHaveBeenCalledWith("p1", "off"));
    fireEvent.click(screen.getByTestId("pipeline-open-p1"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://dev.azure.com/skype/SCC/_build?definitionId=33995"));
    fireEvent.click(screen.getByTestId("pipeline-last-p1"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://dev.azure.com/skype/SCC/_build/results?buildId=81724709"));
    fireEvent.click(screen.getByTestId("pipeline-remove-p1"));
    await waitFor(() => expect(props.onRemove).toHaveBeenCalledWith("p1"));
  });

  it("shows an empty state, and closes on Escape and on the backdrop", () => {
    const props = setup([]);
    expect(screen.getByTestId("pipelines-empty")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("pipelines-backdrop"));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("shows a failed mode change or removal", async () => {
    setup([pipeline()], { onRemove: vi.fn().mockRejectedValue(new Error("That pipeline isn't watched")) });
    fireEvent.click(screen.getByTestId("pipeline-remove-p1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("That pipeline isn't watched");
  });
});

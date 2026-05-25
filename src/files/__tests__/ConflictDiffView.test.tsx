import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictDiffView } from "../ConflictDiffView";
import { loadMonaco } from "../loadMonaco";

interface FakeModel {
  value: string;
  language: string;
  disposed: boolean;
  getValue: ReturnType<typeof vi.fn>;
  setValue: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeDiffEditor {
  options: Record<string, unknown>;
  model: { original: FakeModel; modified: FakeModel } | null;
  disposed: boolean;
  setModel: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const fakeEditors: FakeDiffEditor[] = [];
const fakeModels: FakeModel[] = [];

function createFakeModel(value: string, language: string): FakeModel {
  const model: FakeModel = {
    value,
    language,
    disposed: false,
    getValue: vi.fn(() => model.value),
    setValue: vi.fn((nextValue: string) => {
      model.value = nextValue;
    }),
    dispose: vi.fn(() => {
      model.disposed = true;
    }),
  };
  fakeModels.push(model);
  return model;
}

function createFakeEditor(options: Record<string, unknown>): FakeDiffEditor {
  const editor: FakeDiffEditor = {
    options,
    model: null,
    disposed: false,
    setModel: vi.fn((model: { original: FakeModel; modified: FakeModel }) => {
      editor.model = model;
    }),
    dispose: vi.fn(() => {
      editor.disposed = true;
    }),
  };
  fakeEditors.push(editor);
  return editor;
}

const fakeMonaco = {
  editor: {
    createDiffEditor: vi.fn((_container: HTMLElement, options: Record<string, unknown>) =>
      createFakeEditor(options),
    ),
    createModel: vi.fn((value: string, language: string) => createFakeModel(value, language)),
  },
};

vi.mock("../loadMonaco", () => ({
  loadMonaco: vi.fn(() => Promise.resolve(fakeMonaco)),
  getMonacoIfLoaded: () => fakeMonaco,
}));

beforeEach(() => {
  fakeEditors.length = 0;
  fakeModels.length = 0;
  vi.clearAllMocks();
});

describe("ConflictDiffView", () => {
  it("shows a loading placeholder before Monaco resolves", () => {
    vi.mocked(loadMonaco).mockReturnValueOnce(new Promise(() => undefined));

    render(<ConflictDiffView diskContent="disk" mineContent="mine" />);

    expect(screen.getByText("Loading diff...")).toBeTruthy();
  });

  it("creates a read-only side-by-side Monaco diff editor", async () => {
    render(<ConflictDiffView diskContent="disk" mineContent="mine" language="typescript" />);

    await waitFor(() => expect(fakeMonaco.editor.createDiffEditor).toHaveBeenCalledTimes(1));

    expect(fakeEditors[0].options.readOnly).toBe(true);
    expect(fakeEditors[0].options.originalEditable).toBe(false);
    expect(fakeEditors[0].model).toEqual({ original: fakeModels[0], modified: fakeModels[1] });
    expect(fakeModels[0]).toMatchObject({ value: "disk", language: "typescript" });
    expect(fakeModels[1]).toMatchObject({ value: "mine", language: "typescript" });
  });

  it("defaults Monaco models to plaintext when no language hint is provided", async () => {
    render(<ConflictDiffView diskContent="disk" mineContent="mine" />);

    await waitFor(() => expect(fakeMonaco.editor.createModel).toHaveBeenCalledTimes(2));

    expect(fakeModels[0].language).toBe("plaintext");
    expect(fakeModels[1].language).toBe("plaintext");
  });

  it("updates existing models when conflict content changes", async () => {
    const { rerender } = render(
      <ConflictDiffView diskContent="old disk" mineContent="old mine" language="markdown" />,
    );
    await waitFor(() => expect(fakeMonaco.editor.createDiffEditor).toHaveBeenCalledTimes(1));

    rerender(<ConflictDiffView diskContent="new disk" mineContent="new mine" language="markdown" />);

    expect(fakeMonaco.editor.createDiffEditor).toHaveBeenCalledTimes(1);
    expect(fakeModels[0].setValue).toHaveBeenCalledWith("new disk");
    expect(fakeModels[1].setValue).toHaveBeenCalledWith("new mine");
  });

  it("disposes the diff editor and models on unmount", async () => {
    const { unmount } = render(<ConflictDiffView diskContent="disk" mineContent="mine" />);
    await waitFor(() => expect(fakeMonaco.editor.createDiffEditor).toHaveBeenCalledTimes(1));

    unmount();

    expect(fakeEditors[0].dispose).toHaveBeenCalledTimes(1);
    expect(fakeModels[0].dispose).toHaveBeenCalledTimes(1);
    expect(fakeModels[1].dispose).toHaveBeenCalledTimes(1);
  });
});

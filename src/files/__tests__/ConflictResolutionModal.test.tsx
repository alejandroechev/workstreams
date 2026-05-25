import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictResolutionModal } from "../ConflictResolutionModal";

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
  layout: ReturnType<typeof vi.fn>;
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
    layout: vi.fn(),
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

async function renderOpenModalSettled(
  overrides: Partial<React.ComponentProps<typeof ConflictResolutionModal>> = {},
) {
  const props = {
    open: true,
    fileName: "notes.md",
    diskContent: "disk text",
    mineContent: "mine text",
    language: "markdown",
    onKeepMine: vi.fn(),
    onTakeDisk: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };

  const view = render(<ConflictResolutionModal {...props} />);
  if (props.open) {
    await waitFor(() => expect(fakeMonaco.editor.createDiffEditor).toHaveBeenCalledTimes(1));
  }
  return { ...view, props };
}

function renderOpenModal(overrides: Partial<React.ComponentProps<typeof ConflictResolutionModal>> = {}) {
  const props = {
    open: true,
    fileName: "notes.md",
    diskContent: "disk text",
    mineContent: "mine text",
    language: "markdown",
    onKeepMine: vi.fn(),
    onTakeDisk: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };

  const view = render(<ConflictResolutionModal {...props} />);
  return { ...view, props };
}

beforeEach(() => {
  fakeEditors.length = 0;
  fakeModels.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ConflictResolutionModal", () => {
  it("returns null when closed", () => {
    const { container } = renderOpenModal({ open: false });

    expect(container.querySelector("[data-testid=conflict-resolution-modal]")).toBeNull();
  });

  it("renders fileName in the title when open", async () => {
    await renderOpenModalSettled({ fileName: "README.md" });

    expect(screen.getByRole("dialog", { name: "README.md changed on disk" })).toBeTruthy();
  });

  it("clicking Cancel fires onCancel and no resolution callbacks", async () => {
    const { props } = await renderOpenModalSettled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onTakeDisk).not.toHaveBeenCalled();
    expect(props.onKeepMine).not.toHaveBeenCalled();
  });

  it("clicking Take disk version fires onTakeDisk and no other callbacks", async () => {
    const { props } = await renderOpenModalSettled();

    fireEvent.click(screen.getByRole("button", { name: "Take disk version" }));

    expect(props.onTakeDisk).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(props.onKeepMine).not.toHaveBeenCalled();
  });

  it("clicking Keep my version fires onKeepMine and no other callbacks", async () => {
    const { props } = await renderOpenModalSettled();

    fireEvent.click(screen.getByRole("button", { name: /Keep my version/ }));

    expect(props.onKeepMine).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(props.onTakeDisk).not.toHaveBeenCalled();
  });

  it("Escape fires onCancel", async () => {
    const { props } = await renderOpenModalSettled();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("Enter does not pick a destructive action", async () => {
    const { props } = await renderOpenModalSettled();

    fireEvent.keyDown(document, { key: "Enter" });

    expect(props.onCancel).not.toHaveBeenCalled();
    expect(props.onTakeDisk).not.toHaveBeenCalled();
    expect(props.onKeepMine).not.toHaveBeenCalled();
  });

  it("backdrop click fires onCancel", async () => {
    const { props } = await renderOpenModalSettled();

    fireEvent.click(screen.getByTestId("conflict-resolution-modal"));

    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("dialog click does not fire onCancel", async () => {
    const { props } = await renderOpenModalSettled();

    fireEvent.click(screen.getByTestId("conflict-resolution-dialog"));

    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("renders the diff view with the provided conflict contents and language", async () => {
    await renderOpenModalSettled({
      diskContent: "disk body",
      mineContent: "mine body",
      language: "typescript",
    });

    expect(fakeMonaco.editor.createModel).toHaveBeenCalledTimes(2);

    expect(fakeMonaco.editor.createModel).toHaveBeenNthCalledWith(1, "disk body", "typescript");
    expect(fakeMonaco.editor.createModel).toHaveBeenNthCalledWith(2, "mine body", "typescript");
  });
});


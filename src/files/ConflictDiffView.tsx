import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type * as MonacoNs from "monaco-editor";
import { loadMonaco } from "./loadMonaco";

export interface ConflictDiffViewProps {
  diskContent: string;
  mineContent: string;
  language?: string;
  /** Set on the container for height/width control. */
  className?: string;
  style?: CSSProperties;
}

type MonacoModule = typeof MonacoNs;
type DiffEditor = MonacoNs.editor.IStandaloneDiffEditor;
type TextModel = MonacoNs.editor.ITextModel;

export function ConflictDiffView({
  diskContent,
  mineContent,
  language,
  className,
  style,
}: ConflictDiffViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<DiffEditor | null>(null);
  const originalModelRef = useRef<TextModel | null>(null);
  const modifiedModelRef = useRef<TextModel | null>(null);
  const latestContentRef = useRef({ diskContent, mineContent });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    latestContentRef.current = { diskContent, mineContent };

    if (originalModelRef.current && originalModelRef.current.getValue() !== diskContent) {
      originalModelRef.current.setValue(diskContent);
    }

    if (modifiedModelRef.current && modifiedModelRef.current.getValue() !== mineContent) {
      modifiedModelRef.current.setValue(mineContent);
    }
  }, [diskContent, mineContent]);

  useEffect(() => {
    let disposed = false;

    const createEditor = async (): Promise<void> => {
      const monaco: MonacoModule = await loadMonaco();
      if (disposed || containerRef.current === null) return;

      const modelLanguage = language ?? "plaintext";
      const originalModel = monaco.editor.createModel(
        latestContentRef.current.diskContent,
        modelLanguage,
      );
      const modifiedModel = monaco.editor.createModel(
        latestContentRef.current.mineContent,
        modelLanguage,
      );
      const editor = monaco.editor.createDiffEditor(containerRef.current, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
      });

      editor.setModel({ original: originalModel, modified: modifiedModel });
      originalModelRef.current = originalModel;
      modifiedModelRef.current = modifiedModel;
      editorRef.current = editor;
      setLoaded(true);
    };

    void createEditor();

    return () => {
      disposed = true;
      editorRef.current?.dispose();
      originalModelRef.current?.dispose();
      modifiedModelRef.current?.dispose();
      editorRef.current = null;
      originalModelRef.current = null;
      modifiedModelRef.current = null;
    };
  }, [language]);

  return (
    <div
      className={className}
      style={{ position: "relative", width: "100%", height: "100%", ...style }}
      data-testid="conflict-diff-view"
    >
      {!loaded && (
        <div
          style={{
            color: "#a6adc8",
            fontFamily: "monospace",
            fontSize: 12,
            padding: 12,
          }}
        >
          Loading diff...
        </div>
      )}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}

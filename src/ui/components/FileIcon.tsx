import { CodeBracketIcon, DocumentIcon, DocumentTextIcon, FolderIcon, MusicalNoteIcon } from "@heroicons/react/24/outline";

/** The Repo Explorer's icon for a file or folder, chosen by extension. */
export function FileIcon({ name, isDir, size = 16 }: { name: string; isDir: boolean; size?: number }) {
  const style = (color: string) => ({ width: size, height: size, color });
  if (isDir) return <FolderIcon style={style("#89b4fa")} />;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts": case "tsx": case "js": case "jsx": case "rs": case "py":
      return <CodeBracketIcon style={style("#a6adc8")} />;
    case "md": case "mdx": case "markdown":
      return <DocumentTextIcon style={style("#a6adc8")} />;
    case "mp3": case "wav": case "ogg": case "flac": case "m4a": case "aac": case "opus": case "webm":
      return <MusicalNoteIcon style={style("#cba6f7")} />;
    default:
      return <DocumentIcon style={style("#6c7086")} />;
  }
}

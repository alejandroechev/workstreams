# System Architecture — Agent Manager

```mermaid
graph TB
    subgraph Tauri["Tauri v2 Desktop App"]
        subgraph Frontend["React Frontend (WebView2)"]
            App["App.tsx<br/>Root shell"]
            Sidebar["WorkstreamSidebar<br/>List/create/switch"]
            TileGrid["TileGrid<br/>Adaptive tiling layout"]
            Terminal["TerminalTile<br/>xterm.js + FitAddon + SerializeAddon"]
            CodeView["CodeViewerTile<br/>Monaco Editor (read-only)"]
            DocView["DocViewerTile<br/>MarkdownView (VS Code style)<br/>+ Mermaid + Prism highlighting"]
            RepoExplorer["RepoExplorerTile<br/>Files / Diff / Log / Hooks"]
            SessionMeta["SessionMetaTile<br/>Session + file detail"]
            Workbench["WorkbenchTile<br/>Workbench file detail"]
            StatusBar["StatusBar<br/>Shortcuts + metadata"]
            subgraph Files["Files"]
                FileBuffers["FileBufferRegistry<br/>Editable file buffers + dirty state"]
                Monaco["Monaco<br/>Lazy-loaded editor"]
            end
        end

        subgraph Backend["Rust Backend"]
            LibRS["lib.rs<br/>22 Tauri commands"]
            PtyRS["pty.rs<br/>PtyManager: spawn, write, resize, close"]
            DbRS["db.rs<br/>SQLite schema + WAL"]
            FileSystemProvider["FileSystemProvider trait<br/>OS / InMemory impls"]
        end
    end

    subgraph Storage["Persistence"]
        AppDB["copilot-desktop.db<br/>(SQLite — workstreams, tiles, layouts, scrollback)"]
        CopilotDB["~/.copilot/session-store.db<br/>(read-only enrichment)"]
    end

    subgraph OS["Windows OS"]
        ConPTY["ConPTY<br/>via portable-pty"]
        Shell["pwsh.exe / agency copilot --yolo"]
        GhCli["gh CLI<br/>(optional, for repo create)"]
        FileSystem["Filesystem"]
    end

    subgraph Providers["External-integration boundary"]
        RemoteProv["RemoteRepoProvider trait<br/>GhCli / InMemory impls"]
    end

    App --> Sidebar
    App --> TileGrid
    TileGrid --> Terminal
    TileGrid --> CodeView
    TileGrid --> DocView
    TileGrid --> RepoExplorer
    TileGrid --> SessionMeta
    TileGrid --> Workbench
    App --> StatusBar
    App -- "close-requested / switch guard" --> FileBuffers

    Terminal -- "invoke: write_to_pty, resize_pty" --> LibRS
    LibRS -- "emit: pty-output-{id}" --> Terminal
    Sidebar -- "invoke: create/list workstreams" --> LibRS
    CodeView -- "invoke: read_file" --> LibRS
    DocView -- "invoke: read_file" --> LibRS
    RepoExplorer --> FileBuffers
    SessionMeta --> FileBuffers
    Workbench --> FileBuffers
    FileBuffers --> Monaco
    FileBuffers -- "invoke: read/write/watch/canonicalize" --> LibRS

    LibRS --> PtyRS
    LibRS --> DbRS
    PtyRS --> ConPTY
    ConPTY --> Shell
    DbRS --> AppDB
    LibRS -- "read-only query" --> CopilotDB
    LibRS --> FileSystemProvider
    FileSystemProvider --> FileSystem
    LibRS -- "create_git_repo" --> RemoteProv
    RemoteProv -- "gh repo create" --> GhCli
```

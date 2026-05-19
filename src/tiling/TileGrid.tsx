// @test-skip: Thin React rendering wrapper; layout logic tested in layout.test.ts
import type { Tile } from "../workstream/types";
import { computeLayout } from "./layout";
import TileWrapper from "./Tile";

interface Props {
  tiles: Tile[];
  tileOrder: string[];
  focusedIndex: number;
  focusToken?: number;
  fullscreenTileId: string | null;
  onFocusTile: (index: number) => void;
  onCloseTile: (tileId: string) => void;
  onOpenFile?: (path: string) => void;
  onLinkSession?: (tileId: string) => void;
  onAutoLink?: (tileId: string, sessionId: string, summary?: string) => void;
  onRestart?: (tileId: string) => void;
  onUpdateTileConfig?: (tileId: string, configJson: string) => void;
  workstreamDir?: string;
  workstreamId?: string;
  spawnedPtyIds?: Set<string>;
  linkedSessionIds?: string[];
}

export default function TileGrid({
  tiles,
  tileOrder,
  focusedIndex,
  focusToken,
  fullscreenTileId,
  onFocusTile,
  onCloseTile,
  onOpenFile,
  onLinkSession,
  onAutoLink,
  onRestart,
  onUpdateTileConfig,
  workstreamDir,
  workstreamId,
  spawnedPtyIds,
  linkedSessionIds,
}: Props) {
  // Order tiles according to tileOrder
  const orderedTiles = tileOrder
    .map((id) => tiles.find((t) => t.id === id))
    .filter((t): t is Tile => t !== undefined);

  // When fullscreen, the layout only allocates one cell. Non-fullscreen
  // tiles are still rendered (so their xterm/audio/tab state is preserved
  // by React) but hidden via display:none — they sit outside the grid.
  const fullscreenActive = !!fullscreenTileId;
  const layout = computeLayout(fullscreenActive ? 1 : orderedTiles.length);

  if (orderedTiles.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#585b70",
          fontFamily: "monospace",
          fontSize: 14,
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⊞</div>
          <div>No tiles yet</div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: layout.columns,
        gridTemplateRows: layout.rows,
        gridTemplateAreas: layout.areas,
        gap: 4,
        width: "100%",
        height: "100%",
        padding: 4,
        boxSizing: "border-box",
      }}
    >
      {orderedTiles.map((tile, i) => {
        const isFs = fullscreenTileId === tile.id;
        const hidden = fullscreenActive && !isFs;
        // When fullscreen, the visible tile occupies the single grid cell `t0`.
        // When non-fullscreen, each tile gets its natural grid slot `t<i>`.
        const renderIndex = fullscreenActive ? 0 : i;
        return (
          <TileWrapper
            key={tile.id}
            tile={tile}
            index={renderIndex}
            isFocused={i === focusedIndex}
            focusToken={focusToken}
            isFullscreen={isFs}
            hidden={hidden}
            onFocus={() => onFocusTile(i)}
            onClose={() => onCloseTile(tile.id)}
            onOpenFile={onOpenFile}
            onLinkSession={onLinkSession}
            onAutoLink={onAutoLink}
            onRestart={onRestart}
            onUpdateTileConfig={onUpdateTileConfig}
            workstreamDir={workstreamDir}
            workstreamId={workstreamId}
            alreadyRunning={spawnedPtyIds?.has(tile.id)}
            linkedSessionIds={linkedSessionIds}
          />
        );
      })}
    </div>
  );
}

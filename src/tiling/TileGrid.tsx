// @test-skip: Thin React rendering wrapper; layout logic tested in layout.test.ts
import type { Tile } from "../workstream/types";
import { computeLayout } from "./layout";
import TileWrapper from "./Tile";

interface Props {
  tiles: Tile[];
  tileOrder: string[];
  focusedIndex: number;
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

  // If fullscreen, show only that tile
  const visibleTiles = fullscreenTileId
    ? orderedTiles.filter((t) => t.id === fullscreenTileId)
    : orderedTiles;

  const layout = computeLayout(visibleTiles.length);

  if (visibleTiles.length === 0) {
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
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Press <kbd>n</kbd> to add a terminal
          </div>
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
      {visibleTiles.map((tile, i) => {
        const realIndex = orderedTiles.findIndex((t) => t.id === tile.id);
        return (
          <TileWrapper
            key={tile.id}
            tile={tile}
            index={fullscreenTileId ? 0 : i}
            isFocused={realIndex === focusedIndex}
            isFullscreen={fullscreenTileId === tile.id}
            onFocus={() => onFocusTile(realIndex)}
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

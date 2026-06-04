// @test-skip: Thin React rendering wrapper; layout logic tested in layout.test.ts
import { memo } from "react";
import type { Tile } from "../workstream/types";
import { computeLayout, computeSideBySideLayout } from "../domain/layout";
import TileWrapper from "./Tile";

interface Props {
  tiles: Tile[];
  tileOrder: string[];
  focusedIndex: number;
  focusToken?: number;
  fullscreenTileId: string | null;
  /** When non-null, exactly these tile ids render visibly in a 50/50 split. */
  sideBySideTileIds: string[] | null;
  /** Tile ids currently selected for entering side-by-side. */
  selectedForSideBySide: Set<string>;
  onToggleSideBySideSelect: (tileId: string) => void;
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

function TileGridImpl({
  tiles,
  tileOrder,
  focusedIndex,
  focusToken,
  fullscreenTileId,
  sideBySideTileIds,
  selectedForSideBySide,
  onToggleSideBySideSelect,
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

  // Mode precedence: fullscreen > side-by-side > adaptive grid. Fullscreen
  // takes one slot; side-by-side takes exactly two; both hide the rest via
  // display:none so xterm/audio state is preserved.
  const fullscreenActive = !!fullscreenTileId;
  const sideBySideActive = !fullscreenActive && !!sideBySideTileIds && sideBySideTileIds.length === 2;
  const layout = fullscreenActive
    ? computeLayout(1)
    : sideBySideActive
      ? computeSideBySideLayout()
      : computeLayout(orderedTiles.length);

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
        let hidden: boolean;
        let gridArea: string | undefined;
        let isInSbs = false;
        if (fullscreenActive) {
          hidden = !isFs;
          gridArea = isFs ? "t0" : undefined;
        } else if (sideBySideActive) {
          const sbsIdx = sideBySideTileIds!.indexOf(tile.id);
          hidden = sbsIdx === -1;
          gridArea = sbsIdx === 0 ? "sbs-left" : sbsIdx === 1 ? "sbs-right" : undefined;
          isInSbs = sbsIdx !== -1;
        } else {
          hidden = false;
          gridArea = `t${i}`;
        }
        const showSelectable = !fullscreenActive && !sideBySideActive;
        return (
          <TileWrapper
            key={tile.id}
            tile={tile}
            index={i}
            gridArea={gridArea}
            isFocused={i === focusedIndex}
            focusToken={focusToken}
            isFullscreen={isFs}
            isSideBySide={isInSbs}
            hidden={hidden}
            selectable={showSelectable}
            isSelected={selectedForSideBySide.has(tile.id)}
            onToggleSelect={onToggleSideBySideSelect}
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

// Memoize so App.tsx state changes that don't actually alter the props
// (e.g. selectWorkstream when this WS isn't the target, modal toggles,
// notifications) don't re-render every Tile subtree.
const TileGrid = memo(TileGridImpl);
export default TileGrid;

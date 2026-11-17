// @test-skip: Thin React rendering wrapper; layout logic tested in layout.test.ts
import { memo, useMemo, useRef } from "react";
import { DEFAULT_SPLIT, splitFromPointer, type SideBySideOrientation } from "../domain/tile-layout-mode";
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
  /** Next to each other (vertical) or one above the other (horizontal). */
  sideBySideOrientation?: SideBySideOrientation;
  /** The first tile's share of the space. */
  sideBySideSplit?: number;
  /** Dragging the divider between the two tiles. */
  onResizeSideBySide?: (split: number) => void;
  /** Tile ids currently selected for entering side-by-side. */
  selectedForSideBySide: Set<string>;
  /** When true, render the per-tile SBS selection checkboxes. */
  sbsSelectionMode: boolean;
  /**
   * Whether this TileGrid belongs to the currently-active workstream.
   * Hidden grids skip the heavy listen-callback work (fs-change refreshes,
   * etc.) since the user can't see results anyway. Subscribers remain
   * mounted so xterm/PTY state survives switching back.
   */
  isVisible: boolean;
  onToggleSideBySideSelect: (tileId: string) => void;
  onToggleFullscreen?: (tileId: string) => void;
  onShiftSelectTile?: (tileId: string, orientation: SideBySideOrientation) => void;
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
  sideBySideOrientation = "vertical",
  sideBySideSplit = DEFAULT_SPLIT,
  onResizeSideBySide,
  selectedForSideBySide,
  sbsSelectionMode,
  isVisible,
  onToggleSideBySideSelect,
  onToggleFullscreen,
  onShiftSelectTile,
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
      ? computeSideBySideLayout(sideBySideOrientation, sideBySideSplit)
      : computeLayout(orderedTiles.length);
  const gridRef = useRef<HTMLDivElement>(null);
  const resizeTo = (e: { clientX: number; clientY: number }) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect || !onResizeSideBySide) return;
    onResizeSideBySide(
      sideBySideOrientation === "vertical"
        ? splitFromPointer(e.clientX, rect.left, rect.width)
        : splitFromPointer(e.clientY, rect.top, rect.height),
    );
  };

  // Repo Explorer tiles are the only valid targets a walkthrough can drive.
  // Derived here rather than threaded from App because TileGrid already knows
  // every tile in the workstream.
  const explorerCandidates = useMemo(
    () => tiles.filter((t) => t.tile_type === "file_explorer").map((t) => ({ id: t.id, title: t.title })),
    [tiles],
  );

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
      ref={gridRef}
      data-testid="tile-grid"
      style={{
        display: "grid",
        gridTemplateColumns: layout.columns,
        gridTemplateRows: layout.rows,
        gridTemplateAreas: layout.areas,
        // In side-by-side the divider track is the gap, so it can be grabbed.
        gap: sideBySideActive ? 0 : 4,
        width: "100%",
        height: "100%",
        padding: 4,
        boxSizing: "border-box",
      }}
    >
      {sideBySideActive && (
        <div
          data-testid="sbs-divider"
          role="separator"
          aria-orientation={sideBySideOrientation === "vertical" ? "vertical" : "horizontal"}
          aria-valuenow={Math.round(sideBySideSplit * 100)}
          aria-valuemin={15}
          aria-valuemax={85}
          tabIndex={0}
          title="Drag to resize · double-click to split evenly"
          style={{
            gridArea: "sbs-divider",
            cursor: sideBySideOrientation === "vertical" ? "col-resize" : "row-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            touchAction: "none",
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            // Captured, so terminals and editors under the pointer can't steal the drag.
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) resizeTo(e);
          }}
          onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
          onDoubleClick={() => onResizeSideBySide?.(DEFAULT_SPLIT)}
          onKeyDown={(e) => {
            const back = sideBySideOrientation === "vertical" ? "ArrowLeft" : "ArrowUp";
            const forward = sideBySideOrientation === "vertical" ? "ArrowRight" : "ArrowDown";
            if (e.key === back || e.key === forward) {
              e.preventDefault();
              onResizeSideBySide?.(sideBySideSplit + (e.key === forward ? 0.05 : -0.05));
            }
          }}
        >
          <div
            style={{
              background: "#45475a",
              borderRadius: 2,
              width: sideBySideOrientation === "vertical" ? 2 : 32,
              height: sideBySideOrientation === "vertical" ? 32 : 2,
            }}
          />
        </div>
      )}
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
        const showSelectable = sbsSelectionMode && !fullscreenActive && !sideBySideActive;
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
            workstreamVisible={isVisible}
            explorerCandidates={explorerCandidates}
            selectable={showSelectable}
            isSelected={selectedForSideBySide.has(tile.id)}
            onToggleSelect={onToggleSideBySideSelect}
            onToggleFullscreen={onToggleFullscreen}
            onShiftSelect={onShiftSelectTile}
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

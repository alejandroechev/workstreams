/**
 * Tile icon registry.
 *
 * Each tile carries an optional `icon` key in its `config_json` that maps to
 * one of these Heroicon components. If absent, the icon defaults based on
 * the tile type via `defaultIconForType`.
 */
import {
  ChatBubbleLeftRightIcon,
  CommandLineIcon,
  FolderOpenIcon,
  DocumentTextIcon,
  CodeBracketIcon,
  InformationCircleIcon,
  BeakerIcon,
  PuzzlePieceIcon,
  SparklesIcon,
  RocketLaunchIcon,
  BugAntIcon,
  CogIcon,
} from "@heroicons/react/24/outline";
import type { ComponentType, SVGProps } from "react";
import type { TileType } from "../domain/types";

export type TileIconKey =
  | "session"
  | "terminal"
  | "folder"
  | "document"
  | "code"
  | "info"
  | "beaker"
  | "puzzle"
  | "sparkles"
  | "rocket"
  | "bug"
  | "cog";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const TILE_ICONS: Record<TileIconKey, IconComponent> = {
  session: ChatBubbleLeftRightIcon,
  terminal: CommandLineIcon,
  folder: FolderOpenIcon,
  document: DocumentTextIcon,
  code: CodeBracketIcon,
  info: InformationCircleIcon,
  beaker: BeakerIcon,
  puzzle: PuzzlePieceIcon,
  sparkles: SparklesIcon,
  rocket: RocketLaunchIcon,
  bug: BugAntIcon,
  cog: CogIcon,
};

export const TILE_ICON_LABELS: Record<TileIconKey, string> = {
  session: "Session",
  terminal: "Terminal",
  folder: "Folder",
  document: "Document",
  code: "Code",
  info: "Info",
  beaker: "Beaker",
  puzzle: "Puzzle",
  sparkles: "Sparkles",
  rocket: "Rocket",
  bug: "Bug",
  cog: "Cog",
};

export function defaultIconForType(tileType: TileType): TileIconKey {
  switch (tileType) {
    case "copilot_session":
      return "session";
    case "terminal":
      return "terminal";
    case "file_explorer":
      return "folder";
    case "file_viewer":
    case "doc_viewer":
      return "document";
    case "code_viewer":
      return "code";
    case "session_meta":
      return "info";
    case "workbench":
      return "beaker";
    default:
      return "puzzle";
  }
}

export function resolveTileIcon(tileType: TileType, configIcon: string | undefined | null): IconComponent {
  const key = (configIcon && configIcon in TILE_ICONS ? configIcon : defaultIconForType(tileType)) as TileIconKey;
  return TILE_ICONS[key];
}

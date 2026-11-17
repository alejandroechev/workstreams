/**
 * The software shape palette (ADR 043): a few hand-drawn starting shapes per
 * diagram kind, shown in the Diagram tile's Palette panel. Each item is
 * written as Excalidraw "skeletons" and converted when placed; the shapes are
 * then ordinary elements (multi-shape items are grouped, and ungroupable).
 */

export type PaletteKind = "Flow" | "Sequence" | "Class" | "State";

/** A subset of Excalidraw's `ExcalidrawElementSkeleton`, as this palette uses it. */
export interface Skeleton {
  type: "rectangle" | "ellipse" | "diamond" | "arrow" | "line" | "text";
  id?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  label?: { text: string; fontSize?: number; textAlign?: "left" | "center"; verticalAlign?: "top" | "middle" };
  start?: { id: string } | { type: "rectangle" | "ellipse" };
  end?: { id: string } | { type: "rectangle" | "ellipse" };
  points?: Array<[number, number]>;
  strokeStyle?: "solid" | "dashed" | "dotted";
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure";
  roundness?: { type: number } | null;
  endArrowhead?: "arrow" | "triangle" | "dot" | "bar" | null;
  strokeWidth?: number;
  fontSize?: number;
}

export interface PaletteItem {
  kind: PaletteKind;
  name: string;
  skeletons: Skeleton[];
}

const ROUND = { type: 3 };

export const PALETTE: readonly PaletteItem[] = [
  { kind: "Flow", name: "Component", skeletons: [{ type: "rectangle", x: 0, y: 0, width: 160, height: 70, roundness: ROUND, label: { text: "Component" } }] },
  { kind: "Flow", name: "Database", skeletons: [{ type: "ellipse", x: 0, y: 0, width: 140, height: 80, label: { text: "Database" } }] },
  { kind: "Flow", name: "Decision", skeletons: [{ type: "diamond", x: 0, y: 0, width: 140, height: 100, label: { text: "Decision?" } }] },
  {
    kind: "Flow",
    name: "Actor",
    skeletons: [
      { type: "ellipse", x: 15, y: 0, width: 30, height: 30 },
      { type: "line", x: 30, y: 30, points: [[0, 0], [0, 40]] },
      { type: "line", x: 5, y: 45, points: [[0, 0], [50, 0]] },
      { type: "line", x: 30, y: 70, points: [[0, 0], [-25, 30]] },
      { type: "line", x: 30, y: 70, points: [[0, 0], [25, 30]] },
      { type: "text", x: 8, y: 106, text: "Actor", fontSize: 16 },
    ],
  },
  {
    kind: "Flow",
    name: "Note",
    skeletons: [{ type: "rectangle", x: 0, y: 0, width: 160, height: 80, backgroundColor: "#ffec99", fillStyle: "solid", label: { text: "Note", fontSize: 16 } }],
  },
  {
    kind: "Sequence",
    name: "Actor with lifeline",
    skeletons: [
      { type: "rectangle", x: 0, y: 0, width: 120, height: 50, label: { text: "Actor" } },
      { type: "line", x: 60, y: 50, points: [[0, 0], [0, 260]], strokeStyle: "dashed" },
    ],
  },
  {
    kind: "Sequence",
    name: "Message",
    skeletons: [{ type: "arrow", x: 0, y: 0, width: 200, height: 0, points: [[0, 0], [200, 0]], label: { text: "call()" } }],
  },
  {
    kind: "Sequence",
    name: "Reply",
    skeletons: [{ type: "arrow", x: 200, y: 0, width: 200, height: 0, points: [[0, 0], [-200, 0]], strokeStyle: "dashed", label: { text: "result" } }],
  },
  { kind: "Sequence", name: "Activation", skeletons: [{ type: "rectangle", x: 0, y: 0, width: 16, height: 100 }] },
  {
    kind: "Class",
    name: "Class box",
    skeletons: [
      {
        type: "rectangle",
        x: 0,
        y: 0,
        width: 200,
        height: 130,
        label: { text: "ClassName\n──────────\n+ field: Type\n──────────\n+ method()", fontSize: 16, textAlign: "left", verticalAlign: "top" },
      },
    ],
  },
  {
    kind: "Class",
    name: "Interface",
    skeletons: [
      {
        type: "rectangle",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        label: { text: "«interface»\nName\n──────────\n+ method()", fontSize: 16, textAlign: "left", verticalAlign: "top" },
      },
    ],
  },
  { kind: "Class", name: "Inheritance", skeletons: [{ type: "arrow", x: 0, y: 0, width: 0, height: 120, points: [[0, 120], [0, 0]], endArrowhead: "triangle" }] },
  { kind: "Class", name: "Association", skeletons: [{ type: "arrow", x: 0, y: 0, width: 180, height: 0, points: [[0, 0], [180, 0]], label: { text: "1..*" } }] },
  { kind: "State", name: "State", skeletons: [{ type: "rectangle", x: 0, y: 0, width: 150, height: 60, roundness: ROUND, label: { text: "State" } }] },
  {
    kind: "State",
    name: "Initial state",
    skeletons: [{ type: "ellipse", x: 0, y: 0, width: 26, height: 26, backgroundColor: "#1e1e1e", fillStyle: "solid" }],
  },
  {
    kind: "State",
    name: "Final state",
    skeletons: [
      { type: "ellipse", x: 0, y: 0, width: 34, height: 34 },
      { type: "ellipse", x: 7, y: 7, width: 20, height: 20, backgroundColor: "#1e1e1e", fillStyle: "solid" },
    ],
  },
  {
    kind: "State",
    name: "Transition",
    skeletons: [{ type: "arrow", x: 0, y: 0, width: 180, height: 0, points: [[0, 0], [180, 0]], label: { text: "event" } }],
  },
];

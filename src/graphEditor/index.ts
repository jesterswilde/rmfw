import {
  type Vec2,
  type NodeModel,
  type NodeID,
  type GraphState,
  ModelTypes,
  defaultPortsForNode,
} from "./interfaces.js";
import {
  makeContextMenu,
  makeKeyDown,
  makePointerDown,
  makePointerEnd,
  makePointerLeave,
  makePointerMove,
  makeResizeOrThemeChange,
} from "./listeners/index.js";

/* Setup */
const canvas = document.getElementById("node-canvas") as HTMLCanvasElement;
if (!canvas) throw new Error("Canvas element #node-canvas not found");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2D context not available");

/* Seeds */
const seedNodes: Array<Pick<NodeModel, "id" | "label" | "position" | "size"> & Partial<NodeModel>> = [
  { id: "geo",   label: "Geometry",       position: { x: 120,  y: 120 }, size: { x: 160, y: 80 }, type: "geometry" },
  { id: "xform", label: "Transform",      position: { x: 360,  y: 240 }, size: { x: 180, y: 88 }, type: "transform" },
  { id: "mat",   label: "Material",       position: { x: 660,  y: 180 }, size: { x: 170, y: 80 }, type: "material" },
  { id: "out",   label: "Render Output",  position: { x: 920,  y: 280 }, size: { x: 200, y: 96 }, type: "output" },
];

/* State */
const state: GraphState = {
  canvas,
  ctx,
  nodes: [],
  connections: [],
  selectedIDs: new Set<NodeID>(),
  selectedConnectionIDs: new Set(),
  selectionMode: "node",
  lastActiveID: null,
  hoverID: null,
  hoverConnectionID: null,
  hoverPortID: null,
  dragging: false,
  dragOffsets: new Map<NodeID, Vec2>(),
  marquee: { active: false, anchor: null, current: null, baseSelection: null },
  hasDragSelectionMoved: false,
  pointerDownAt: null,
  lastPointerCanvasPos: null,
  wireDrag: { active: false, toPos: null },
  nextID: 1,
};

/* Initialize nodes without writing undefined into optional props */
for (const sn of seedNodes) {
  const nodeBase = {
    id: sn.id,
    kind: ModelTypes.Node,
    label: sn.label,
    position: sn.position,
    size: sn.size,
  } as unknown as NodeModel;

  if (sn.type) {
    (nodeBase as any).type = sn.type;
  }

  (nodeBase as any).ports = defaultPortsForNode(nodeBase);
  state.nodes.push(nodeBase);
}

/* Interaction */
canvas.addEventListener("pointerdown", makePointerDown(state));
canvas.addEventListener("pointermove", makePointerMove(state));
canvas.addEventListener("pointerup", makePointerEnd(state));
canvas.addEventListener("pointercancel", makePointerEnd(state));
canvas.addEventListener("pointerleave", makePointerLeave(state));
canvas.addEventListener("contextmenu", makeContextMenu(state));
window.addEventListener("keydown", makeKeyDown(state));

const resize = makeResizeOrThemeChange(state);
window.addEventListener("resize", resize);
resize();

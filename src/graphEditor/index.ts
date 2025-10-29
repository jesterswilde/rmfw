import { type Vec2, type NodeModel, type NodeID, type GraphState, type NodeTypeId, defaultPortsForNode, ModelTypes } from "./interfaces.js";
import { makeContextMenu, makeKeyDown, makePointerDown, makePointerEnd, makePointerLeave, makePointerMove, makeResizeOrThemeChange } from "./listeners.js";

const canvas = document.getElementById('node-canvas') as HTMLCanvasElement;
if (!canvas) throw new Error('Canvas element #node-canvas not found');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('2D context not available');

// Seed nodes with explicit NodeTypeId so `type` doesn't widen to string
const baseNodes: NodeModel[] = [
  { id: 'geo', kind: ModelTypes.Node,   type: 'geometry' as NodeTypeId,  label: 'Geometry',       position: { x: 120,  y: 120 },  size: { x: 160, y: 80 } },
  { id: 'xform', kind: ModelTypes.Node, type: 'transform' as NodeTypeId, label: 'Transform',      position: { x: 360,  y: 240 },  size: { x: 180, y: 88 } },
  { id: 'mat', kind: ModelTypes.Node,   type: 'material' as NodeTypeId,  label: 'Material',       position: { x: 660,  y: 180 },  size: { x: 170, y: 80 } },
  { id: 'out', kind: ModelTypes.Node,   type: 'output' as NodeTypeId,    label: 'Render Output',  position: { x: 920,  y: 280 },  size: { x: 200, y: 96 } }
];

// Attach ports after the array is strongly typed as NodeModel[]
for (const n of baseNodes) n.ports = defaultPortsForNode(n);

const state: GraphState = {
  canvas,
  ctx,
  nodes: baseNodes,
  connections: [],
  selectedIDs: new Set<NodeID>(),
  selectedConnectionIDs: new Set(),
  selectionMode: 'node',
  lastActiveID: null,
  hoverID: null,
  hoverConnectionID: null,
  dragging: false,
  dragOffsets: new Map<NodeID, Vec2>(),
  marquee: { active: false, anchor: null, current: null, baseSelection: null },
  hasDragSelectionMoved: false,
  pointerDownAt: null,
  lastPointerCanvasPos: null,
  wireDrag: { active: false, toPos: null },
  nextID: 1,
  hoverPortID: null
};

canvas.addEventListener('pointerdown', makePointerDown(state))
canvas.addEventListener('pointermove', makePointerMove(state));
canvas.addEventListener('pointerup', makePointerEnd(state));
canvas.addEventListener('pointercancel', makePointerEnd(state));
canvas.addEventListener('pointerleave', makePointerLeave(state)); 
window.addEventListener('keydown', makeKeyDown(state));
canvas.addEventListener('contextmenu', makeContextMenu(state))

const resize = makeResizeOrThemeChange(state)
window.addEventListener('resize', resize);
resize();

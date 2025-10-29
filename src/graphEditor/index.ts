// =============================
// Node Editor — Stage 4 (Main)
// =============================
// index.ts

import { type Vec2, type NodeModel, type NodeID, type GraphState } from "./interfaces.js";
import { makeContextMenu, makeKeyDown, makePointerDown, makePointerEnd, makePointerLeave, makePointerMove, makeResizeOrThemeChange } from "./listeners.js";

// ------- Setup -------

const canvas = document.getElementById('node-canvas') as HTMLCanvasElement;
if (!canvas) throw new Error('Canvas element #node-canvas not found');
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('2D context not available');

const state: GraphState = {
  canvas,
  ctx,
  nodes: [
    { id: 'geo',   label: 'Geometry', position: { x: 120,  y: 120 },  size: { x: 160, y: 80 } },
    { id: 'xform', label: 'Transform', position: { x: 360,  y: 240 }, size: { x: 180, y: 88 } },
    { id: 'mat',   label: 'Material', position: { x: 660,  y: 180 },  size: { x: 170, y: 80 } },
    { id: 'out',   label: 'Render Output', position: { x: 920, y: 280 }, size: { x: 200, y: 96 } }
  ],
  selectedIDs: new Set<NodeID>(),
  lastActiveID: null,
  hoverID: null,
  dragging: false,
  dragOffsets: new Map<NodeID, Vec2>(),
  marquee: { active: false, anchor: null, current: null, baseSelection: null },
  hasDragSelectionMoved: false,
  pointerDownAt: null,
  lastPointerCanvasPos: null,
  nextID: 1
};

// ------- Lifecycle -------


// ------- Interaction -------
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
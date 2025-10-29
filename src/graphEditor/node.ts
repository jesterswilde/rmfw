// =============================
// Node Editor — Stage 4 (Main)
// =============================

import { render } from "./drawing.js";
import type { Vec2, NodeModel, NodeID, GraphState } from "./interfaces.js";
import { refreshStyles } from "./styles.js";

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
  hasDragSelectionMoved: false
};

// ------- Canvas sizing / DPR -------

function fitCanvasToDisplaySize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const { width: cssW, height: cssH } = state.canvas.getBoundingClientRect();
  const desiredW = Math.round(cssW * dpr);
  const desiredH = Math.round(cssH * dpr);
  if (state.canvas.width !== desiredW || state.canvas.height !== desiredH) {
    state.canvas.width = desiredW; state.canvas.height = desiredH;
  }
  state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ------- Pointer -> canvas space -------
// Uses rect scale and inverts current canvas transform so it stays correct across DPR/zoom/pan.
function getCanvasPoint(evt: MouseEvent | PointerEvent): Vec2 {
  const rect = canvas.getBoundingClientRect();
  const xCSS = (evt.clientX ?? 0) - rect.left;
  const yCSS = (evt.clientY ?? 0) - rect.top;
  const xDevice = xCSS * (canvas.width / rect.width);
  const yDevice = yCSS * (canvas.height / rect.height);
  const inv = state.ctx.getTransform().inverse();
  const p = new DOMPoint(xDevice, yDevice).matrixTransform(inv);
  return { x: p.x, y: p.y };
}

// ------- Hit testing / Z -------

function hitTest(pt: Vec2): NodeModel | null {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i]!;
    const { x, y } = n.position; const { x: w, y: h } = n.size;
    if (pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h) return n;
  }
  return null;
}

function bringToFrontById(id: NodeID) {
  const idx = state.nodes.findIndex(n => n.id === id);
  if (idx >= 0 && idx !== state.nodes.length - 1) {
    const [n] = state.nodes.splice(idx, 1);
    state.nodes.push(n!);
  }
}
function bringToFrontByIDs(ids: Set<string>){
  const front: NodeModel[] = [];
  const back: NodeModel[] = [];
  for (const node of state.nodes)
    (ids.has(node.id) ? back : front).push(node);
  state.nodes = [...front, ...back];
}

// ------- Selection helpers -------

function setSingleSelection(id: NodeID) {
  state.selectedIDs.clear();
  state.selectedIDs.add(id);
  state.lastActiveID = id;
}
function toggleSelection(id: NodeID) {
  if (state.selectedIDs.has(id)) state.selectedIDs.delete(id);
  else { state.selectedIDs.add(id); state.lastActiveID = id; }
}
function startDragForSelection(at: Vec2) {
  state.dragOffsets.clear();
  for (const id of state.selectedIDs) {
    const n = state.nodes.find(nn => nn.id === id)!;
    state.dragOffsets.set(id, { x: at.x - n.position.x, y: at.y - n.position.y });
  }
  state.dragging = state.selectedIDs.size > 0;
}
function moveDraggedNodes(to: Vec2) {
  for (const id of state.selectedIDs) {
    const n = state.nodes.find(nn => nn.id === id)!;
    const off = state.dragOffsets.get(id)!;
    n.position.x = to.x - off.x;
    n.position.y = to.y - off.y;
  }
}

// ------- Marquee helpers -------

function rectFromPoints(a: Vec2, b: Vec2) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
  return { x, y, width: w, height: h };
}
function intersectsNode(mx: number, my: number, mw: number, mh: number, n: NodeModel) {
  const nx = n.position.x, ny = n.position.y, nw = n.size.x, nh = n.size.y;
  return !(mx + mw < nx || nx + nw < mx || my + mh < ny || ny + nh < my);
}
function updateMarqueeSelection() {
  if (!state.marquee.active || !state.marquee.anchor || !state.marquee.current) return;
  const { x, y, width, height } = rectFromPoints(state.marquee.anchor, state.marquee.current);
  const fresh = new Set<NodeID>();
  for (const n of state.nodes) if (intersectsNode(x, y, width, height, n)) fresh.add(n.id);
  const base = state.marquee.baseSelection ?? new Set<NodeID>();
  state.selectedIDs = new Set([...base, ...fresh]);
}

// ------- Node lifecycle -------

let counter = 1;
function nextId(base = "node"): NodeID {
  let id: string;
  do { id = `${base}-${counter++}`; } while (state.nodes.some(n => n.id === id));
  return id;
}
function createNode(at?: Vec2) {
  const { width, height } = canvas.getBoundingClientRect();
  const fallback: Vec2 = { x: width / 2, y: height / 2 };
  const p = at ?? lastPointerCanvasPos ?? fallback;
  const newNode: NodeModel = {
    id: nextId(),
    label: "Node",
    position: { x: Math.round(p.x - 80), y: Math.round(p.y - 40) },
    size: { x: 160, y: 80 }
  };
  state.nodes.push(newNode);
  setSingleSelection(newNode.id);
  bringToFrontById(newNode.id);
  render(state);
}
function deleteSelected() {
  if (!state.selectedIDs.size) return;
  const keep = state.nodes.filter(n => !state.selectedIDs.has(n.id));
  state.nodes = keep;
  state.selectedIDs.clear();
  state.lastActiveID = null;
  render(state);
}

// ------- Interaction -------

let pointerDownAt: Vec2 | null = null;
let lastPointerCanvasPos: Vec2 | null = null;
const DRAG_THRESHOLD = 3;

canvas.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  canvas.setPointerCapture(evt.pointerId);
  const pt = getCanvasPoint(evt);
  lastPointerCanvasPos = pt;
  pointerDownAt = pt;

  const target = hitTest(pt);
  const additive = evt.shiftKey;

  if (target) {
    if (additive){
      state.hasDragSelectionMoved = false;
      toggleSelection(target.id);
    } else if (!state.selectedIDs.has(target.id)) {
      bringToFrontById(target.id);
      setSingleSelection(target.id);
    } else {
      state.lastActiveID = target.id;
    }

    if(!state.hasDragSelectionMoved){
      state.hasDragSelectionMoved = true;
      bringToFrontByIDs(state.selectedIDs);
    }

    startDragForSelection(pt);
    canvas.style.cursor = 'grabbing';
    render(state);
  } else {
    state.selectedIDs.clear();
    state.marquee.active = true;
    state.marquee.anchor = pt;
    state.marquee.current = pt;
    state.marquee.baseSelection = additive ? new Set(state.selectedIDs) : new Set();
    state.hoverID = null;
    state.dragging = false;
    state.hasDragSelectionMoved = false;
    render(state);
  }
});

canvas.addEventListener('pointermove', (evt) => {
  const pt = getCanvasPoint(evt);
  lastPointerCanvasPos = pt;

  if (state.marquee.active) {
    state.marquee.current = pt;
    updateMarqueeSelection();
    render(state);
    return;
  }

  if (state.dragging) {
    moveDraggedNodes(pt);
    render(state);
    return;
  }

  const over = hitTest(pt);
  const newHover = over ? over.id : null;
  if (newHover !== state.hoverID) {
    state.hoverID = newHover;
    canvas.style.cursor = state.hoverID ? 'pointer' : 'default';
    render(state);
  }

  if (pointerDownAt && state.selectedIDs.size && over && state.selectedIDs.has(over.id)) {
    const dx = Math.abs(pt.x - pointerDownAt.x);
    const dy = Math.abs(pt.y - pointerDownAt.y);
    if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
      startDragForSelection(pt);
      canvas.style.cursor = 'grabbing';
    }
  }
});

function endPointer(evt: PointerEvent) {
  if (state.marquee.active) {
    state.marquee.active = false;
    state.marquee.anchor = null;
    state.marquee.current = null;
    state.marquee.baseSelection = null;
  }
  if (state.dragging) {
    state.dragging = false;
    state.dragOffsets.clear();
  }
  canvas.releasePointerCapture(evt.pointerId);
  pointerDownAt = null;
  canvas.style.cursor = state.hoverID ? 'pointer' : 'default';
  render(state);
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => {
  if (!state.dragging && !state.marquee.active) {
    if (state.hoverID) { state.hoverID = null; render(state); }
    canvas.style.cursor = 'default';
  }
});

// ------- Keyboard -------

function onKeyDown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (!mod && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    createNode();
    return;
  }
  if (e.key === 'Escape') {
    state.selectedIDs.clear();
    state.lastActiveID = null;
    render(state);
  }
}
window.addEventListener('keydown', onKeyDown);

// ------- Resize / Init -------

function onResizeOrThemeChange() {
  refreshStyles();
  fitCanvasToDisplaySize();
  render(state);
}
window.addEventListener('resize', onResizeOrThemeChange);
onResizeOrThemeChange();

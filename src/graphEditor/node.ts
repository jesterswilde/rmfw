// =============================
// Node Editor — Stage 2 (TS)
// =============================
// - Drag to move a single selected node
// - Maintain z-order (bring to front on select/drag)
// - Hover states & selection outlines
// - DPR/zoom-robust hit testing (relies on your Stage 1.B getCanvasPoint)


import { render } from "./drawing.js";
import type { Vec2, NodeModel, NodeID, GraphState } from "./interfaces.js";
import { refreshStyles } from "./styles.js";

// ------- Canvas Setup -------

const canvas = document.getElementById('node-canvas') as HTMLCanvasElement;
if (!canvas) throw new Error('Canvas element #node-canvas not found');
const maybeCTX = canvas.getContext('2d');
if (!maybeCTX) throw new Error('2D context not available');
const ctx = maybeCTX;

const state: GraphState = {
    canvas,
    ctx,
    selectedID: null,
    hoverID: null,
    draggingID: null,
    dragOffset: { x: 0, y: 0 },
    nodes: [
        { id: 'geo',   label: 'Geometry', position: { x: 120,  y: 120 },  size: { x: 160, y: 80 } },
        { id: 'xform', label: 'Transform', position: { x: 360,  y: 240 }, size: { x: 180, y: 88 } },
        { id: 'mat',   label: 'Material', position: { x: 660,  y: 180 },  size: { x: 170, y: 80 } },
        { id: 'out',   label: 'Render Output', position: { x: 920, y: 280 }, size: { x: 200, y: 96 } }
    ]   
}

// High-DPI/backing store scale
function fitCanvasToDisplaySize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const { width: cssW, height: cssH } = canvas.getBoundingClientRect();
  const desiredW = Math.round(cssW * dpr);
  const desiredH = Math.round(cssH * dpr);
  if (canvas.width !== desiredW || canvas.height !== desiredH) {
    canvas.width = desiredW; canvas.height = desiredH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 1 canvas unit == 1 CSS px
}

// Mouse/pointer → canvas user space
function getCanvasPoint(evt: MouseEvent | PointerEvent): Vec2 {
  const rect = canvas.getBoundingClientRect();
  const xCSS = (evt.clientX ?? 0) - rect.left;
  const yCSS = (evt.clientY ?? 0) - rect.top;
  const xDevice = xCSS * (canvas.width / rect.width);
  const yDevice = yCSS * (canvas.height / rect.height);
  const inv = ctx.getTransform().inverse();
  const p = new DOMPoint(xDevice, yDevice).matrixTransform(inv);
  return { x: p.x, y: p.y };
}

// ------- Hit Testing / Z-Order -------

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
  //This works for now. This could become expnsive later if we have a bunch of nodes.
  //This also doesn't work if we end up with any form of hierarchy later.
  if (idx >= 0 && idx !== state.nodes.length - 1) {
    const [n] = state.nodes.splice(idx, 1);
    state.nodes.push(n!);
  }
}

// ------- Interaction (pointer events) -------

canvas.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  const pt = getCanvasPoint(evt);
  const target = hitTest(pt);

  if (target) {
    state.selectedID = target.id;
    bringToFrontById(target.id);

    // prepare dragging
    state.draggingID = target.id;
    state.dragOffset = { x: pt.x - target.position.x, y: pt.y - target.position.y };
    canvas.setPointerCapture(evt.pointerId);
    canvas.style.cursor = 'grabbing';
  } else {
    state.selectedID = null;
  }

  render(state);
});

canvas.addEventListener('pointermove', (evt) => {
  const pt = getCanvasPoint(evt);

  // hover feedback when not dragging
  if (!state.draggingID) {
    const over = hitTest(pt);
    const newHover = over ? over.id : null;
    if (newHover !== state.hoverID) {
      state.hoverID = newHover;
      canvas.style.cursor = state.hoverID ? 'pointer' : 'default';
      render(state);
    }
    return;
  }

  // dragging
  const id = state.draggingID;
  const node = id ? state.nodes.find(n => n.id === id) : null;
  if (node) {
    node.position.x = pt.x - state.dragOffset.x;
    node.position.y = pt.y - state.dragOffset.y;
    render(state);
  }
});

function endDrag(evt: PointerEvent) {
  if (state.draggingID != null) {
    canvas.releasePointerCapture(evt.pointerId);
    state.draggingID = null;
    state.dragOffset = { x: 0, y: 0 };
    canvas.style.cursor = state.hoverID ? 'pointer' : 'default';
  }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', (e) => {
  // If pointer leaves while captured, pointercancel will fire; this is just for hover cleanup.
  if (!state.draggingID) {
    if (state.hoverID) { state.hoverID = null; render(state); }
    canvas.style.cursor = 'default';
  }
});

// ------- Resize / Init -------

function onResizeOrThemeChange() {
  refreshStyles();
  fitCanvasToDisplaySize();
  render(state);
}
window.addEventListener('resize', onResizeOrThemeChange);
// window.addEventListener('themechange', onResizeOrThemeChange);

onResizeOrThemeChange();

import type { GraphState, NodeModel, Vec2 } from "./interfaces.js";

// Uses rect scale and inverts current canvas transform so it stays correct across DPR/zoom/pan.
export function getCanvasPoint(state: GraphState, evt: MouseEvent | PointerEvent): Vec2 {
    const {canvas} = state;
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

export function hitTest(state: GraphState, pt: Vec2): NodeModel | null {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i]!;
    const { x, y } = n.position; const { x: w, y: h } = n.size;
    if (pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h) return n;
  }
  return null;
}

export function fitCanvasToDisplaySize(state: GraphState) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const { width: cssW, height: cssH } = state.canvas.getBoundingClientRect();
  const desiredW = Math.round(cssW * dpr);
  const desiredH = Math.round(cssH * dpr);
  if (state.canvas.width !== desiredW || state.canvas.height !== desiredH) {
    state.canvas.width = desiredW; state.canvas.height = desiredH;
  }
  state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
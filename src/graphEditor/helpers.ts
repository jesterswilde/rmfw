import type { GraphState, NodeModel, Vec2, ConnectionModel, PortModel } from "./interfaces.js";

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

/* ---- Hit testing ---- */

export function hitTestNode(state: GraphState, pt: Vec2): NodeModel | null {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i]!;
    const { x, y } = n.position; const { x: w, y: h } = n.size;
    if (pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h) return n;
  }
  return null;
}

// Visual port radius ~5px; bigger hit area
const PORT_VISUAL_R = 5;
const PORT_HIT_R = Math.max(11, PORT_VISUAL_R * 2);

const PORT_SPACING = 18;
const PORT_TOP_OFFSET = 32;

export function portAnchor(n: NodeModel, p: PortModel): Vec2 {
  const x = p.side === 'input' ? n.position.x : (n.position.x + n.size.x);
  const y = n.position.y + PORT_TOP_OFFSET + p.index * PORT_SPACING;
  return { x, y };
}

export function hitTestPort(state: GraphState, pt: Vec2): { node: NodeModel; port: PortModel } | null {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i]!;
    const ports = [...(n.ports?.inputs ?? []), ...(n.ports?.outputs ?? [])];
    for (const p of ports) {
      const a = portAnchor(n, p);
      const dx = pt.x - a.x, dy = pt.y - a.y;
      if (dx*dx + dy*dy <= PORT_HIT_R * PORT_HIT_R) return { node: n, port: p };
    }
  }
  return null;
}

/* Find a port by its id (used by listeners + drawing for wire-drag) */
export function findPortById(state: GraphState, portId: string | null) {
  if (!portId) return null;
  for (const n of state.nodes) {
    for (const p of n.ports?.inputs ?? []) if (p.id === portId) return { node: n, port: p };
    for (const p of n.ports?.outputs ?? []) if (p.id === portId) return { node: n, port: p };
  }
  return null;
}

function bezierPoints(state: GraphState, c: ConnectionModel) {
  const fromNode = state.nodes.find(n => n.id === c.from.nodeId)!;
  const toNode   = state.nodes.find(n => n.id === c.to.nodeId)!;
  const fromPort = fromNode.ports!.outputs.find(p => p.id === c.from.portId)!;
  const toPort   = toNode.ports!.inputs.find(p => p.id === c.to.portId)!;
  const p0 = portAnchor(fromNode, fromPort);
  const p3 = portAnchor(toNode, toPort);
  const dx = Math.max(40, Math.abs(p3.x - p0.x) * 0.5);
  const p1 = { x: p0.x + dx, y: p0.y };
  const p2 = { x: p3.x - dx, y: p3.y };
  return { p0, p1, p2, p3 };
}

// Larger hit for connections and smooth hover
export function hitTestConnection(state: GraphState, pt: Vec2) {
  const threshold = 9;
  for (let i = state.connections.length - 1; i >= 0; i--) {
    const c = state.connections[i]!;
    const { p0, p1, p2, p3 } = bezierPoints(state, c);
    if (Math.hypot(pt.x - p0.x, pt.y - p0.y) <= threshold) return c;
    if (Math.hypot(pt.x - p3.x, pt.y - p3.y) <= threshold) return c;

    let last = p0;
    const steps = 40;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, mt = 1 - t;
      const x = mt*mt*mt*p0.x + 3*mt*mt*t*p1.x + 3*mt*t*t*p2.x + t*t*t*p3.x;
      const y = mt*mt*mt*p0.y + 3*mt*mt*t*p1.y + 3*mt*t*t*p2.y + t*t*t*p3.y;
      const d = pointToSegmentDistance(pt, last, { x, y });
      if (d <= threshold) return c;
      last = { x, y };
    }
  }
  return null;
}

function pointToSegmentDistance(p: Vec2, a: Vec2, b: Vec2) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const ab2 = abx*abx + aby*aby;
  const t = ab2 ? Math.max(0, Math.min(1, (apx*abx + apy*aby)/ab2)) : 0;
  const x = a.x + t*abx, y = a.y + t*aby;
  return Math.hypot(p.x - x, p.y - y);
}

export function connectionIntersectsRect(state: GraphState, c: ConnectionModel, rx: number, ry: number, rw: number, rh: number) {
  const { p0, p1, p2, p3 } = bezierPoints(state, c);
  const minX = Math.min(p0.x, p1.x, p2.x, p3.x);
  const minY = Math.min(p0.y, p1.y, p2.y, p3.y);
  const maxX = Math.max(p0.x, p1.x, p2.x, p3.x);
  const maxY = Math.max(p0.y, p1.y, p2.y, p3.y);
  return !(rx+rw < minX || maxX < rx || ry+rh < minY || maxY < ry);
}

import type { GraphState, NodeID, NodeModel, Vec2 } from "./interfaces.js";
import { connectionIntersectsRect } from "./helpers.js";

export function setSingleSelection(state: GraphState, id: NodeID) {
  state.selectedIDs.clear();
  state.selectedIDs.add(id);
  state.lastActiveID = id;
}
export function toggleSelection(state: GraphState, id: NodeID) {
  if (state.selectedIDs.has(id)) state.selectedIDs.delete(id);
  else { state.selectedIDs.add(id); state.lastActiveID = id; }
}

export function startDragForSelection(state: GraphState, at: Vec2) {
  state.dragOffsets.clear();
  for (const id of state.selectedIDs) {
    const n = state.nodes.find(nn => nn.id === id)!;
    state.dragOffsets.set(id, { x: at.x - n.position.x, y: at.y - n.position.y });
  }
  state.dragging = state.selectedIDs.size > 0;
}
export function moveDraggedNodes(state: GraphState, to: Vec2) {
  for (const id of state.selectedIDs) {
    const n = state.nodes.find(nn => nn.id === id)!;
    const off = state.dragOffsets.get(id)!;
    n.position.x = to.x - off.x;
    n.position.y = to.y - off.y;
  }
}

/* ---- Marquee ---- */

export function rectFromPoints(a: Vec2, b: Vec2) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
  return { x, y, width: w, height: h };
}
export function intersectsNode(mx: number, my: number, mw: number, mh: number, n: NodeModel) {
  const nx = n.position.x, ny = n.position.y, nw = n.size.x, nh = n.size.y;
  return !(mx + mw < nx || nx + nw < mx || my + mh < ny || ny + nh < my);
}

export function updateMarqueeSelection(state: GraphState) {
  if (!state.marquee.active || !state.marquee.anchor || !state.marquee.current) return;
  const { x, y, width, height } = rectFromPoints(state.marquee.anchor, state.marquee.current);

  if (state.selectionMode === 'connection') {
    const fresh = new Set<string>();
    for (const c of state.connections)
      if (connectionIntersectsRect(state, c, x, y, width, height)) fresh.add(c.id);
    const base = state.marquee.baseSelection ?? new Set<string>();
    state.selectedConnectionIDs = new Set([...base, ...fresh]);
  } else {
    const fresh = new Set<NodeID>();
    for (const n of state.nodes) if (intersectsNode(x, y, width, height, n)) fresh.add(n.id);
    const base = state.marquee.baseSelection ?? new Set<NodeID>();
    state.selectedIDs = new Set([...base, ...fresh]);
  }
}

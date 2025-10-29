import { render } from "./drawing.js";
import { NODE_TYPES, type GraphState, type NodeID, type NodeModel, type NodeTypeId, type Vec2, defaultPortsForNode, ModelTypes } from "./interfaces.js";
import { setSingleSelection } from "./selection.js";

export function bringToFrontById(state: GraphState, id: NodeID) {
  const idx = state.nodes.findIndex(n => n.id === id);
  if (idx >= 0 && idx !== state.nodes.length - 1) {
    const [n] = state.nodes.splice(idx, 1);
    state.nodes.push(n!);
  }
}

export function bringToFrontByIDs(state: GraphState, ids: Set<string>){
  const front: NodeModel[] = [];
  const back: NodeModel[] = [];
  for (const node of state.nodes) (ids.has(node.id) ? back : front).push(node);
  state.nodes = [...front, ...back];
}

export function nextId(state: GraphState, base = "node"): NodeID {
  let id: string;
  do { id = `${base}-${state.nextID++}`; } while (state.nodes.some(n => n.id === id));
  return id;
}

export function createNodeOfType(state: GraphState, type: NodeTypeId, at: Vec2) {
  const spec = NODE_TYPES[type];
  const newNode: NodeModel = {
    id: nextId(state, type),
    kind: ModelTypes.Node,
    type,
    label: spec.label,
    position: { x: Math.round(at.x - spec.size.x / 2), y: Math.round(at.y - spec.size.y / 2) },
    size: { ...spec.size }
  };
  newNode.ports = defaultPortsForNode(newNode);
  state.nodes.push(newNode);
  setSingleSelection(state, newNode.id);
  bringToFrontById(state, newNode.id);
  render(state);
}

export function deleteSelected(state:GraphState) {
  if (state.selectionMode === 'connection') {
    if (!state.selectedConnectionIDs.size) return;
    state.connections = state.connections.filter(c => !state.selectedConnectionIDs.has(c.id));
    state.selectedConnectionIDs.clear();
  } else {
    if (!state.selectedIDs.size) return;
    const doomed = new Set(state.selectedIDs);
    state.connections = state.connections.filter(c => !doomed.has(c.from.nodeId) && !doomed.has(c.to.nodeId));
    state.nodes = state.nodes.filter(n => !doomed.has(n.id));
    state.selectedIDs.clear();
    state.lastActiveID = null;
  }
  render(state);
}

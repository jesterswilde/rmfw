import { render } from "./drawing.js";
import {
  NODE_TYPES,
  ModelTypes,
  type GraphState,
  type NodeID,
  type NodeModel,
  type NodeTypeId,
  type Vec2,
  defaultPortsForNode,
} from "./interfaces.js";
import { setSingleSelection } from "./selection.js";

export function bringToFrontById(state: GraphState, id: NodeID) {
  const idx = state.nodes.findIndex((n) => n.id === id);
  if (idx >= 0 && idx !== state.nodes.length - 1) {
    const [n] = state.nodes.splice(idx, 1);
    state.nodes.push(n!);
  }
}
export function bringToFrontByIDs(state: GraphState, ids: Set<string>) {
  const front: NodeModel[] = [];
  const back: NodeModel[] = [];
  for (const node of state.nodes) (ids.has(node.id) ? back : front).push(node);
  state.nodes = [...front, ...back];
}

export function nextId(state: GraphState, base = "node"): NodeID {
  let id: string;
  do id = `${base}-${state.nextID++}`;
  while (state.nodes.some((n) => n.id === id));
  return id;
}

/* Build a NodeModel without writing undefined into optional fields */
export function hydrateNode(
  partial: Partial<NodeModel> & Pick<NodeModel, "id" | "label" | "position" | "size">,
  typeHint?: NodeTypeId
): NodeModel {
  const base: NodeModel = {
    id: partial.id,
    kind: ModelTypes.Node,
    label: partial.label,
    position: partial.position,
    size: partial.size,
    // type, selected, ports are added below conditionally
  } as unknown as NodeModel;

  if (partial.type ?? typeHint) {
    (base as any).type = (partial.type ?? typeHint)!;
  }
  if (partial.selected !== undefined) {
    (base as any).selected = partial.selected;
  }

  (base as any).ports = defaultPortsForNode(base);
  return base;
}

export function createNodeOfType(state: GraphState, type: NodeTypeId, at: Vec2) {
  const spec = NODE_TYPES[type];
  const newNode = hydrateNode(
    {
      id: nextId(state, type),
      label: spec.label,
      position: { x: Math.round(at.x - spec.size.x / 2), y: Math.round(at.y - spec.size.y / 2) },
      size: { ...spec.size },
      type,
    },
    type
  );
  state.nodes.push(newNode);
  setSingleSelection(state, newNode.id);
  bringToFrontById(state, newNode.id);
  render(state);
}

export function deleteSelected(state: GraphState) {
  if (!state.selectedIDs.size && !state.selectedConnectionIDs.size) return;

  if (state.selectedIDs.size) {
    const removed = new Set(state.selectedIDs);
    state.nodes = state.nodes.filter((n) => !removed.has(n.id));
    state.connections = state.connections.filter(
      (c) => !removed.has(c.from.nodeId) && !removed.has(c.to.nodeId)
    );
    state.selectedIDs.clear();
  }

  if (state.selectedConnectionIDs.size) {
    const keep = new Set(state.selectedConnectionIDs);
    state.connections = state.connections.filter((c) => !keep.has(c.id));
    state.selectedConnectionIDs.clear();
  }

  state.lastActiveID = null;
  render(state);
}

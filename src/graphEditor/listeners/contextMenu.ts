import { type MenuItem, showContextMenu } from "../../panes/contextMenu.js";
import { render } from "../drawing.js";
import {
  getCanvasPoint,
  hitTestNode,
  hitTestPort,
  hitTestConnection
} from "../helpers.js";
import {
  NODE_TYPES,
  type GraphState,
  type NodeID,
  type NodeTypeId
} from "../interfaces.js";
import {
  createNodeOfType,
  deleteSelected
} from "../node.js";
import {
  setSingleSelection,
  clearConnSelection,
  clearNodeSelection
} from "../selection.js";

export const makeContextMenu = (state: GraphState) => (ev: MouseEvent) => {
  const ptCanvas = getCanvasPoint(state, ev);
  const portHit = hitTestPort(state, ptCanvas);
  const connHit = portHit ? null : hitTestConnection(state, ptCanvas);
  const nodeHit = portHit || connHit ? null : hitTestNode(state, ptCanvas);

  if (connHit) {
    state.selectionMode = "connection";
    clearNodeSelection(state);
    state.selectedConnectionIDs = new Set([connHit.id]);
    const items: MenuItem[] = [{ kind: "action", id: "delete:conn", label: "Delete Connection" }];
    showContextMenu(ev, items, (id) => {
      if (id === "delete:conn") {
        state.connections = state.connections.filter((c) => c.id !== connHit.id);
        state.selectedConnectionIDs.clear();
        render(state);
      }
    });
    return;
  }

  if (nodeHit) {
    state.selectionMode = "node";
    clearConnSelection(state);
    if (!state.selectedIDs.has(nodeHit.id)) setSingleSelection(state, nodeHit.id);
    else state.lastActiveID = nodeHit.id;

    const multi = state.selectedIDs.size > 1;
    const items: MenuItem[] = multi
      ? [{ kind: "action", id: "delete:selected", label: "Delete Selected" }]
      : [{ kind: "action", id: "delete:one", label: `Delete "${nodeHit.label}"` }];

    showContextMenu(ev, items, (id) => {
      if (id === "delete:selected") deleteSelected(state);
      if (id === "delete:one") {
        state.selectedIDs = new Set<NodeID>([nodeHit.id]);
        deleteSelected(state);
      }
    });
    render(state);
    return;
  }

  const createItems: MenuItem[] = [
    {
      kind: "submenu",
      label: "Create",
      items: [
        { kind: "action", id: "create:geometry", label: NODE_TYPES.geometry.label },
        { kind: "action", id: "create:transform", label: NODE_TYPES.transform.label },
        { kind: "action", id: "create:material", label: NODE_TYPES.material.label },
        { kind: "action", id: "create:output", label: NODE_TYPES.output.label },
        { kind: "separator" },
        { kind: "action", id: "create:math", label: NODE_TYPES.math.label },
        { kind: "action", id: "create:group", label: NODE_TYPES.group.label },
      ],
    },
  ];

  showContextMenu(ev, createItems, (id) => {
    if (!id.startsWith("create:")) return;
    const t = id.split(":")[1] as NodeTypeId;
    clearConnSelection(state);
    createNodeOfType(state, t, ptCanvas);
  });
};

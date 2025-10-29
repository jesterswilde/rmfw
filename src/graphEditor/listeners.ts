import { type MenuItem, showContextMenu } from "../ui/contextMenu.js";
import { render } from "./drawing.js";
import {
  fitCanvasToDisplaySize,
  getCanvasPoint,
  hitTestNode,
  hitTestPort,
  hitTestConnection,
  findPortById,
  connectionIntersectsRect
} from "./helpers.js";
import {
  NODE_TYPES,
  type GraphState,
  type NodeID,
  type NodeTypeId
} from "./interfaces.js";
import {
  bringToFrontById,
  bringToFrontByIDs,
  createNodeOfType,
  deleteSelected
} from "./node.js";
import {
  startDragForSelection,
  moveDraggedNodes,
  setSingleSelection,
  toggleSelection,
  rectFromPoints,
  intersectsNode
} from "./selection.js";

const DRAG_THRESHOLD = 3;

function resolvePriorityTarget(
  state: GraphState,
  nodeHit: ReturnType<typeof hitTestNode>,
  connHit: ReturnType<typeof hitTestConnection>,
  portHit: ReturnType<typeof hitTestPort>
) {
  if (portHit) return portHit;
  return state.selectionMode === "connection"
    ? (connHit ?? nodeHit ?? null)
    : (nodeHit ?? connHit ?? null);
}

function clearNodeSelection(state: GraphState) {
  if (state.selectedIDs.size) state.selectedIDs.clear();
}
function clearConnSelection(state: GraphState) {
  if (state.selectedConnectionIDs.size) state.selectedConnectionIDs.clear();
}
function clearAllSelections(state: GraphState) {
  clearNodeSelection(state);
  clearConnSelection(state);
}

export const makePointerDown = (state: GraphState) => (evt: PointerEvent) => {
  const { canvas } = state;
  if (evt.button !== 0) return;
  canvas.setPointerCapture(evt.pointerId);
  const pt = getCanvasPoint(state, evt);
  state.lastPointerCanvasPos = pt;
  state.pointerDownAt = pt;

  // Start wire from either side; starting clears all selections
  const portHit =
    hitTestPort(state, pt) ??
    (state.hoverPortID ? findPortById(state, state.hoverPortID) : null);
  if (portHit) {
    clearAllSelections(state);
    state.wireDrag.active = true;
    state.wireDrag.from = {
      nodeId: portHit.node.id,
      portId: portHit.port.id,
    };
    state.wireDrag.toPos = pt;
    state.selectionMode = "connection";
    render(state);
    return;
  }

  const nodeHit = hitTestNode(state, pt);
  const connHit = hitTestConnection(state, pt);
  const target = resolvePriorityTarget(state, nodeHit, connHit, null);
  const additive = evt.shiftKey;

  // Connection click → enter connection mode, clear node selection
  if (target && "from" in target && "to" in target) {
    state.selectionMode = "connection";
    clearNodeSelection(state);
    if (additive) {
      if (state.selectedConnectionIDs.has(target.id))
        state.selectedConnectionIDs.delete(target.id);
      else state.selectedConnectionIDs.add(target.id);
    } else {
      state.selectedConnectionIDs = new Set([target.id]);
    }
    render(state);
    return;
  }

  // Node click → enter node mode, clear connection selection
  if (target && "position" in target) {
    state.selectionMode = "node";
    clearConnSelection(state);

    if (additive) {
      state.hasDragSelectionMoved = false;
      toggleSelection(state, target.id);
    } else if (!state.selectedIDs.has(target.id)) {
      bringToFrontById(state, target.id);
      setSingleSelection(state, target.id);
    } else {
      state.lastActiveID = target.id;
    }
    if (!state.hasDragSelectionMoved) {
      state.hasDragSelectionMoved = true;
      bringToFrontByIDs(state, state.selectedIDs);
    }
    startDragForSelection(state, pt);
    canvas.style.cursor = "grabbing";
    render(state);
    return;
  }

  // Empty space — begin marquee; clear the other type for clarity
  if (state.selectionMode === "connection") {
    clearNodeSelection(state);
    state.selectedConnectionIDs.clear();
  } else {
    clearConnSelection(state);
    state.selectedIDs.clear();
  }
  state.marquee.active = true;
  state.marquee.anchor = pt;
  state.marquee.current = pt;
  // We won't rely on baseSelection here; we snapshot per-move (see pointermove).
  state.marquee.baseSelection = null;
  state.dragging = false;
  state.hasDragSelectionMoved = false;
  render(state);
};

export const makePointerMove = (state: GraphState) => (evt: PointerEvent) => {
  const pt = getCanvasPoint(state, evt);
  state.lastPointerCanvasPos = pt;

  if (state.wireDrag.active) {
    state.wireDrag.toPos = pt;

    // Hover precedence while wiring: port → connection → node
    const portHit = hitTestPort(state, pt);
    const connHit = portHit ? null : hitTestConnection(state, pt);
    const nodeHit = portHit || connHit ? null : hitTestNode(state, pt);

    state.hoverPortID = portHit ? portHit.port.id : null;
    state.hoverConnectionID = state.hoverPortID ? null : connHit ? connHit.id : null;
    state.hoverID =
      state.hoverPortID || state.hoverConnectionID ? null : nodeHit ? nodeHit.id : null;

    state.canvas.style.cursor =
      state.hoverPortID || state.hoverConnectionID || state.hoverID ? "pointer" : "default";

    render(state); // always repaint during wire drag
    return;
  }

  if (state.marquee.active) {
    state.marquee.current = pt;

    // --- Marquee PREVIEW that follows "single-type" rule dynamically ---
    const { x, y, width, height } = rectFromPoints(
      state.marquee.anchor!,
      state.marquee.current!
    );

    // Snapshot current selections for additive union this frame
    const prevNodeSel = new Set(state.selectedIDs);
    const prevConnSel = new Set(state.selectedConnectionIDs);

    // Compute contents
    const nodeIds = new Set<string>();
    for (const n of state.nodes)
      if (intersectsNode(x, y, width, height, n)) nodeIds.add(n.id);

    const connIds = new Set<string>();
    for (const c of state.connections)
      if (connectionIntersectsRect(state, c, x, y, width, height)) connIds.add(c.id);

    const hasNodes = nodeIds.size > 0;
    const hasConns = connIds.size > 0;

    const additive = evt.shiftKey;

    if (hasNodes && !hasConns) {
      // Only nodes → preview nodes
      state.selectedConnectionIDs.clear();
      state.selectedIDs = additive
        ? new Set<string>([...prevNodeSel, ...nodeIds])
        : (nodeIds as Set<NodeID>);
    } else if (hasConns && !hasNodes) {
      // Only connections → preview connections
      state.selectedIDs.clear();
      state.selectedConnectionIDs = additive
        ? new Set<string>([...prevConnSel, ...connIds])
        : connIds;
    } else {
      // Mixed/empty → preview according to current mode
      if (state.selectionMode === "connection") {
        state.selectedIDs.clear();
        state.selectedConnectionIDs = additive
          ? new Set<string>([...prevConnSel, ...connIds])
          : connIds;
      } else {
        state.selectedConnectionIDs.clear();
        state.selectedIDs = additive
          ? new Set<string>([...prevNodeSel, ...nodeIds])
          : (nodeIds as Set<NodeID>);
      }
    }

    render(state);
    return;
  }

  if (state.dragging) {
    moveDraggedNodes(state, pt);
    render(state);
    return;
  }

  // Normal hover precedence: port → connection → node
  const portHit = hitTestPort(state, pt);
  const connHit = portHit ? null : hitTestConnection(state, pt);
  const nodeHit = portHit || connHit ? null : hitTestNode(state, pt);

  const newHoverPort = portHit ? portHit.port.id : null;
  const newHoverConn = connHit ? connHit.id : null;
  const newHoverNode = nodeHit ? nodeHit.id : null;

  let needRender = false;
  if (newHoverPort !== state.hoverPortID) {
    state.hoverPortID = newHoverPort;
    needRender = true;
  }
  if (state.hoverPortID) {
    if (state.hoverConnectionID !== null) {
      state.hoverConnectionID = null;
      needRender = true;
    }
    if (state.hoverID !== null) {
      state.hoverID = null;
      needRender = true;
    }
  } else {
    if (newHoverConn !== state.hoverConnectionID) {
      state.hoverConnectionID = newHoverConn;
      needRender = true;
    }
    if (state.hoverConnectionID) {
      if (state.hoverID !== null) {
        state.hoverID = null;
        needRender = true;
      }
    } else if (newHoverNode !== state.hoverID) {
      state.hoverID = newHoverNode;
      needRender = true;
    }
  }

  state.canvas.style.cursor =
    state.hoverPortID || state.hoverConnectionID || state.hoverID ? "pointer" : "default";

  // Drag start: threshold only
  if (state.pointerDownAt && state.selectedIDs.size) {
    const dx = Math.abs(pt.x - state.pointerDownAt.x);
    const dy = Math.abs(pt.y - state.pointerDownAt.y);
    if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
      startDragForSelection(state, pt);
      state.canvas.style.cursor = "grabbing";
      needRender = true;
    }
  }

  if (needRender) render(state);
};

/* Pointer end */
export const makePointerEnd = (state: GraphState) => (evt: PointerEvent) => {
  const pt = state.lastPointerCanvasPos;

  // Complete wire drag
  if (state.wireDrag.active) {
    const directHit = pt ? hitTestPort(state, pt) : null;
    const hoverFallback = state.hoverPortID
      ? findPortById(state, state.hoverPortID)
      : null;
    const end = directHit ?? hoverFallback;

    if (end && state.wireDrag.from) {
      const start = findPortById(state, state.wireDrag.from.portId);
      if (start) {
        const startSide = start.port.side;
        const endSide = end.port.side;

        if (startSide !== endSide) {
          const outputEnd = startSide === "output" ? start : end;
          const inputEnd = startSide === "output" ? end : start;

          const newConnId = `conn-${state.nextID++}`;
          state.connections.push({
            id: newConnId,
            from: {
              nodeId: outputEnd.node.id,
              portId: outputEnd.port.id,
            },
            to: {
              nodeId: inputEnd.node.id,
              portId: inputEnd.port.id,
            },
          });
          // selections were cleared on start
        }
      }
    }

    state.wireDrag = { active: false, toPos: null };

    // Refresh hover under pointer
    if (pt) {
      const portHit = hitTestPort(state, pt);
      const connHit = portHit ? null : hitTestConnection(state, pt);
      const nodeHit = portHit || connHit ? null : hitTestNode(state, pt);
      state.hoverPortID = portHit ? portHit.port.id : null;
      state.hoverConnectionID = state.hoverPortID ? null : connHit ? connHit.id : null;
      state.hoverID =
        state.hoverPortID || state.hoverConnectionID
          ? null
          : nodeHit
          ? nodeHit.id
          : null;
    }

    render(state);
  }

  // Marquee finished: adopt single-type rule (already previewing during drag)
  if (state.marquee.active) {
    // Decide final mode based on current preview (what's actually selected right now)
    const hasNodeSel = state.selectedIDs.size > 0;
    const hasConnSel = state.selectedConnectionIDs.size > 0;

    if (hasNodeSel && !hasConnSel) state.selectionMode = "node";
    else if (hasConnSel && !hasNodeSel) state.selectionMode = "connection";
    // Mixed/none: keep mode as-is

    state.marquee.active = false;
    state.marquee.anchor = null;
    state.marquee.current = null;
    state.marquee.baseSelection = null;
  }

  if (state.dragging) {
    state.dragging = false;
    state.dragOffsets.clear();
  }
  state.canvas.releasePointerCapture(evt.pointerId);
  state.pointerDownAt = null;

  state.canvas.style.cursor =
    state.hoverPortID || state.hoverConnectionID || state.hoverID ? "pointer" : "default";
  render(state);
};

/* Pointer leave */
export const makePointerLeave = (state: GraphState) => () => {
  if (!state.dragging && !state.marquee.active && !state.wireDrag.active) {
    if (state.hoverID || state.hoverConnectionID || state.hoverPortID) {
      state.hoverID = null;
      state.hoverConnectionID = null;
      state.hoverPortID = null;
      render(state);
    }
    state.canvas.style.cursor = "default";
  }
};

/* Keyboard */
export const makeKeyDown = (state: GraphState) => (e: KeyboardEvent) => {
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelected(state);
    return;
  }

  if (!mod && (e.key === "n" || e.key === "N")) {
    e.preventDefault();
    const { canvas } = state;
    const p =
      state.lastPointerCanvasPos ?? { x: canvas.width / 2, y: canvas.height / 2 };
    clearConnSelection(state); // entering node world via creation
    createNodeOfType(state, "group", p);
    return;
  }

  if (e.key === "Escape") {
    clearAllSelections(state);
    state.lastActiveID = null;
    state.wireDrag = { active: false, toPos: null };
    state.hoverPortID = null;
    render(state);
  }
};

/* Context menu */
export const makeContextMenu = (state: GraphState) => (ev: MouseEvent) => {
  const ptCanvas = getCanvasPoint(state, ev);
  const portHit = hitTestPort(state, ptCanvas);
  const connHit = portHit ? null : hitTestConnection(state, ptCanvas);
  const nodeHit = portHit || connHit ? null : hitTestNode(state, ptCanvas);

  if (connHit) {
    state.selectionMode = "connection";
    clearNodeSelection(state);
    state.selectedConnectionIDs = new Set([connHit.id]);
    const items: MenuItem[] = [
      { kind: "action", id: "delete:conn", label: "Delete Connection" },
    ];
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
      : [
          {
            kind: "action",
            id: "delete:one",
            label: `Delete "${nodeHit.label}"`,
          },
        ];

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
    clearConnSelection(state); // entering node world via creation menu
    createNodeOfType(state, t, ptCanvas);
  });
};

/* Resize / theme */
export const makeResizeOrThemeChange = (state: GraphState) => () => {
  fitCanvasToDisplaySize(state);
  render(state);
};

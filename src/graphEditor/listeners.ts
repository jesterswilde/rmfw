// listeners.ts
import { type MenuItem, showContextMenu } from "../ui/contextMenu.js";
import { render } from "./drawing.js";
import { fitCanvasToDisplaySize, getCanvasPoint, hitTest } from "./helpers.js";
import { NODE_TYPES, type GraphState, type NodeID, type NodeTypeId } from "./interfaces.js";
import { toggleSelection, bringToFrontById, setSingleSelection, bringToFrontByIDs, createNodeOfType, deleteSelected } from "./node.js";
import { startDragForSelection, updateMarqueeSelection, moveDraggedNodes } from "./selection.js";
import { refreshStyles } from "./styles.js";

const DRAG_THRESHOLD = 3;

export const makePointerDown = (state: GraphState)=>
    (evt: PointerEvent) => {
        const {canvas} = state;
        if (evt.button !== 0) 
            return;
        canvas.setPointerCapture(evt.pointerId);
        const pt = getCanvasPoint(state, evt);
        state.lastPointerCanvasPos = pt;
        state.pointerDownAt = pt;

        const target = hitTest(state, pt);
        const additive = evt.shiftKey;

        if (target) {
            if (additive){
                state.hasDragSelectionMoved = false;
                toggleSelection(state, target.id);
            } else if (!state.selectedIDs.has(target.id)) {
                bringToFrontById(state, target.id);
                setSingleSelection(state, target.id);
            } else {
            state.lastActiveID = target.id;
            }

            if(!state.hasDragSelectionMoved){
                state.hasDragSelectionMoved = true;
                bringToFrontByIDs(state, state.selectedIDs);
            }
            startDragForSelection(state, pt);
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
    };

export const makePointerMove = (state:GraphState)=>
    (evt: PointerEvent) => {
        const pt = getCanvasPoint(state, evt);
        state.lastPointerCanvasPos = pt;

        if (state.marquee.active) {
            state.marquee.current = pt;
            updateMarqueeSelection(state);
            render(state);
            return;
        }

        if (state.dragging) {
            moveDraggedNodes(state, pt);
            render(state);
            return;
        }

        const over = hitTest(state, pt);
        const newHover = over ? over.id : null;
        if (newHover !== state.hoverID) {
            state.hoverID = newHover;
            state.canvas.style.cursor = state.hoverID ? 'pointer' : 'default';
            render(state);
        }

        if (state.pointerDownAt && state.selectedIDs.size && over && state.selectedIDs.has(over.id)) {
            const dx = Math.abs(pt.x - state.pointerDownAt.x);
            const dy = Math.abs(pt.y - state.pointerDownAt.y);
            if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
            startDragForSelection(state, pt);
            state.canvas.style.cursor = 'grabbing';
        }
    }
};

/**
 * Pointer end (used for both pointerup & pointercancel)
 */
export const makePointerEnd = (state: GraphState) =>
  (evt: PointerEvent)=> {
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
    state.canvas.releasePointerCapture(evt.pointerId);
    state.pointerDownAt = null;
    state.canvas.style.cursor = state.hoverID ? "pointer" : "default";
    render(state);
  };

/**
 * Pointer leave
 */
export const makePointerLeave = (state: GraphState) =>
  ()=>{
    if (!state.dragging && !state.marquee.active) {
      if (state.hoverID) {
        state.hoverID = null;
        render(state);
      }
      state.canvas.style.cursor = "default";
    }
  };

/**
 * Keyboard
 */
export const makeKeyDown = (state: GraphState)=> 
  (e: KeyboardEvent)=> {
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelected(state);
      return;
    }

    if (!mod && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      const { canvas } = state;
      const p = state.lastPointerCanvasPos ?? {
        x: canvas.width / 2,
        y: canvas.height / 2,
      };
      createNodeOfType(state, "group", p);
      return;
    }

    if (e.key === "Escape") {
      state.selectedIDs.clear();
      state.lastActiveID = null;
      render(state);
    }
  };

/**
 * Context menu
 */
export const makeContextMenu = (state: GraphState)=>
  (ev: MouseEvent)=> {
    const ptCanvas = getCanvasPoint(state, ev);
    const target = hitTest(state, ptCanvas);

    if (target) {
      if (!state.selectedIDs.has(target.id)) setSingleSelection(state, target.id);
      else state.lastActiveID = target.id;

      const multi = state.selectedIDs.size > 1;
      const items: MenuItem[] = multi
        ? [{ kind: "action", id: "delete:selected", label: "Delete Selected" }]
        : [{ kind: "action", id: "delete:one", label: `Delete "${target.label}"` }];

      showContextMenu(ev, items, (id) => {
        if (id === "delete:selected") deleteSelected(state);
        if (id === "delete:one") {
          state.selectedIDs = new Set<NodeID>([target.id]);
          deleteSelected(state);
        }
      });

      render(state);
    } else {
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
        createNodeOfType(state, t, ptCanvas);
      });
    }
  };

/**
 * Resize / theme change
 */
export const makeResizeOrThemeChange = (state: GraphState)=>
  ()=> {
    refreshStyles();
    fitCanvasToDisplaySize(state);
    render(state);
  };

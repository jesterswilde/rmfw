import { render } from "../drawing.js";
import { createNodeOfType, deleteSelected } from "../node.js";
import { clearAllSelections, clearConnSelection } from "../selection.js";
import type { GraphState } from "../interfaces.js";

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
    const p = state.lastPointerCanvasPos ?? { x: canvas.width / 2, y: canvas.height / 2 };
    clearConnSelection(state);
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

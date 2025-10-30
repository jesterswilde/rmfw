import { fitCanvasToDisplaySize } from "../helpers.js";
import { render } from "../drawing.js";
import type { GraphState } from "../interfaces.js";

export const makeResizeOrThemeChange = (state: GraphState) => () => {
  fitCanvasToDisplaySize(state);
  render(state);
};

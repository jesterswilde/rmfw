export enum Orientation {
  Vertical = "vertical",
  Horizontal = "horizontal",
}

export enum PaneType {
  Viewport   = "Viewport",
  Output     = "Output",
  Properties = "Properties",
}

/** Base for pane ui tree nodes */
export interface BaseNode {
  id: string;
  minPx?: number; // absolute minimum size along the split axis
  spanH?: number;   // required parallel columns under this node
  spanV?: number;   // required parallel rows under this node
}

/** Leaf node: a pane type (placeholder color for now) */
export interface LeafNode extends BaseNode {
  kind: "leaf";
  paneType: PaneType;
}

/** A fixed-size child entry within a split node (size is % of parent along axis). */
export interface ChildEntry {
  sizePct: number; // 0..100
  node: Node;
}

/** Split node: contains children and an orientation for layout */
export interface SplitNode extends BaseNode {
  kind: "split";
  orientation: Orientation;
  children: ChildEntry[];
}

/** Discriminated union for our tree */
export type Node = LeafNode | SplitNode;

/** Render result */
export interface RenderResult {
  el: HTMLElement;
  destroy: () => void;
}

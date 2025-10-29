export type NodeID = string;

export interface Vec2 { x: number; y: number }
export interface NodeRect { x: number; y: number; width: number; height: number; }

export interface NodeModel {
  id: NodeID;
  label: string;
  position: Vec2; // top-left in canvas coords
  size: Vec2;     // width / height
  selected?: boolean;
}

export interface MarqueeState {
  active: boolean;
  anchor: Vec2 | null;     // pointer-down origin in canvas space
  current: Vec2 | null;    // current pointer in canvas space
  baseSelection: Set<NodeID> | null; // selection snapshot at start (for additive)
}

export interface GraphState {
  nodes: NodeModel[];
  selectedIDs: Set<NodeID>;
  lastActiveID: NodeID | null;
  hoverID: NodeID | null;
  dragging: boolean;
  dragOffsets: Map<NodeID, Vec2>; // per selected node offset = pointer - node.position
  hasDragSelectionMoved: boolean;
  marquee: MarqueeState;
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
}

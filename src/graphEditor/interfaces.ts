export type NodeID = string;
export type NodeTypeId = 'geometry' | 'transform' | 'material' | 'output' | 'math' | 'group';

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

export const NODE_TYPES: Record<NodeTypeId, { label: string; size: Vec2 }> = {
  geometry:  { label: 'Geometry',        size: { x: 160, y: 80 } },
  transform: { label: 'Transform',       size: { x: 180, y: 88 } },
  material:  { label: 'Material',        size: { x: 170, y: 80 } },
  output:    { label: 'Render Output',   size: { x: 200, y: 96 } },
  math:      { label: 'Math',            size: { x: 140, y: 72 } },
  group:     { label: 'Group',           size: { x: 180, y: 96 } },
};


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
  pointerDownAt: Vec2 | null
  lastPointerCanvasPos: Vec2 | null
  nextID: number
}
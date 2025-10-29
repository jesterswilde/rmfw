export type NodeID = string;
export type NodeTypeId = 'geometry' | 'transform' | 'material' | 'output' | 'math' | 'group';

export interface Vec2 { x: number; y: number }
export interface NodeRect { x: number; y: number; width: number; height: number; }

export type PortID = string;
export type ConnectionID = string;
export type SelectionMode = 'node' | 'connection';
export type PortSide = 'input' | 'output';

export enum ModelTypes {
  Port,
  Connection,
  Node
}

export interface PortModel {
  id: PortID;
  kind: ModelTypes.Port
  name: string;
  side: PortSide;
  index: number;
}

export interface NodePorts {
  inputs: PortModel[];
  outputs: PortModel[];
}

export interface ConnectionModel {
  id: ConnectionID;
  kind: ModelTypes.Connection;
  from: { nodeId: NodeID; portId: PortID };
  to:   { nodeId: NodeID; portId: PortID };
}

export interface NodeModel {
  id: NodeID;
  kind: ModelTypes.Node;
  label: string;
  position: Vec2;
  size: Vec2;
  selected?: boolean;
  type?: NodeTypeId;
  ports?: NodePorts;
}

export interface MarqueeState {
  active: boolean;
  anchor: Vec2 | null;
  current: Vec2 | null;
  baseSelection: Set<string> | null;
}

export const NODE_TYPES: Record<NodeTypeId, { label: string; size: Vec2 }> = {
  geometry:  { label: 'Geometry',        size: { x: 160, y: 80 } },
  transform: { label: 'Transform',       size: { x: 180, y: 88 } },
  material:  { label: 'Material',        size: { x: 170, y: 80 } },
  output:    { label: 'Render Output',   size: { x: 200, y: 96 } },
  math:      { label: 'Math',            size: { x: 140, y: 72 } },
  group:     { label: 'Group',           size: { x: 180, y: 96 } },
};

export interface WireDragState {
  active: boolean;
  from?: { nodeId: NodeID; portId: PortID };
  toPos?: Vec2 | null;
}

export interface GraphState {
  nodes: NodeModel[];
  connections: ConnectionModel[];
  selectedIDs: Set<NodeID>;
  selectedConnectionIDs: Set<ConnectionID>;
  selectionMode: SelectionMode;
  lastActiveID: NodeID | null;
  hoverID: NodeID | null;
  hoverConnectionID: ConnectionID | null;
  hoverPortID: PortID | null;                 // NEW
  dragging: boolean;
  dragOffsets: Map<NodeID, Vec2>;
  hasDragSelectionMoved: boolean;
  marquee: MarqueeState;
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  pointerDownAt: Vec2 | null
  lastPointerCanvasPos: Vec2 | null
  wireDrag: WireDragState
  nextID: number
}

export function defaultPortsForNode(n: NodeModel): NodePorts {
  const allowIn = n.type !== 'geometry';
  const allowOut = n.type !== 'output';
  return {
    inputs: allowIn ? [{ id: `${n.id}:in0`, kind: ModelTypes.Port, name: 'in', side: 'input', index: 0 }] : [],
    outputs: allowOut ? [{ id: `${n.id}:out0`, kind: ModelTypes.Port, name: 'out', side: 'output', index: 0 }] : [],
  };
}

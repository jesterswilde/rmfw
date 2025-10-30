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

export type PortType = 'transform' | 'render';
export type PortCapacity = number | 'unlimited';

export interface PortModel {
  id: PortID;
  kind: ModelTypes.Port;
  name?: string;
  side: PortSide;
  index: number;
  portType: PortType;
  maxConnections?: PortCapacity;
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
  portType: PortType;
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
  hoverPortID: PortID | null;
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

/* --- Default ports (vertical layout; richer, mixed groups) --- */
export function defaultPortsForNode(n: NodeModel): NodePorts {
  const type = n.type ?? 'group';

  let inIdx = 0, outIdx = 0;

  const mkIn = (portType: PortType, name?: string, max: PortCapacity = 1): PortModel => {
    const base: Omit<PortModel, 'name'> & { name?: string } = {
      id: `${n.id}:in${inIdx}`,
      kind: ModelTypes.Port,
      side: 'input',
      index: inIdx++,
      portType,
      maxConnections: max
    };
    if (name !== undefined) (base as PortModel).name = name;
    return base as PortModel;
  };

  const mkOut = (portType: PortType, name?: string, max: PortCapacity = 'unlimited'): PortModel => {
    const base: Omit<PortModel, 'name'> & { name?: string } = {
      id: `${n.id}:out${outIdx}`,
      kind: ModelTypes.Port,
      side: 'output',
      index: outIdx++,
      portType,
      maxConnections: max
    };
    if (name !== undefined) (base as PortModel).name = name;
    return base as PortModel;
  };

  switch (type) {
    case 'geometry':
      return {
        inputs: [],
        outputs: [mkOut('transform', 'geo')],
      };
    case 'transform':
      return {
        inputs:  [mkIn('transform', 'in')],
        outputs: [mkOut('transform', 'out')],
      };
    case 'material':
      return {
        inputs:  [mkIn('render', 'base'), mkIn('render', 'detail')],
        outputs: [mkOut('render', 'mat')],
      };
    case 'output':
      return {
        inputs:  [mkIn('render', 'surface'), mkIn('transform', 'xf')],
        outputs: [],
      };
    case 'math':
      return {
        inputs:  [mkIn('render', 'a'), mkIn('render', 'b')],
        outputs: [mkOut('render', 'sum')],
      };
    case 'group':
    default:
      return {
        inputs:  [mkIn('render', 'r-in'), mkIn('transform', 't-in')],
        outputs: [mkOut('render', 'r-out'), mkOut('transform', 't-out')],
      };
  }
}

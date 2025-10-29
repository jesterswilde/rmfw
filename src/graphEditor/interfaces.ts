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

export interface GraphState{
  nodes: NodeModel[]
  selectedID: NodeID | null
  hoverID: NodeID | null
  ctx: CanvasRenderingContext2D
  draggingID: NodeID | null
  dragOffset: Vec2
  canvas: HTMLCanvasElement
}
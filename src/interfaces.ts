// src/interfaces.ts

export enum RenderKind {
  None = 0,
  Shape = 1,
  Op = 2,
}


////////////////////////////////////////////////////////
// Important note, ShapeType and OpType can have NO OVERLAP. The GPU reads them from the same slot and switches based on it.
////////////////////////////////////////////////////////
export enum ShapeType {
  None = 0,
  Sphere = 1,
  box = 2,
}

export enum OpType {
  Union = 20,
  SimpleUnion = 21,
  SimpleSubtract = 22,
  SimpleIntersection = 23,
}

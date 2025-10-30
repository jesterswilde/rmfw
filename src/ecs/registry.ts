// ecs/registry.ts
// Registry with true SoA scalar columns (no lanes).

import { World, type ComponentDef, type ComponentSchema } from "./core";

// ----- Component schemas (every field is scalar = 1 column) -----

export const Transform: ComponentDef<ComponentSchema> = {
  name: "Transform",
  schema: {
    // Local 3x4 (row-major)
    local_r00: { ctor: Float32Array }, local_r01: { ctor: Float32Array }, local_r02: { ctor: Float32Array }, local_tx:  { ctor: Float32Array },
    local_r10: { ctor: Float32Array }, local_r11: { ctor: Float32Array }, local_r12: { ctor: Float32Array }, local_ty:  { ctor: Float32Array },
    local_r20: { ctor: Float32Array }, local_r21: { ctor: Float32Array }, local_r22: { ctor: Float32Array }, local_tz:  { ctor: Float32Array },

    // World 3x4 (row-major)
    world_r00: { ctor: Float32Array }, world_r01: { ctor: Float32Array }, world_r02: { ctor: Float32Array }, world_tx:  { ctor: Float32Array },
    world_r10: { ctor: Float32Array }, world_r11: { ctor: Float32Array }, world_r12: { ctor: Float32Array }, world_ty:  { ctor: Float32Array },
    world_r20: { ctor: Float32Array }, world_r21: { ctor: Float32Array }, world_r22: { ctor: Float32Array }, world_tz:  { ctor: Float32Array },

    // Inverse World 3x4 (row-major)
    inv_r00: { ctor: Float32Array }, inv_r01: { ctor: Float32Array }, inv_r02: { ctor: Float32Array }, inv_tx:  { ctor: Float32Array },
    inv_r10: { ctor: Float32Array }, inv_r11: { ctor: Float32Array }, inv_r12: { ctor: Float32Array }, inv_ty:  { ctor: Float32Array },
    inv_r20: { ctor: Float32Array }, inv_r21: { ctor: Float32Array }, inv_r22: { ctor: Float32Array }, inv_tz:  { ctor: Float32Array },

    // Dirty bit
    dirty: { ctor: Int32Array },
  },
};

export const TransformNode: ComponentDef<ComponentSchema> = {
  name: "TransformNode",
  schema: {
    parent:      { ctor: Int32Array },  // -1 if root
    firstChild:  { ctor: Int32Array },  // first child
    nextSibling: { ctor: Int32Array },  // sibling
  },
};

export const RenderNode: ComponentDef<ComponentSchema> = {
  name: "RenderNode",
  schema: {
    parent:      { ctor: Int32Array },
    firstChild:  { ctor: Int32Array },
    nextSibling: { ctor: Int32Array },
  },
};

export const ShapeLeaf: ComponentDef<ComponentSchema> = {
  name: "ShapeLeaf",
  schema: {
    shapeType: { ctor: Int32Array }, // renderer interprets
    p0: { ctor: Float32Array },
    p1: { ctor: Float32Array },
    p2: { ctor: Float32Array },
    p3: { ctor: Float32Array },
    p4: { ctor: Float32Array },
    p5: { ctor: Float32Array },
  },
};

export const Operation: ComponentDef<ComponentSchema> = {
  name: "Operation",
  schema: {
    opType: { ctor: Int32Array },   // union / subtract / intersect...
  },
};

// ----- Registry setup helper -----
export function initWorld(cfg?: { initialCapacity?: number }) {
  const world = new World({ initialCapacity: cfg?.initialCapacity ?? 1024 });

  world.register(Transform, 256);
  world.register(TransformNode, 256);
  world.register(RenderNode, 256);
  world.register(ShapeLeaf, 256);
  world.register(Operation, 256);

  return world;
}

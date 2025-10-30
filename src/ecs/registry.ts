// Registry with self-describing component metadata (ordered fields, defaults, link flags)

import { World, type ComponentDef, type ComponentMeta } from "./core.js";

// ----- Component metas (every field is a scalar = 1 column) -----

export const TransformMeta: ComponentMeta = {
  name: "Transform",
  fields: [
    // Local 3x4 (row-major)
    { key: "local_r00", ctor: Float32Array, default: 1 },
    { key: "local_r01", ctor: Float32Array, default: 0 },
    { key: "local_r02", ctor: Float32Array, default: 0 },
    { key: "local_tx",  ctor: Float32Array, default: 0 },

    { key: "local_r10", ctor: Float32Array, default: 0 },
    { key: "local_r11", ctor: Float32Array, default: 1 },
    { key: "local_r12", ctor: Float32Array, default: 0 },
    { key: "local_ty",  ctor: Float32Array, default: 0 },

    { key: "local_r20", ctor: Float32Array, default: 0 },
    { key: "local_r21", ctor: Float32Array, default: 0 },
    { key: "local_r22", ctor: Float32Array, default: 1 },
    { key: "local_tz",  ctor: Float32Array, default: 0 },

    // World 3x4 (row-major) — included in store; usually omitted in save
    { key: "world_r00", ctor: Float32Array, default: 0 },
    { key: "world_r01", ctor: Float32Array, default: 0 },
    { key: "world_r02", ctor: Float32Array, default: 0 },
    { key: "world_tx",  ctor: Float32Array, default: 0 },

    { key: "world_r10", ctor: Float32Array, default: 0 },
    { key: "world_r11", ctor: Float32Array, default: 0 },
    { key: "world_r12", ctor: Float32Array, default: 0 },
    { key: "world_ty",  ctor: Float32Array, default: 0 },

    { key: "world_r20", ctor: Float32Array, default: 0 },
    { key: "world_r21", ctor: Float32Array, default: 0 },
    { key: "world_r22", ctor: Float32Array, default: 0 },
    { key: "world_tz",  ctor: Float32Array, default: 0 },

    // Inverse World 3x4 (row-major) — included in store; usually omitted in save
    { key: "inv_r00", ctor: Float32Array, default: 0 },
    { key: "inv_r01", ctor: Float32Array, default: 0 },
    { key: "inv_r02", ctor: Float32Array, default: 0 },
    { key: "inv_tx",  ctor: Float32Array, default: 0 },

    { key: "inv_r10", ctor: Float32Array, default: 0 },
    { key: "inv_r11", ctor: Float32Array, default: 0 },
    { key: "inv_r12", ctor: Float32Array, default: 0 },
    { key: "inv_ty",  ctor: Float32Array, default: 0 },

    { key: "inv_r20", ctor: Float32Array, default: 0 },
    { key: "inv_r21", ctor: Float32Array, default: 0 },
    { key: "inv_r22", ctor: Float32Array, default: 0 },
    { key: "inv_tz",  ctor: Float32Array, default: 0 },

    // Dirty bit (kept in store; not serialized in v1)
    { key: "dirty", ctor: Int32Array, default: 0 },
  ],
};

export const TransformNodeMeta: ComponentMeta = {
  name: "TransformNode",
  fields: [
    { key: "parent",      ctor: Int32Array, default: -1, link: true }, // -1 if root
    { key: "firstChild",  ctor: Int32Array, default: -1, link: true }, // head of child list
    { key: "nextSibling", ctor: Int32Array, default: -1, link: true }, // sibling
  ],
};

export const RenderNodeMeta: ComponentMeta = {
  name: "RenderNode",
  fields: [
    { key: "parent",      ctor: Int32Array, default: -1, link: true },
    { key: "firstChild",  ctor: Int32Array, default: -1, link: true },
    { key: "nextSibling", ctor: Int32Array, default: -1, link: true },
  ],
};

export const ShapeLeafMeta: ComponentMeta = {
  name: "ShapeLeaf",
  fields: [
    { key: "shapeType", ctor: Int32Array,   default: 0 }, // renderer interprets
    { key: "p0",        ctor: Float32Array, default: 0 },
    { key: "p1",        ctor: Float32Array, default: 0 },
    { key: "p2",        ctor: Float32Array, default: 0 },
    { key: "p3",        ctor: Float32Array, default: 0 },
    { key: "p4",        ctor: Float32Array, default: 0 },
    { key: "p5",        ctor: Float32Array, default: 0 },
  ],
};

export const OperationMeta: ComponentMeta = {
  name: "Operation",
  fields: [
    { key: "opType", ctor: Int32Array, default: 0 }, // union / subtract / intersect...
  ],
};

// Convenient exports (name-same-as-meta for existing code)
export const Transform   = { meta: TransformMeta }   satisfies ComponentDef;
export const TransformNode = { meta: TransformNodeMeta } satisfies ComponentDef;
export const RenderNode  = { meta: RenderNodeMeta }  satisfies ComponentDef;
export const ShapeLeaf   = { meta: ShapeLeafMeta }   satisfies ComponentDef;
export const Operation   = { meta: OperationMeta }   satisfies ComponentDef;

// ----- Registry setup helper -----
export function initWorld(cfg?: { initialCapacity?: number }) {
  const world = new World({ initialCapacity: cfg?.initialCapacity ?? 1024 });

  world.register(Transform,     256);
  world.register(TransformNode, 256);
  world.register(RenderNode,    256);
  world.register(ShapeLeaf,     256);
  world.register(Operation,     256);

  return world;
}

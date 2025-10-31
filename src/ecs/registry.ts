// src/ecs/registry.ts
// Registry with self-describing component metadata (ordered fields, defaults, link flags)

import { World, defineMeta, type Def, type ComponentMeta } from "./core.js";

const NONE = -1;

// ----- Component metas (each field is a scalar = 1 column) -----

export const TransformMeta = defineMeta({
  name: "Transform",
  fields: [
    // Local 3x4 (row-major): identity defaults
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

    // World 3x4 (row-major) — default to identity
    { key: "world_r00", ctor: Float32Array, default: 1 },
    { key: "world_r01", ctor: Float32Array, default: 0 },
    { key: "world_r02", ctor: Float32Array, default: 0 },
    { key: "world_tx",  ctor: Float32Array, default: 0 },

    { key: "world_r10", ctor: Float32Array, default: 0 },
    { key: "world_r11", ctor: Float32Array, default: 1 },
    { key: "world_r12", ctor: Float32Array, default: 0 },
    { key: "world_ty",  ctor: Float32Array, default: 0 },

    { key: "world_r20", ctor: Float32Array, default: 0 },
    { key: "world_r21", ctor: Float32Array, default: 0 },
    { key: "world_r22", ctor: Float32Array, default: 1 },
    { key: "world_tz",  ctor: Float32Array, default: 0 },

    // Inverse World 3x4 (row-major) — default to identity
    { key: "inv_r00", ctor: Float32Array, default: 1 },
    { key: "inv_r01", ctor: Float32Array, default: 0 },
    { key: "inv_r02", ctor: Float32Array, default: 0 },
    { key: "inv_tx",  ctor: Float32Array, default: 0 },

    { key: "inv_r10", ctor: Float32Array, default: 0 },
    { key: "inv_r11", ctor: Float32Array, default: 1 },
    { key: "inv_r12", ctor: Float32Array, default: 0 },
    { key: "inv_ty",  ctor: Float32Array, default: 0 },

    { key: "inv_r20", ctor: Float32Array, default: 0 },
    { key: "inv_r21", ctor: Float32Array, default: 0 },
    { key: "inv_r22", ctor: Float32Array, default: 1 },
    { key: "inv_tz",  ctor: Float32Array, default: 0 },

    // Dirty bit (kept in store; not serialized in v1)
    { key: "dirty", ctor: Int32Array, default: 0 },
  ] as const,
});

export const TransformNodeMeta = defineMeta({
  name: "TransformNode",
  fields: [
    { key: "parent",      ctor: Int32Array, default: NONE, link: true }, // -1 if root
    { key: "firstChild",  ctor: Int32Array, default: NONE, link: true }, // head of child list
    { key: "lastChild",   ctor: Int32Array, default: NONE, link: true }, // tail of child list (O(1) append)
    { key: "nextSibling", ctor: Int32Array, default: NONE, link: true }, // next sibling
    { key: "prevSibling", ctor: Int32Array, default: NONE, link: true }, // prev sibling (O(1) detach)
  ] as const,
});

export const RenderNodeMeta = defineMeta({
  name: "RenderNode",
  fields: [
    { key: "parent",      ctor: Int32Array, default: NONE, link: true },
    { key: "firstChild",  ctor: Int32Array, default: NONE, link: true },
    { key: "lastChild",   ctor: Int32Array, default: NONE, link: true }, // tail of child list (O(1) append)
    { key: "nextSibling", ctor: Int32Array, default: NONE, link: true },
    { key: "prevSibling", ctor: Int32Array, default: NONE, link: true },
  ] as const,
});

export const ShapeLeafMeta = defineMeta({
  name: "ShapeLeaf",
  fields: [
    { key: "shapeType", ctor: Int32Array,   default: 0 }, // renderer interprets
    { key: "p0",        ctor: Float32Array, default: 0 },
    { key: "p1",        ctor: Float32Array, default: 0 },
    { key: "p2",        ctor: Float32Array, default: 0 },
    { key: "p3",        ctor: Float32Array, default: 0 },
    { key: "p4",        ctor: Float32Array, default: 0 },
    { key: "p5",        ctor: Float32Array, default: 0 },
  ] as const,
});

export const OperationMeta = defineMeta({
  name: "Operation",
  fields: [
    { key: "opType", ctor: Int32Array, default: 0 }, // union / subtract / intersect...
  ] as const,
});

// Convenient defs (typed)
export const Transform:     Def<typeof TransformMeta>     = { meta: TransformMeta };
export const TransformNode: Def<typeof TransformNodeMeta> = { meta: TransformNodeMeta };
export const RenderNode:    Def<typeof RenderNodeMeta>    = { meta: RenderNodeMeta };
export const ShapeLeaf:     Def<typeof ShapeLeafMeta>     = { meta: ShapeLeafMeta };
export const Operation:     Def<typeof OperationMeta>     = { meta: OperationMeta };

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

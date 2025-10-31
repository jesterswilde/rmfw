// src/ecs/components/bakedXform.ts
// Baked per-shape transform (object→world inverse; optionally world if we want).
// Registered ad-hoc in tests or app bootstrap until added to the central registry.

import { defineMeta, type Def } from "../core.js";

export const BakedXformMeta = defineMeta({
  name: "BakedXform",
  fields: [
    // Inverse World 3x4 (row-major): rows then translation (same layout as Transform.inv_*)
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
  ] as const,
});

export const BakedXform: Def<typeof BakedXformMeta> = { meta: BakedXformMeta };

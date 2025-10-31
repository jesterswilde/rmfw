// src/ecs/systems/bakeShapeXforms.ts
// Per-shape baking: copy Transform inverse into BakedXform when either changes.
// This keeps render-time fully hierarchical-free for shapes.

import { World } from "../core.js";
import { ShapeLeafMeta, TransformMeta } from "../registry.js";
import { BakedXform, BakedXformMeta } from "../components/bakedXform.js";

export function ensureBakedXformStore(world: World) {
  try {
    return world.storeOf(BakedXformMeta);
  } catch {
    // Not registered yet — register with a reasonable capacity
    return world.register(BakedXform, 256);
  }
}

export function bakeShapeXforms(world: World) {
  const transformStore = world.storeOf(TransformMeta);
  const shapeStore = world.storeOf(ShapeLeafMeta);
  const bakedStore = ensureBakedXformStore(world);

  const tf = transformStore.fields();
  const bx = bakedStore.fields();

  const q = world.queryView("ShapeLeaf", "Transform");
  const cachedSrcVersion = new Uint32Array(bakedStore.capacity); // local scratch per call isn’t ideal long-term; Phase 4 can persist this

  for (let i = 0; i < q.count; i++) {
    const shapeRow = q.rows["ShapeLeaf"]![i]!;
    const tRow = q.rows["Transform"]![i]!;

    // Ensure BakedXform row exists for the same entity
    const e = q.entities[i]!;
    let bxRow = bakedStore.denseIndexOf(e);
    if (bxRow < 0) bxRow = bakedStore.add(e);

    // If transform rowVersion changed, refresh baked inverse
    const tVersion = transformStore.rowVersion[tRow]!;
    if (cachedSrcVersion[bxRow] !== tVersion) {
      bx.inv_r00[bxRow] = tf.inv_r00[tRow]!;
      bx.inv_r01[bxRow] = tf.inv_r01[tRow]!;
      bx.inv_r02[bxRow] = tf.inv_r02[tRow]!;
      bx.inv_tx [bxRow] = tf.inv_tx [tRow]!;
      bx.inv_r10[bxRow] = tf.inv_r10[tRow]!;
      bx.inv_r11[bxRow] = tf.inv_r11[tRow]!;
      bx.inv_r12[bxRow] = tf.inv_r12[tRow]!;
      bx.inv_ty [bxRow] = tf.inv_ty [tRow]!;
      bx.inv_r20[bxRow] = tf.inv_r20[tRow]!;
      bx.inv_r21[bxRow] = tf.inv_r21[tRow]!;
      bx.inv_r22[bxRow] = tf.inv_r22[tRow]!;
      bx.inv_tz [bxRow] = tf.inv_tz [tRow]!;

      bakedStore.rowVersion[bxRow] = (bakedStore.rowVersion[bxRow]! + 1) >>> 0;
      (bakedStore as any).storeEpoch++;
      cachedSrcVersion[bxRow] = tVersion;
    }
  }
}

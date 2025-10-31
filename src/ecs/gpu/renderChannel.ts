// src/ecs/gpu/renderChannel.ts
// Packs Render stream (ops or shapes) in RenderTree DFS order with incremental uploads.
// Row layout (32 bytes / 8 x 32-bit lanes):
//   [i32 kind, i32 subTypeOrOp, f32 p0, f32 p1, f32 p2, f32 p3, f32 p4, f32 p5]
// where kind: 0 = none, 1 = shape (ShapeLeaf), 2 = operation (Operation)

import type { StoreView, World } from "../core.js";
import { BaseChannel, BYTES_PER_F32, type DfsOrder } from "./baseChannel.js";
import { RenderKind } from "../../interfaces.js";
import { ShapeLeafMeta, OperationMeta } from "../registry.js";

type MetaName<M extends { name: string }> = M["name"];
type MetaKeys<M extends { fields: readonly { key: string }[] }> =
  M["fields"][number]["key"];

export type RenderSyncArgs = {
  order: DfsOrder;    // RenderTree.order
  orderEpoch: number; // RenderTree.epoch
  shapeStore: StoreView<MetaName<typeof ShapeLeafMeta>, MetaKeys<typeof ShapeLeafMeta>>;
  opStore: StoreView<MetaName<typeof OperationMeta>, MetaKeys<typeof OperationMeta>>;
};

const LANES_PER_ROW = 8; // 2 int32 + 6 float32
const BYTES_PER_ROW = LANES_PER_ROW * BYTES_PER_F32;

export class RenderChannel extends BaseChannel {
  // Version tracking for incremental uploads
  private shapeStoreEpochSeen = -1;
  private opStoreEpochSeen = -1;
  private shapeRowVersionSeen = new Uint32Array(0);
  private opRowVersionSeen = new Uint32Array(0);

  // Presence + subtype cache per-entity to catch add/remove or kind switches without full rebuild
  private kindSeen = new Int8Array(0);     // 0/1/2 per entity id
  private subtypeSeen = new Int32Array(0); // last shapeType/opType per entity id

  private ensureEntityCaches(world: World) {
    const need = world.entityEpoch.length | 0;
    if (this.kindSeen.length >= need) return;
    const n = Math.max(this.kindSeen.length << 1 || 1, need);
    const nk = new Int8Array(n); nk.set(this.kindSeen); this.kindSeen = nk;
    const ns = new Int32Array(n); ns.set(this.subtypeSeen); this.subtypeSeen = ns;
  }

  override sync(world: World, args: RenderSyncArgs): boolean {
    const { order, orderEpoch, shapeStore, opStore } = args;

    const rows = order.length | 0;
    this.ensureCpu(rows, BYTES_PER_ROW);
    this.ensureEntityCaches(world);

    // Expand row version caches to store capacities
    if (this.shapeRowVersionSeen.length < shapeStore.capacity) {
      const n = Math.max(this.shapeRowVersionSeen.length << 1 || 1, shapeStore.capacity);
      const tmp = new Uint32Array(n); tmp.set(this.shapeRowVersionSeen);
      this.shapeRowVersionSeen = tmp;
    }
    if (this.opRowVersionSeen.length < opStore.capacity) {
      const n = Math.max(this.opRowVersionSeen.length << 1 || 1, opStore.capacity);
      const tmp = new Uint32Array(n); tmp.set(this.opRowVersionSeen);
      this.opRowVersionSeen = tmp;
    }

    // Resolve columns (self-describing via meta)
    const shapeFields = shapeStore.fields() as Record<string, Float32Array | Int32Array>;
    const opFields = opStore.fields() as Record<string, Int32Array>;

    const s_shapeType = shapeFields["shapeType"] as Int32Array;
    const s_p0 = shapeFields["p0"] as Float32Array;
    const s_p1 = shapeFields["p1"] as Float32Array;
    const s_p2 = shapeFields["p2"] as Float32Array;
    const s_p3 = shapeFields["p3"] as Float32Array;
    const s_p4 = shapeFields["p4"] as Float32Array;
    const s_p5 = shapeFields["p5"] as Float32Array;
    const o_opType = opFields["opType"] as Int32Array;

    // Early out: if neither store epoch changed, nothing to do.
    if (
      this.shapeStoreEpochSeen === shapeStore.storeEpoch &&
      this.opStoreEpochSeen === opStore.storeEpoch &&
      this.lastOrderEpoch === orderEpoch
    ) {
      return false;
    }

    // Full rebuild when DFS packing order changes
    if (this.lastOrderEpoch !== orderEpoch) {
      for (let r = 0; r < rows; r++) {
        const e = order[r]!;
        const base = r * LANES_PER_ROW;

        const sRow = shapeStore.denseIndexOf(e);
        const oRow = opStore.denseIndexOf(e);

        if (sRow >= 0) {
          this.i32[base + 0] = RenderKind.Shape;
          this.i32[base + 1] = s_shapeType[sRow]! | 0;
          this.f32[base + 2] = s_p0[sRow]!;
          this.f32[base + 3] = s_p1[sRow]!;
          this.f32[base + 4] = s_p2[sRow]!;
          this.f32[base + 5] = s_p3[sRow]!;
          this.f32[base + 6] = s_p4[sRow]!;
          this.f32[base + 7] = s_p5[sRow]!;
          this.kindSeen[e] = RenderKind.Shape;
          this.subtypeSeen[e] = this.i32[base + 1]! | 0;
          this.shapeRowVersionSeen[sRow] = shapeStore.rowVersion[sRow]!;
        } else if (oRow >= 0) {
          this.i32[base + 0] = RenderKind.Op;
          this.i32[base + 1] = o_opType[oRow]! | 0;
          this.f32[base + 2] = 0; this.f32[base + 3] = 0; this.f32[base + 4] = 0;
          this.f32[base + 5] = 0; this.f32[base + 6] = 0; this.f32[base + 7] = 0;
          this.kindSeen[e] = RenderKind.Op;
          this.subtypeSeen[e] = this.i32[base + 1]! | 0;
          this.opRowVersionSeen[oRow] = opStore.rowVersion[oRow]!;
        } else {
          this.i32[base + 0] = RenderKind.None;
          this.i32[base + 1] = 0;
          this.f32[base + 2] = 0; this.f32[base + 3] = 0; this.f32[base + 4] = 0;
          this.f32[base + 5] = 0; this.f32[base + 6] = 0; this.f32[base + 7] = 0;
          this.kindSeen[e] = RenderKind.None;
          this.subtypeSeen[e] = 0;
        }
      }
      this.markAllDirty();
      this.lastOrderEpoch = orderEpoch;
      this.shapeStoreEpochSeen = shapeStore.storeEpoch;
      this.opStoreEpochSeen = opStore.storeEpoch;
      return true;
    }

    // Incremental path: walk order; detect presence/kind switches or rowVersion changes; coalesce dirty runs.
    let changed = false;
    let runStart = -1;

    for (let r = 0; r < rows; r++) {
      const e = order[r]!;
      const base = r * LANES_PER_ROW;

      const sRow = shapeStore.denseIndexOf(e);
      const oRow = opStore.denseIndexOf(e);

      let wrote = false;

      if (sRow >= 0) {
        const curVer = shapeStore.rowVersion[sRow]!;
        const curType = s_shapeType[sRow]! | 0;
        if (
          this.kindSeen[e] !== RenderKind.Shape ||
          this.subtypeSeen[e] !== curType ||
          curVer !== this.shapeRowVersionSeen[sRow]!
        ) {
          this.i32[base + 0] = RenderKind.Shape;
          this.i32[base + 1] = curType;
          this.f32[base + 2] = s_p0[sRow]!;
          this.f32[base + 3] = s_p1[sRow]!;
          this.f32[base + 4] = s_p2[sRow]!;
          this.f32[base + 5] = s_p3[sRow]!;
          this.f32[base + 6] = s_p4[sRow]!;
          this.f32[base + 7] = s_p5[sRow]!;
          this.kindSeen[e] = RenderKind.Shape;
          this.subtypeSeen[e] = curType;
          this.shapeRowVersionSeen[sRow] = curVer;
          wrote = true;
        }
      } else if (oRow >= 0) {
        const curVer = opStore.rowVersion[oRow]!;
        const curType = o_opType[oRow]! | 0;
        if (
          this.kindSeen[e] !== RenderKind.Op ||
          this.subtypeSeen[e] !== curType ||
          curVer !== this.opRowVersionSeen[oRow]!
        ) {
          this.i32[base + 0] = RenderKind.Op;
          this.i32[base + 1] = curType;
          this.f32[base + 2] = 0; this.f32[base + 3] = 0; this.f32[base + 4] = 0;
          this.f32[base + 5] = 0; this.f32[base + 6] = 0; this.f32[base + 7] = 0;
          this.kindSeen[e] = RenderKind.Op;
          this.subtypeSeen[e] = curType;
          this.opRowVersionSeen[oRow] = curVer;
          wrote = true;
        }
      } else {
        if (this.kindSeen[e] !== RenderKind.None) {
          this.i32[base + 0] = RenderKind.None;
          this.i32[base + 1] = 0;
          this.f32[base + 2] = 0; this.f32[base + 3] = 0; this.f32[base + 4] = 0;
          this.f32[base + 5] = 0; this.f32[base + 6] = 0; this.f32[base + 7] = 0;
          this.kindSeen[e] = RenderKind.None;
          this.subtypeSeen[e] = 0;
          wrote = true;
        }
      }

      if (wrote) {
        if (runStart < 0) runStart = r;
        changed = true;
      } else if (runStart >= 0) {
        this.dirtyRanges.push(runStart, r - 1);
        runStart = -1;
      }
    }
    if (runStart >= 0) this.dirtyRanges.push(runStart, rows - 1);

    this.shapeStoreEpochSeen = shapeStore.storeEpoch;
    this.opStoreEpochSeen = opStore.storeEpoch;
    return changed;
  }
}

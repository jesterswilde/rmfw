// src/ecs/gpu/transformsChannel.ts
// Packs inverse-world transforms in DFS order with incremental uploads.

import type { StoreView, World } from "../core/index.js";
import { BaseChannel, BYTES_PER_F32, type DfsOrder } from "./baseChannel.js";

/**
 * Generic sync args: any DFS order + epoch + a store view exposing fields/rowVersion/capacity/storeEpoch.
 * Works with any tree that produces a stable DFS `order`.
 */
export type TransformsSyncArgs = {
  order: DfsOrder; // DFS row order (e.g., TransformTree.order)
  orderEpoch: number; // bump when order changes
  store: StoreView<string, any>; // Transform store view (must include inv_* columns)
};

/** Canonical order of inverse rows we pack. */
const INV_KEYS = [
  "inv_r00",
  "inv_r01",
  "inv_r02",
  "inv_tx",
  "inv_r10",
  "inv_r11",
  "inv_r12",
  "inv_ty",
  "inv_r20",
  "inv_r21",
  "inv_r22",
  "inv_tz",
] as const;

const FLOATS_PER_ROW = INV_KEYS.length;
const BYTES_PER_ROW = FLOATS_PER_ROW * BYTES_PER_F32;

export class TransformsChannel extends BaseChannel {
  private storeEpochSeen = -1;
  private rowVersionSeen = new Uint32Array(0);

  override sync(_world: World, args: TransformsSyncArgs): boolean {
    const { order, orderEpoch, store } = args;

    // Ensure CPU AoS capacity
    const rows = order.length | 0;
    this.ensureCpu(rows, BYTES_PER_ROW);

    // Snapshot/extend version cache to store capacity
    if (this.rowVersionSeen.length < store.capacity) {
      const n = Math.max(this.rowVersionSeen.length << 1 || 1, store.capacity);
      const tmp = new Uint32Array(n);
      tmp.set(this.rowVersionSeen);
      this.rowVersionSeen = tmp;
    }

    // Resolve inverse columns dynamically from store fields (self-describing)
    const fields = store.fields() as Record<
      string,
      Float32Array | Int32Array | Uint32Array
    >;
    const invCols = INV_KEYS.map((k) => fields[k] as Float32Array);

    // Full rebuild if order changed
    if (this.lastOrderEpoch !== orderEpoch) {
      for (let r = 0; r < rows; r++) {
        const e = order[r]!;
        const tRow = store.denseIndexOf(e);
        if (tRow >= 0) {
          const base = r * FLOATS_PER_ROW;
          this.f32[base + 0] = invCols[0]![tRow]!;
          this.f32[base + 1] = invCols[1]![tRow]!;
          this.f32[base + 2] = invCols[2]![tRow]!;
          this.f32[base + 3] = invCols[3]![tRow]!;
          this.f32[base + 4] = invCols[4]![tRow]!;
          this.f32[base + 5] = invCols[5]![tRow]!;
          this.f32[base + 6] = invCols[6]![tRow]!;
          this.f32[base + 7] = invCols[7]![tRow]!;
          this.f32[base + 8] = invCols[8]![tRow]!;
          this.f32[base + 9] = invCols[9]![tRow]!;
          this.f32[base + 10] = invCols[10]![tRow]!;
          this.f32[base + 11] = invCols[11]![tRow]!;
          this.rowVersionSeen[tRow] = store.rowVersion[tRow]!;
        }
      }
      this.markAllDirty();
      this.lastOrderEpoch = orderEpoch;
      this.storeEpochSeen = store.storeEpoch;
      return true;
    }

    // If store epoch didn't change, nothing to do
    if (this.storeEpochSeen === store.storeEpoch) return false;

    // Incremental path: walk DFS order and emit runs where rowVersion changed
    let changed = false;
    let runStart = -1;

    for (let r = 0; r < rows; r++) {
      const e = order[r]!;
      const tRow = store.denseIndexOf(e);
      if (tRow < 0) {
        if (runStart >= 0) {
          this.dirtyRanges.push(runStart, r - 1);
          runStart = -1;
        }
        continue;
      }
      const curVer = store.rowVersion[tRow]!;
      if (curVer !== this.rowVersionSeen[tRow]!) {
        const base = r * FLOATS_PER_ROW;
        this.f32[base + 0] = invCols[0]![tRow]!;
        this.f32[base + 1] = invCols[1]![tRow]!;
        this.f32[base + 2] = invCols[2]![tRow]!;
        this.f32[base + 3] = invCols[3]![tRow]!;
        this.f32[base + 4] = invCols[4]![tRow]!;
        this.f32[base + 5] = invCols[5]![tRow]!;
        this.f32[base + 6] = invCols[6]![tRow]!;
        this.f32[base + 7] = invCols[7]![tRow]!;
        this.f32[base + 8] = invCols[8]![tRow]!;
        this.f32[base + 9] = invCols[9]![tRow]!;
        this.f32[base + 10] = invCols[10]![tRow]!;
        this.f32[base + 11] = invCols[11]![tRow]!;
        this.rowVersionSeen[tRow] = curVer;
        if (runStart < 0) runStart = r;
        changed = true;
      } else if (runStart >= 0) {
        this.dirtyRanges.push(runStart, r - 1);
        runStart = -1;
      }
    }
    if (runStart >= 0) this.dirtyRanges.push(runStart, rows - 1);

    this.storeEpochSeen = store.storeEpoch;
    return changed;
  }
}

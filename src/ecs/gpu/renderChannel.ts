// src/ecs/gpu/renderChannel.ts
// Packs Render stream (ops or shapes) in RenderTree DFS order with incremental uploads.
// Row layout (40 bytes / 10 x 32-bit lanes):
//   [i32 kind, i32 subTypeOrOp, i32 parentRow, i32 transformRow,
//    f32 p0, f32 p1, f32 p2, f32 p3, f32 p4, f32 p5]
// where kind: 0 = none, 1 = shape (ShapeLeaf), 2 = operation (Operation)
// parentRow indexes into this channel (row 0 is the implicit root MIN op).
// transformRow indexes into the TransformsChannel row order (or -1 if none).

import type { StoreView, World } from "../core.js";
import { BaseChannel, BYTES_PER_F32, type DfsOrder } from "./baseChannel.js";
import { RenderKind } from "../../interfaces.js";
import {
  ShapeLeafMeta,
  OperationMeta,
  RenderNodeMeta,
  TransformMeta,
} from "../registry.js";

type MetaName<M extends { name: string }> = M["name"];
type MetaKeys<M extends { fields: readonly { key: string }[] }> =
  M["fields"][number]["key"];

export type RenderSyncArgs = {
  order: DfsOrder;    // RenderTree.order
  orderEpoch: number; // RenderTree.epoch
  shapeStore: StoreView<MetaName<typeof ShapeLeafMeta>, MetaKeys<typeof ShapeLeafMeta>>;
  opStore: StoreView<MetaName<typeof OperationMeta>, MetaKeys<typeof OperationMeta>>;
  renderStore: StoreView<MetaName<typeof RenderNodeMeta>, MetaKeys<typeof RenderNodeMeta>>;
  transformStore: StoreView<MetaName<typeof TransformMeta>, MetaKeys<typeof TransformMeta>>;
  transformOrder: DfsOrder; // TransformTree.order (maps entity → transform row)
};

const LANES_PER_ROW = 10; // 4 int32 + 6 float32
const BYTES_PER_ROW = LANES_PER_ROW * BYTES_PER_F32;

export class RenderChannel extends BaseChannel {
  // Version tracking for incremental uploads
  private shapeStoreEpochSeen = -1;
  private opStoreEpochSeen = -1;
  private shapeRowVersionSeen = new Uint32Array(0);
  private opRowVersionSeen = new Uint32Array(0);

  private entityToRow = new Int32Array(0); // maps entity id → channel row index (RenderTree order)
  private transformRowLookup = new Int32Array(0); // entity id → transform row index

  private ensureEntityCaches(world: World) {
    const need = world.entityEpoch.length | 0;
    if (this.entityToRow.length >= need) return;
    const newSize = Math.max(this.entityToRow.length << 1 || 1, need);

    const newEntityToRow = new Int32Array(newSize);
    newEntityToRow.fill(-1);
    newEntityToRow.set(this.entityToRow);
    this.entityToRow = newEntityToRow;

    const newTransformLookup = new Int32Array(newSize);
    newTransformLookup.fill(-1);
    newTransformLookup.set(this.transformRowLookup);
    this.transformRowLookup = newTransformLookup;
  }

  override sync(world: World, args: RenderSyncArgs): boolean {
    const {
      order,
      orderEpoch,
      shapeStore,
      opStore,
      renderStore,
      transformStore,
      transformOrder,
    } = args;

    const nodeCount = order.length | 0;
    const rows = nodeCount + 1; // +1 for implicit root MIN row
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
    const shapeFields = shapeStore.fields() as {
      shapeType: Int32Array;
      p0: Float32Array;
      p1: Float32Array;
      p2: Float32Array;
      p3: Float32Array;
      p4: Float32Array;
      p5: Float32Array;
    };
    const opFields = opStore.fields() as { opType: Int32Array };
    const renderFields = renderStore.fields() as { parent: Int32Array };

    const { shapeType, p0, p1, p2, p3, p4, p5 } = shapeFields;
    const { opType } = opFields;
    const { parent } = renderFields;

    // Prepare lookup tables for this sync
    const entityCount = this.entityToRow.length;
    this.entityToRow.fill(-1);
    for (let i = 0; i < nodeCount; i++) {
      const e = order[i]!;
      if (e >= 0 && e < entityCount) this.entityToRow[e] = i;
    }

    const transformLookupCount = this.transformRowLookup.length;
    this.transformRowLookup.fill(-1);
    for (let i = 0; i < transformOrder.length; i++) {
      const e = transformOrder[i]!;
      if (e >= 0 && e < transformLookupCount) this.transformRowLookup[e] = i;
    }

    const parentForEntity = (entityId: number): number => {
      if (entityId < 0 || entityId >= entityCount) return 0;
      const row = renderStore.denseIndexOf(entityId);
      if (row < 0) return 0;
      const parentEntity = parent[row]! | 0;
      if (parentEntity < 0) return 0;
      const mapped = this.entityToRow[parentEntity]!;
      return mapped >= 0 ? mapped + 1 : 0;
    };

    const transformRowForEntity = (entityId: number): number => {
      const tRow = transformStore.denseIndexOf(entityId);
      if (tRow < 0) return -1;
      const mapped = this.transformRowLookup[entityId]!;
      return mapped >= 0 ? mapped : -1;
    };

    // Always seed implicit root row at index 0 (MIN op parented to itself)
    this.i32[0] = RenderKind.Op;
    this.i32[1] = 0;
    this.i32[2] = 0;
    this.i32[3] = -1;
    this.f32.fill(0, 4, LANES_PER_ROW);

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
      for (let i = 0; i < nodeCount; i++) {
        const e = order[i]!;
        const r = i + 1;
        const base = r * LANES_PER_ROW;

        const parentRow = parentForEntity(e);
        const transformRow = transformRowForEntity(e);

        const sRow = shapeStore.denseIndexOf(e);
        const oRow = opStore.denseIndexOf(e);

        if (sRow >= 0) {
          this.i32[base + 0] = RenderKind.Shape;
          this.i32[base + 1] = shapeType[sRow]! | 0;
          this.i32[base + 2] = parentRow;
          this.i32[base + 3] = transformRow;
          this.f32[base + 4] = p0[sRow]!;
          this.f32[base + 5] = p1[sRow]!;
          this.f32[base + 6] = p2[sRow]!;
          this.f32[base + 7] = p3[sRow]!;
          this.f32[base + 8] = p4[sRow]!;
          this.f32[base + 9] = p5[sRow]!;
          this.shapeRowVersionSeen[sRow] = shapeStore.rowVersion[sRow]!;
        } else if (oRow >= 0) {
          this.i32[base + 0] = RenderKind.Op;
          this.i32[base + 1] = opType[oRow]! | 0;
          this.i32[base + 2] = parentRow;
          this.i32[base + 3] = -1;
          this.f32[base + 4] = 0; this.f32[base + 5] = 0; this.f32[base + 6] = 0;
          this.f32[base + 7] = 0; this.f32[base + 8] = 0; this.f32[base + 9] = 0;
          this.opRowVersionSeen[oRow] = opStore.rowVersion[oRow]!;
        } else {
          this.i32[base + 0] = RenderKind.None;
          this.i32[base + 1] = 0;
          this.i32[base + 2] = parentRow;
          this.i32[base + 3] = -1;
          this.f32[base + 4] = 0; this.f32[base + 5] = 0; this.f32[base + 6] = 0;
          this.f32[base + 7] = 0; this.f32[base + 8] = 0; this.f32[base + 9] = 0;
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

    for (let i = 0; i < nodeCount; i++) {
      const e = order[i]!;
      const r = i + 1;
      const base = r * LANES_PER_ROW;

      const parentRow = parentForEntity(e);
      const transformRow = transformRowForEntity(e);

      const sRow = shapeStore.denseIndexOf(e);
      const oRow = opStore.denseIndexOf(e);

      let wrote = false;

      if (sRow >= 0) {
        const curVer = shapeStore.rowVersion[sRow]!;
        const curType = shapeType[sRow]! | 0;
        const existingKind = this.i32[base + 0]! | 0;
        const existingSubtype = this.i32[base + 1]! | 0;
        const existingParent = this.i32[base + 2]! | 0;
        const existingTransform = this.i32[base + 3]! | 0;
        if (
          existingKind !== RenderKind.Shape ||
          existingSubtype !== curType ||
          curVer !== this.shapeRowVersionSeen[sRow]! ||
          existingParent !== parentRow ||
          existingTransform !== transformRow
        ) {
          this.i32[base + 0] = RenderKind.Shape;
          this.i32[base + 1] = curType;
          this.i32[base + 2] = parentRow;
          this.i32[base + 3] = transformRow;
          this.f32[base + 4] = p0[sRow]!;
          this.f32[base + 5] = p1[sRow]!;
          this.f32[base + 6] = p2[sRow]!;
          this.f32[base + 7] = p3[sRow]!;
          this.f32[base + 8] = p4[sRow]!;
          this.f32[base + 9] = p5[sRow]!;
          this.shapeRowVersionSeen[sRow] = curVer;
          wrote = true;
        }
      } else if (oRow >= 0) {
        const curVer = opStore.rowVersion[oRow]!;
        const curType = opType[oRow]! | 0;
        const existingKind = this.i32[base + 0]! | 0;
        const existingSubtype = this.i32[base + 1]! | 0;
        const existingParent = this.i32[base + 2]! | 0;
        const existingTransform = this.i32[base + 3]! | 0;
        if (
          existingKind !== RenderKind.Op ||
          existingSubtype !== curType ||
          curVer !== this.opRowVersionSeen[oRow]! ||
          existingParent !== parentRow ||
          existingTransform !== -1
        ) {
          this.i32[base + 0] = RenderKind.Op;
          this.i32[base + 1] = curType;
          this.i32[base + 2] = parentRow;
          this.i32[base + 3] = -1;
          this.f32[base + 4] = 0; this.f32[base + 5] = 0; this.f32[base + 6] = 0;
          this.f32[base + 7] = 0; this.f32[base + 8] = 0; this.f32[base + 9] = 0;
          this.opRowVersionSeen[oRow] = curVer;
          wrote = true;
        }
      } else {
        const existingKind = this.i32[base + 0]! | 0;
        const existingParent = this.i32[base + 2]! | 0;
        const existingTransform = this.i32[base + 3]! | 0;
        if (
          existingKind !== RenderKind.None ||
          existingParent !== parentRow ||
          existingTransform !== -1
        ) {
          this.i32[base + 0] = RenderKind.None;
          this.i32[base + 1] = 0;
          this.i32[base + 2] = parentRow;
          this.i32[base + 3] = -1;
          this.f32[base + 4] = 0; this.f32[base + 5] = 0; this.f32[base + 6] = 0;
          this.f32[base + 7] = 0; this.f32[base + 8] = 0; this.f32[base + 9] = 0;
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

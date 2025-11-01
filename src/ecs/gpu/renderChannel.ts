// src/ecs/gpu/renderChannel.ts
// RenderChannel — row padded to 12 lanes (48B) and stricter parent mapping for rootless/self-parented nodes

import { BaseChannel, BYTES_PER_F32, type DfsOrder } from "./baseChannel.js";
import { RenderKind } from "../../interfaces.js";
import {
  ShapeLeafMeta,
  OperationMeta,
  RenderNodeMeta,
  TransformMeta,
} from "../registry.js";
import type { StoreView } from "../interfaces.js";
import type { World } from "../core/world.js";

type MetaName<M extends { name: string }> = M["name"];
type MetaKeys<M extends { fields: readonly { key: string }[] }> =
  M["fields"][number]["key"];

export type RenderSyncArgs = {
  order: DfsOrder;            // RenderTree.order
  orderEpoch: number;         // RenderTree.epoch
  shapeStore: StoreView<MetaName<typeof ShapeLeafMeta>, MetaKeys<typeof ShapeLeafMeta>>;
  opStore: StoreView<MetaName<typeof OperationMeta>, MetaKeys<typeof OperationMeta>>;
  renderStore: StoreView<MetaName<typeof RenderNodeMeta>, MetaKeys<typeof RenderNodeMeta>>;
  transformStore: StoreView<MetaName<typeof TransformMeta>, MetaKeys<typeof TransformMeta>>;
  transformOrder: DfsOrder;    // TransformTree.order (maps entity → transform row)
  transformOrderEpoch: number; // TransformTree.epoch
};
/*
WGSL Packed Shape
Each Node gets 12 32 values to play with.
The first 4 are ints, the second 8 are floats. 
Shapes Header: type | flags | material | xformID | the other 8 free
Ops Header: type | flags | firstChild | nextSibling | the other 8 are free

We will use bitcast to reinterpet based on what the shape needs. 

PackeShaped Flag 1 << 0 - IsShape
*/


// ---- Row layout -----------------------------
// 4 x i32 lanes: kind, subtype, parentRow, transformRow
// 8 x f32 lanes: params[0..7]  (p6,p7 are padding-friendly optionals)
// Total lanes = 12 → 48 bytes per row (multiple of 16).
export const LANES_PER_RENDER_ROW = 12;
export const BYTES_PER_RENDER_ROW = LANES_PER_RENDER_ROW * BYTES_PER_F32;

export class RenderChannel extends BaseChannel {
  // Version tracking for incremental uploads
  private shapeStoreEpochSeen = -1;
  private opStoreEpochSeen = -1;
  private shapeRowVersionSeen = new Uint32Array(0);
  private opRowVersionSeen = new Uint32Array(0);

  private entityToRow = new Int32Array(0);        // entity id → channel row index (RenderTree order)
  private transformRowLookup = new Int32Array(0); // entity id → transform row index (TransformTree order)

  // Track transform order epoch to ensure transformRow changes propagate
  private lastTransformOrderEpoch = -1;

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
      transformOrderEpoch,
    } = args;

    const nodeCount = order.length | 0;
    const rows = nodeCount + 1; // +1 for implicit root MIN row
    this.ensureCpu(rows, BYTES_PER_RENDER_ROW);
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
    const shapeFields = shapeStore.fields();
    const opFields = opStore.fields();
    const renderFields = renderStore.fields();

    const { shapeType, p0, p1, p2, p3, p4, p5 } = shapeFields as any;
    // Optional padding-friendly params (exist if registry added them)
    const p6: Float32Array | undefined = (shapeFields as any).p6;
    const p7: Float32Array | undefined = (shapeFields as any).p7;

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

    // Map an entity's parent to its row (row 0 = implicit root):
    const parentForEntity = (entityId: number): number => {
      if (entityId < 0 || entityId >= entityCount) return 0;
      const row = renderStore.denseIndexOf(entityId);
      if (row < 0) return 0;
      const parentEntity = parent[row]! | 0;
      // Rootless or defensively avoid self-parent: bind to implicit root
      if (parentEntity < 0 || parentEntity === entityId) return 0;
      const mapped = this.entityToRow[parentEntity]!;
      return mapped >= 0 ? mapped + 1 : 0;
    };

    const transformRowForEntity = (entityId: number): number => {
      const mapped = this.transformRowLookup[entityId]!;
      return mapped >= 0 ? mapped : -1;
    };

    // Seed implicit root row at index 0
    this.i32[0] = RenderKind.Op;
    this.i32[1] = 0;
    this.i32[2] = 0;
    this.i32[3] = -1;
    // zero the 8 f32 param lanes
    this.f32.fill(0, 4, 4 + 8);

    // Early-out: only if nothing could change
    if (
      this.shapeStoreEpochSeen === shapeStore.storeEpoch &&
      this.opStoreEpochSeen === opStore.storeEpoch &&
      this.lastOrderEpoch === orderEpoch &&
      this.lastTransformOrderEpoch === transformOrderEpoch
    ) {
      return false;
    }

    // Full rebuild when render DFS packing order changes
    if (this.lastOrderEpoch !== orderEpoch) {
      for (let i = 0; i < nodeCount; i++) {
        const e = order[i]!;
        const r = i + 1;
        const base = r * LANES_PER_RENDER_ROW;

        const parentRow = parentForEntity(e);
        const transformRow = transformRowForEntity(e);

        const sRow = shapeStore.denseIndexOf(e);
        const oRow = opStore.denseIndexOf(e);

        if (sRow >= 0) {
          this.i32[base + 0] = RenderKind.Shape;
          this.i32[base + 1] = shapeType[sRow]! | 0;
          this.i32[base + 2] = parentRow;
          this.i32[base + 3] = transformRow;

          this.f32[base + 4]  = p0[sRow]!;
          this.f32[base + 5]  = p1[sRow]!;
          this.f32[base + 6]  = p2[sRow]!;
          this.f32[base + 7]  = p3[sRow]!;
          this.f32[base + 8]  = p4[sRow]!;
          this.f32[base + 9]  = p5[sRow]!;
          this.f32[base + 10] = p6 ? p6[sRow]! : 0;
          this.f32[base + 11] = p7 ? p7[sRow]! : 0;

          this.shapeRowVersionSeen[sRow] = shapeStore.rowVersion[sRow]!;
        } else if (oRow >= 0) {
          this.i32[base + 0] = RenderKind.Op;
          this.i32[base + 1] = opType[oRow]! | 0;
          this.i32[base + 2] = parentRow;
          this.i32[base + 3] = -1;
          this.f32.fill(0, base + 4, base + 12);
          this.opRowVersionSeen[oRow] = opStore.rowVersion[oRow]!;
        } else {
          this.i32[base + 0] = RenderKind.None;
          this.i32[base + 1] = 0;
          this.i32[base + 2] = parentRow;
          this.i32[base + 3] = -1;
          this.f32.fill(0, base + 4, base + 12);
        }
      }
      this.markAllDirty();
      this.lastOrderEpoch = orderEpoch;
      this.lastTransformOrderEpoch = transformOrderEpoch;
      this.shapeStoreEpochSeen = shapeStore.storeEpoch;
      this.opStoreEpochSeen = opStore.storeEpoch;
      return true;
    }

    // Incremental path
    let changed = false;
    let runStart = -1;

    for (let i = 0; i < nodeCount; i++) {
      const e = order[i]!;
      const r = i + 1;
      const base = r * LANES_PER_RENDER_ROW;

      const parentRow = parentForEntity(e);
      const transformRow = transformRowForEntity(e);

      const sRow = shapeStore.denseIndexOf(e);
      const oRow = opStore.denseIndexOf(e);

      let wrote = false;

      if (sRow >= 0) {
        const curVer = shapeStore.rowVersion[sRow]!;
        const curType = (shapeFields as any).shapeType[sRow]! | 0;
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

          this.f32[base + 4]  = p0[sRow]!;
          this.f32[base + 5]  = p1[sRow]!;
          this.f32[base + 6]  = p2[sRow]!;
          this.f32[base + 7]  = p3[sRow]!;
          this.f32[base + 8]  = p4[sRow]!;
          this.f32[base + 9]  = p5[sRow]!;
          this.f32[base + 10] = p6 ? p6[sRow]! : 0;
          this.f32[base + 11] = p7 ? p7[sRow]! : 0;

          this.shapeRowVersionSeen[sRow] = curVer;
          wrote = true;
        }
      } else if (oRow >= 0) {
        const curVer = opStore.rowVersion[oRow]!;
        const curType = (opFields as any).opType[oRow]! | 0;
        const existingKind = this.i32[base + 0]! | 0;
        const existingSubtype = this.i32[base + 1]! | 0;
        const existingParent = this.i32[base + 2]! | 0;

        if (
          existingKind !== RenderKind.Op ||
          existingSubtype !== curType ||
          curVer !== this.opRowVersionSeen[oRow]! ||
          existingParent !== parentRow ||
          this.i32[base + 3]! !== -1
        ) {
          this.i32[base + 0] = RenderKind.Op;
          this.i32[base + 1] = curType;
          this.i32[base + 2] = parentRow;
          this.i32[base + 3] = -1;
          this.f32.fill(0, base + 4, base + 12);
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
          this.f32.fill(0, base + 4, base + 12);
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
    this.lastTransformOrderEpoch = transformOrderEpoch;
    // lastOrderEpoch unchanged on incremental
    return changed;
  }
}

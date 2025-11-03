// src/ecs/gpu/renderChannel.ts
import type { StoreView, World } from "../core/index.js";
import { BaseChannel, BYTES_PER_F32, type DfsOrder } from "./baseChannel.js";
import {
  ShapeMeta,
  OperationMeta,
  RenderNodeMeta,
  TransformMeta,
} from "../registry.js";

type MetaName<M extends { name: string }> = M["name"];
type MetaKeys<M extends { fields: readonly { key: string }[] }> =
  M["fields"][number]["key"];

export type RenderSyncArgs = {
  order: DfsOrder;            // RenderTree.order
  orderEpoch: number;         // RenderTree.epoch
  shapeStore: StoreView<MetaName<typeof ShapeMeta>, MetaKeys<typeof ShapeMeta>>;
  opStore: StoreView<MetaName<typeof OperationMeta>, MetaKeys<typeof OperationMeta>>;
  renderStore: StoreView<MetaName<typeof RenderNodeMeta>, MetaKeys<typeof RenderNodeMeta>>;
  transformStore: StoreView<MetaName<typeof TransformMeta>, MetaKeys<typeof TransformMeta>>;
  transformOrder: DfsOrder;   // TransformTree.order (maps entity → transform row)
  transformOrderEpoch: number; // TransformTree.epoch
};

// WGSL PackedNode: 4×i32 + 12×f32
const I32_PER_ROW = 4;
const F32_PER_ROW = 12;
const LANES_PER_ROW = I32_PER_ROW + F32_PER_ROW; // 16 lanes
const BYTES_PER_ROW = LANES_PER_ROW * BYTES_PER_F32;

// i32 header lane indices
const I_KIND = 0;
const I_FIRST_CHILD = 1;
const I_NEXT_SIBLING = 2;
const I_FLAGS = 3;

// If an entity lacks a transform, use 0 (expected identity in transforms[0])
const FALLBACK_TRANSFORM_INDEX = 0;

export class RenderChannel extends BaseChannel {
  private shapeStoreEpochSeen = -1;
  private opStoreEpochSeen = -1;
  private renderStoreEpochSeen = -1;

  private shapeRowVersionSeen = new Uint32Array(0);
  private opRowVersionSeen = new Uint32Array(0);

  private entityToRow = new Int32Array(0);        // entity id → render row (0..N-1)
  private transformRowLookup = new Int32Array(0); // entity id → transform row

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

  // --- Small class helpers (no per-sync allocations) ------------------------

  /** Write the i32 header lanes of a row. */
  private packHeader(base: number, kind: number, firstChild: number, nextSibling: number, flags: number): void {
    this.i32[base + I_KIND] = kind | 0;
    this.i32[base + I_FIRST_CHILD] = firstChild | 0;
    this.i32[base + I_NEXT_SIBLING] = nextSibling | 0;
    this.i32[base + I_FLAGS] = flags | 0;
  }

  /** Zero the 12 f32 payload lanes v0..v11 of a row. */
  private zeroPayload(base: number): void {
    this.f32.fill(0, base + I32_PER_ROW, base + LANES_PER_ROW);
  }

  // --------------------------------------------------------------------------

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
    const rows = nodeCount;
    this.ensureCpu(rows, BYTES_PER_ROW);
    this.ensureEntityCaches(world);

    // Ensure version arrays sized
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

    const shapeFields = shapeStore.fields();
    const opFields = opStore.fields();
    const renderFields = renderStore.fields();

    const { shapeType, p0, p1, p2, p3, p4, p5 } = shapeFields;
    const { opType } = opFields;
    const { parent } = renderFields;

    // entity → render row (0..nodeCount-1)
    const entityCount = this.entityToRow.length;
    this.entityToRow.fill(-1);
    for (let i = 0; i < nodeCount; i++) {
      const e = order[i]!;
      if (e >= 0 && e < entityCount) this.entityToRow[e] = i;
    }

    // entity → transform row
    const transformLookupCount = this.transformRowLookup.length;
    this.transformRowLookup.fill(-1);
    for (let i = 0; i < transformOrder.length; i++) {
      const e = transformOrder[i]!;
      if (e >= 0 && e < transformLookupCount) this.transformRowLookup[e] = i;
    }

    const parentRowForEntity = (entityId: number): number => {
      if (entityId < 0 || entityId >= entityCount) return -1;
      const rdi = renderStore.denseIndexOf(entityId);
      if (rdi < 0) return -1;
      const parentEntity = parent[rdi]! | 0;
      if (parentEntity < 0) return -1;
      const mapped = this.entityToRow[parentEntity]!;
      return mapped >= 0 ? mapped : -1;
    };

    const transformRowForEntity = (entityId: number): number => {
      const mapped = this.transformRowLookup[entityId]!;
      return mapped >= 0 ? mapped : FALLBACK_TRANSFORM_INDEX;
    };

    // Compute tree wiring (rows 0..nodeCount-1)
    const firstChild = new Int32Array(rows); firstChild.fill(-1);
    const nextSibling = new Int32Array(rows); nextSibling.fill(-1);
    const lastChild = new Int32Array(rows); lastChild.fill(-1);
    const childCount = new Int32Array(rows);

    for (let i = 0; i < nodeCount; i++) {
      const e = order[i]!;
      const r = i;
      const pr = parentRowForEntity(e);
      if (pr >= 0) {
        if (firstChild[pr] === -1) firstChild[pr] = r;
        else nextSibling[lastChild[pr]!] = r;
        lastChild[pr] = r;
        childCount[pr]! += 1;
      }
    }

    // Full rebuild if order changed
    if (this.lastOrderEpoch !== orderEpoch) {
      for (let i = 0; i < nodeCount; i++) {
        const e = order[i]!;
        const r = i;
        const base = r * LANES_PER_ROW;

        const sRow = shapeStore.denseIndexOf(e);
        const oRow = opStore.denseIndexOf(e);

        if (sRow >= 0) {
          // Shape (leaf)
          const kind = shapeType[sRow]! | 0;
          const tr = transformRowForEntity(e);

          this.packHeader(base, kind, -1, nextSibling[r]! | 0, 0);
          this.zeroPayload(base);

          // v0: transform id (bits), v1: material id (-1)
          this.i32[base + I32_PER_ROW + 0] = tr | 0;
          this.i32[base + I32_PER_ROW + 1] = -1;

          // v2.. params
          this.f32[base + I32_PER_ROW + 2] = p0[sRow]!;
          this.f32[base + I32_PER_ROW + 3] = p1[sRow]!;
          this.f32[base + I32_PER_ROW + 4] = p2[sRow]!;
          this.f32[base + I32_PER_ROW + 5] = p3[sRow]!;
          this.f32[base + I32_PER_ROW + 6] = p4[sRow]!;
          this.f32[base + I32_PER_ROW + 7] = p5[sRow]!;

          this.shapeRowVersionSeen[sRow] = shapeStore.rowVersion[sRow]!;
        } else if (oRow >= 0) {
          // Op (internal)
          const kind = opType[oRow]! | 0;

          this.packHeader(base, kind, firstChild[r]! | 0, nextSibling[r]! | 0, 0);
          this.zeroPayload(base);

          // v0: child count (bits)
          this.i32[base + I32_PER_ROW + 0] = childCount[r]! | 0;

          this.opRowVersionSeen[oRow] = opStore.rowVersion[oRow]!;
        } else {
          // Inert row
          this.packHeader(base, 0, -1, nextSibling[r]! | 0, 0);
          this.zeroPayload(base);
        }
      }

      this.markAllDirty();
      this.lastOrderEpoch = orderEpoch;
      this.lastTransformOrderEpoch = transformOrderEpoch;
      this.shapeStoreEpochSeen = shapeStore.storeEpoch;
      this.opStoreEpochSeen = opStore.storeEpoch;
      this.renderStoreEpochSeen = renderStore.storeEpoch;
      return true;
    }

    // Incremental path --------------------------------------------------------
    let changed = false;
    let runStart = -1;

    for (let i = 0; i < nodeCount; i++) {
      const e = order[i]!;
      const r = i;
      const base = r * LANES_PER_ROW;

      const sRow = shapeStore.denseIndexOf(e);
      const oRow = opStore.denseIndexOf(e);

      let wrote = false;

      if (sRow >= 0) {
        // Shape
        const curVer = shapeStore.rowVersion[sRow]!;
        const curKind = shapeType[sRow]! | 0;
        const tr = transformRowForEntity(e);
        const ns = nextSibling[r]! | 0;

        const need =
          this.i32[base + I_KIND] !== curKind ||
          this.i32[base + I_FIRST_CHILD] !== -1 ||
          this.i32[base + I_NEXT_SIBLING] !== ns ||
          this.i32[base + I_FLAGS] !== 0 ||
          this.shapeRowVersionSeen[sRow] !== curVer ||
          this.i32[base + I32_PER_ROW + 0] !== tr;

        if (need) {
          this.packHeader(base, curKind, -1, ns, 0);
          this.zeroPayload(base);

          // v0: transform bits, v1: material -1
          this.i32[base + I32_PER_ROW + 0] = tr | 0;
          this.i32[base + I32_PER_ROW + 1] = -1;

          // params
          this.f32[base + I32_PER_ROW + 2] = p0[sRow]!;
          this.f32[base + I32_PER_ROW + 3] = p1[sRow]!;
          this.f32[base + I32_PER_ROW + 4] = p2[sRow]!;
          this.f32[base + I32_PER_ROW + 5] = p3[sRow]!;
          this.f32[base + I32_PER_ROW + 6] = p4[sRow]!;
          this.f32[base + I32_PER_ROW + 7] = p5[sRow]!;

          this.shapeRowVersionSeen[sRow] = curVer;
          wrote = true;
        }
      } else if (oRow >= 0) {
        // Op
        const curVer = opStore.rowVersion[oRow]!;
        const curKind = opType[oRow]! | 0;
        const fc = firstChild[r]! | 0;
        const ns = nextSibling[r]! | 0;
        const cnt = childCount[r]! | 0;

        const need =
          this.i32[base + I_KIND] !== curKind ||
          this.i32[base + I_FIRST_CHILD] !== fc ||
          this.i32[base + I_NEXT_SIBLING] !== ns ||
          this.i32[base + I_FLAGS] !== 0 ||
          this.opRowVersionSeen[oRow] !== curVer ||
          this.i32[base + I32_PER_ROW + 0] !== cnt;

        if (need) {
          this.packHeader(base, curKind, fc, ns, 0);
          this.zeroPayload(base);

          // v0: child count bits
          this.i32[base + I32_PER_ROW + 0] = cnt | 0;

          this.opRowVersionSeen[oRow] = curVer;
          wrote = true;
        }
      } else {
        // Inert
        const ns = nextSibling[r]! | 0;
        const need =
          this.i32[base + I_KIND] !== 0 ||
          this.i32[base + I_FIRST_CHILD] !== -1 ||
          this.i32[base + I_NEXT_SIBLING] !== ns ||
          this.i32[base + I_FLAGS] !== 0;

        if (need) {
          this.packHeader(base, 0, -1, ns, 0);
          this.zeroPayload(base);
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

    // Transform order change can reindex v0 for shapes; refresh if nothing else flagged
    const transformOrderChanged = this.lastTransformOrderEpoch !== transformOrderEpoch;
    if (!changed && transformOrderChanged) {
      this.markAllDirty();
      changed = true;
    }

    this.shapeStoreEpochSeen = shapeStore.storeEpoch;
    this.opStoreEpochSeen = opStore.storeEpoch;
    this.renderStoreEpochSeen = renderStore.storeEpoch;
    this.lastTransformOrderEpoch = transformOrderEpoch;
    return changed;
  }
}

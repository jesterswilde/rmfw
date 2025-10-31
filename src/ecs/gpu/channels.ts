// src/ecs/gpu/channels.ts

import type { World, StoreView } from "../core.js";

const BYTES_F32 = 4;

export type DfsOrder = Int32Array;
export type BindLayoutSpec = GPUBindGroupLayoutEntry & { binding: number };

// ------------------------------------------------------------
// BaseChannel
// ------------------------------------------------------------
export abstract class BaseChannel {
  protected cpu: ArrayBuffer = new ArrayBuffer(0);
  protected f32 = new Float32Array(0);
  protected i32 = new Int32Array(0); // available for integer payloads

  protected rowSizeBytes = 0;
  protected count = 0;

  protected gpuBuffer: GPUBuffer | null = null;

  // dirty ranges tracked in AoS row index space: [start0,end0,start1,end1,...]
  protected dirtyRanges: number[] = [];

  // epoch for the ORDER (not the store) to decide full repack vs incremental
  protected lastOrderEpoch = -1;

  get sizeBytes(): number {
    return this.count * this.rowSizeBytes;
  }
  get buffer(): GPUBuffer | null {
    return this.gpuBuffer;
  }

  /** Default: read-only storage buffer, compute visibility. Channels can override if needed. */
  layoutEntry(
    binding: number,
    visibility: GPUShaderStageFlags = GPUShaderStage.COMPUTE
  ): BindLayoutSpec {
    return { binding, visibility, buffer: { type: "read-only-storage" } };
  }

  /** Ensure CPU AoS has space for `rows` with a given row size. */
  protected ensureCpu(rows: number, rowSizeBytes: number) {
    const needed = rows * rowSizeBytes;
    if (this.cpu.byteLength >= needed && this.rowSizeBytes === rowSizeBytes) {
      this.count = rows;
      return;
    }
    this.rowSizeBytes = rowSizeBytes | 0;
    const cap = Math.max(needed, 256);
    this.cpu = new ArrayBuffer(cap);
    this.f32 = new Float32Array(this.cpu);
    this.i32 = new Int32Array(this.cpu);
    this.count = rows;
  }

  /** Ensure GPU buffer exists and matches size. */
  createOrResize(device: GPUDevice) {
    const needed = Math.max(this.sizeBytes, 4); // WebGPU dislikes 0-sized buffers
    if (this.gpuBuffer && this.gpuBuffer.size === needed) return false;
    if (this.gpuBuffer) this.gpuBuffer.destroy();
    this.gpuBuffer = device.createBuffer({
      size: needed,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
    this.markAllDirty();
    return true;
  }

  /** Mark a single row dirty (coalesces with tail if adjacent). */
  protected markRowDirty(rowIndex: number) {
    if (rowIndex < 0) return;
    if (this.dirtyRanges.length === 0) {
      this.dirtyRanges.push(rowIndex, rowIndex);
      return;
    }
    const lastEndI = this.dirtyRanges.length - 1;
    const lastEnd = this.dirtyRanges[lastEndI]!;
    if (rowIndex === lastEnd + 1) {
      this.dirtyRanges[lastEndI] = rowIndex; // extend tail
    } else {
      this.dirtyRanges.push(rowIndex, rowIndex);
    }
  }

  /** Mark entire buffer dirty. */
  protected markAllDirty() {
    if (this.count > 0) {
      this.dirtyRanges.length = 0;
      this.dirtyRanges.push(0, this.count - 1);
    }
  }

  /** Merge and upload all queued ranges; clears the queue. */
  flush(queue: GPUQueue) {
    if (!this.gpuBuffer || this.dirtyRanges.length === 0) return;

    // merge adjacent/overlapping (we append in sorted order, so linear pass is fine)
    const merged: [number, number][] = [];
    for (let i = 0; i < this.dirtyRanges.length; i += 2) {
      const a = this.dirtyRanges[i]!,
        b = this.dirtyRanges[i + 1]!;
      if (merged.length === 0) {
        merged.push([a, b]);
        continue;
      }
      const last = merged[merged.length - 1]!;
      if (a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }

    // Fast-path: if merged coverage spans entire buffer, emit one full write
    if (
      merged.length === 1 &&
      merged[0]![0] === 0 &&
      merged[0]![1] === this.count - 1
    ) {
      queue.writeBuffer(this.gpuBuffer!, 0, this.cpu, 0, this.sizeBytes);
      this.dirtyRanges.length = 0;
      return;
    }

    for (const [start, end] of merged) {
      const offset = start * this.rowSizeBytes;
      const size = (end - start + 1) * this.rowSizeBytes;
      queue.writeBuffer(this.gpuBuffer!, offset, this.cpu, offset, size);
    }

    this.dirtyRanges.length = 0;
  }

  /** Channel-specific work: returns true if CPU AoS changed (needs flush). */
  abstract sync(world: World, args: any): boolean;
}

// ------------------------------------------------------------
// TransformsChannel — packs INVERSE WORLD (3x4) only
// ------------------------------------------------------------

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
const BYTES_PER_ROW = FLOATS_PER_ROW * BYTES_F32;

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

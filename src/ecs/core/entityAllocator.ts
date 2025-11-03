// src/ecs/core/entityAllocator.ts
import type { Entity } from "../interfaces.js";

const GROW = (n: number) => Math.max(2, n << 1);
export class EntityAllocator {
  private _dense: number[] = [];
  private _sparse: Int32Array;
  private _free: number[] = [];
  private _next = 0;

  // per-entity epoch; bump on any component add/remove/write or allocator structural change
  readonly entityEpoch: Uint32Array;

  constructor(initialCapacity: number) {
    const cap = Math.max(1, initialCapacity | 0);
    this._sparse = new Int32Array(cap).fill(-1);
    this.entityEpoch = new Uint32Array(cap);
  }

  get capacity() {
    return this._sparse.length | 0;
  }
  get size() {
    return this._dense.length | 0;
  }
  get dense() {
    return this._dense;
  }

  private growToFit(id: number) {
    if (id < this._sparse.length) return;
    let newCap = this._sparse.length;
    while (newCap <= id) newCap = GROW(newCap);
    const newSparse = new Int32Array(newCap).fill(-1);
    newSparse.set(this._sparse);
    const newEntityEpoch = new Uint32Array(newCap);
    newEntityEpoch.set(this.entityEpoch);
    this._sparse = newSparse;
    (this as any).entityEpoch = newEntityEpoch as Uint32Array;
  }

  create(): number {
    let id: number;
    if (this._free.length) {
      id = this._free.pop()!;
    } else {
      id = this._next++;
      this.growToFit(id);
    }
    const denseIndex = this._dense.length;
    this._dense.push(id);
    this._sparse[id] = denseIndex;
    return id;
  }

  destroy(id: Entity) {
    const denseI = this._sparse[id] ?? -1;
    if (denseI < 0) return;

    const last = this._dense.pop()!;
    if (last !== id) {
      this._dense[denseI] = last;
      this._sparse[last] = denseI;
    }
    this._sparse[id] = -1;
    this._free.push(id);

    this.entityEpoch[id] = (this.entityEpoch[id]! + 1) >>> 0;
  }

  isAlive(id: number) {
    return id >= 0 && id < this._sparse.length && this._sparse[id]! >= 0;
  }

  denseIndexOf(id: number) {
    return this._sparse[id] ?? -1;
  }

  /** Build a mapping from current live ids (old) to new contiguous ids in **ascending old-id order**. */
  computeDenseRemap(): { remap: Int32Array; inverse: Int32Array } {
    const maxId = Math.max(this._next - 1, this._sparse.length - 1, 0);
    const remap = new Int32Array(maxId + 1).fill(-1);

    // Collect live ids and sort ascending
    const live: number[] = [];
    for (let i = 0; i < this._dense.length; i++) {
      live.push(this._dense[i]!);
    }
    live.sort((a, b) => a - b);

    const inverse = new Int32Array(live.length);
    for (let i = 0; i < live.length; i++) {
      const oldId = live[i]!;
      remap[oldId] = i;   // old -> new contiguous ascending order
      inverse[i] = oldId; // new -> old
    }
    return { remap, inverse };
  }

  /**
   * Apply a mapping produced by computeDenseRemap(). After this call:
   * - Live ids are exactly 0..size-1 (ascending old-id order).
   * - Free list is cleared and next == size.
   * - Per-entity epochs for live ids are bumped by +1 (structural change).
   */
  applyRemap(remap: Int32Array): void {
    // Build inverse and compute new size
    const newSize = this._dense.length;
    const inverse: number[] = new Array(newSize);
    for (let old = 0; old < remap.length; old++) {
      const n = remap[old] ?? -1;
      if (n >= 0) inverse[n] = old;
    }

    // New dense is [0..newSize-1]
    this._dense = new Array(newSize);
    for (let i = 0; i < newSize; i++) this._dense[i] = i;

    // Rebuild sparse to map new ids to their dense index
    const newCap = Math.max(this._sparse.length, newSize);
    const newSparse = new Int32Array(newCap).fill(-1);
    for (let i = 0; i < newSize; i++) {
      newSparse[i] = i;
    }
    this._sparse = newSparse;

    // Rebuild epochs: carry from old id and bump +1
    const newEpoch = new Uint32Array(Math.max(this.entityEpoch.length, newCap));
    for (let i = 0; i < newSize; i++) {
      const oldId = inverse[i]!;
      const prev = this.entityEpoch[oldId] ?? 0;
      newEpoch[i] = (prev + 1) >>> 0;
    }
    (this as any).entityEpoch = newEpoch as Uint32Array;

    // Reset allocation cursors
    this._free = [];
    this._next = newSize;
  }

  export(): {
    _dense: number[];
    _sparse: number[];
    _free: number[];
    _next: number;
    entityEpoch: number[];
  } {
    return {
      _dense: Array.from(this._dense),
      _sparse: Array.from(this._sparse),
      _free: Array.from(this._free),
      _next: this._next,
      entityEpoch: Array.from(this.entityEpoch),
    };
  }

  import(data: {
    _dense: number[];
    _sparse: number[];
    _free: number[];
    _next: number;
    entityEpoch: number[];
  }): void {
    this._dense = Array.from(data._dense);
    this._sparse = Int32Array.from(data._sparse);
    this._free = Array.from(data._free);
    this._next = data._next | 0;

    const cap = Math.max(1, data.entityEpoch.length, this._sparse.length);
    const epochs = new Uint32Array(cap);
    epochs.set(Uint32Array.from(data.entityEpoch));
    (this as any).entityEpoch = epochs as Uint32Array;
  }
}

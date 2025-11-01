import type { Entity } from "../interfaces";

const GROW = (n: number) => Math.max(2, n << 1);

export class EntityAllocator {
  private _dense: number[] = [];
  private _sparse: Int32Array;
  private _free: number[] = [];
  private _next = 0;

  // per-entity epoch; bump on any component add/remove/write
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
}
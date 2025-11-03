// /src/ecs/core/componentStore.ts
import type { ComponentMeta, FieldMeta, MutableColumnsOf, ColumnsOf, KeysOf } from "../interfaces.js";

const GROW = (n: number) => Math.max(2, n << 1);

type TypedArrayLike = Float32Array | Int32Array | Uint32Array;

/** A typed store handle for a given meta. */
export type StoreOf<M extends ComponentMeta = ComponentMeta> =
  ComponentStore<M>;

/** Slimmer store surface for hovers (keeps name & key union prominent). */
export type StoreView<N extends string, K extends string> = {
  readonly name: N;
  readonly meta: Readonly<{ name: N; fields: ReadonlyArray<FieldMeta<K>> }>;
  readonly size: number;
  readonly capacity: number;
  readonly entityToDense: Int32Array;
  readonly denseToEntity: Int32Array;
  readonly rowVersion: Uint32Array;
  readonly storeEpoch: number;
  fields(): Readonly<Record<K, Float32Array | Int32Array | Uint32Array>>;
  has(entity: number): boolean;
  denseIndexOf(entity: number): number;
  add(entity: number, initialValues?: Partial<Record<K, number>>): number;
  update(entity: number, patch: Partial<Record<K, number>>): boolean;
  remove(entity: number): boolean;
};

export type ComponentStoreExport = {
  name: string;
  size: number;
  capacity: number;
  storeEpoch: number;
  entityToDense: number[];
  denseToEntity: number[];
  rowVersion: number[];
  fields: Record<string, number[]>;
};

export class ComponentStore<M extends ComponentMeta> {
  readonly name: M["name"];
  readonly meta: M;

  private _capacity: number;
  private _size = 0;

  // entity <-> dense index maps
  private _entityToDense: Int32Array;
  private _denseToEntity: Int32Array;

  // one typed array per scalar field (keyed by meta field keys)
  private _fields: MutableColumnsOf<M>;

  // epochs
  storeEpoch = 0;
  rowVersion: Uint32Array;

  constructor(meta: M, initialCapacity = 256) {
    this.meta = meta;
    this.name = meta.name;

    const cap = Math.max(1, initialCapacity | 0);
    this._capacity = cap;

    this._entityToDense = new Int32Array(cap).fill(-1);
    this._denseToEntity = new Int32Array(cap).fill(-1);
    this.rowVersion = new Uint32Array(cap);

    // allocate one scalar column per field
    this._fields = Object.create(null);
    for (const f of meta.fields) {
      (this._fields as any)[f.key] = new f.ctor(cap);
    }
  }

  // ---- accessors
  get size() {
    return this._size;
  }
  get capacity() {
    return this._capacity;
  }
  get entityToDense() {
    return this._entityToDense;
  }
  get denseToEntity() {
    return this._denseToEntity;
  }

  fields(): ColumnsOf<M> {
    return this._fields as ColumnsOf<M>;
  }

  has(entity: number) {
    return (
      entity >= 0 &&
      entity < this._entityToDense.length &&
      this._entityToDense[entity]! >= 0
    );
  }

  denseIndexOf(entity: number) {
    return this._entityToDense[entity] ?? -1;
  }

  private grow() {
    const nCap = GROW(this._capacity);

    const nE2D = new Int32Array(nCap).fill(-1);
    const nD2E = new Int32Array(nCap).fill(-1);
    const nRowV = new Uint32Array(nCap);

    nE2D.set(this._entityToDense);
    nD2E.set(this._denseToEntity);
    nRowV.set(this.rowVersion);

    const nFields: any = {};
    for (const f of this.meta.fields) {
      const old = (this._fields as any)[f.key] as TypedArrayLike;
      const neu = new (f.ctor as any)(nCap);
      (neu as any).set(old);
      nFields[f.key] = neu;
    }

    this._capacity = nCap;
    this._entityToDense = nE2D;
    this._denseToEntity = nD2E;
    this.rowVersion = nRowV;
    this._fields = nFields;
  }

  /**
   * Add this component to an entity. Initializes all scalar fields to their meta default (or 0),
   * then applies any provided initial scalar values.
   */
  add(
    entity: number,
    initialValues?: Partial<Record<KeysOf<M>, number>>
  ): number {
    const existing = this._entityToDense[entity] ?? -1;
    if (existing >= 0) {
      if (initialValues) this.update(entity, initialValues);
      return existing;
    }

    if (this._size >= this._capacity) this.grow();

    const denseIndex = this._size;
    this._entityToDense[entity] = denseIndex;
    this._denseToEntity[denseIndex] = entity;

    // init all scalar fields from defaults (or 0)
    for (const f of this.meta.fields) {
      const column = (this._fields as any)[f.key] as TypedArrayLike;
      column[denseIndex] = (f.default ?? 0) as any;
    }

    // apply provided initial scalar values
    if (initialValues) {
      for (const k in initialValues) {
        const v = initialValues[k as KeysOf<M>];
        if (v == null) continue;
        const column = (this._fields as any)[k] as TypedArrayLike;
        column[denseIndex] = v as any;
      }
    }

    this._size++;
    this.rowVersion[denseIndex] = (this.rowVersion[denseIndex]! + 1) >>> 0;
    this.storeEpoch++;

    return denseIndex;
  }

  /**
   * Update scalar fields for an existing component row.
   */
  update(entity: number, patch: Partial<Record<KeysOf<M>, number>>): boolean {
    const denseIndex = this._entityToDense[entity] ?? -1;
    if (denseIndex < 0) return false;

    let updated = false;
    for (const k in patch) {
      const v = patch[k as KeysOf<M>];
      if (v == null) continue;
      const column = (this._fields as any)[k] as TypedArrayLike;
      // Only write if the value actually changes
      if (column[denseIndex] !== (v as any)) {
        column[denseIndex] = v as any;
        updated = true;
      }
    }

    if (updated) {
      this.rowVersion[denseIndex] = (this.rowVersion[denseIndex]! + 1) >>> 0;
      this.storeEpoch++;
    }
    return updated;
  }

  remove(entity: number): boolean {
    const denseI = this._entityToDense[entity] ?? -1;
    if (denseI < 0) return false;

    const last = this._size - 1;
    const lastEntity = this._denseToEntity[last];

    // swap-remove per scalar column
    for (const f of this.meta.fields) {
      const col = (this._fields as any)[f.key] as TypedArrayLike;
      col[denseI] = col[last]!;
    }

    // carry over rowVersion for the moved row (if any)
    const movedRowVersion = this.rowVersion[last]!;
    this.rowVersion[denseI] = movedRowVersion;
    this.rowVersion[last] = 0;

    // remap dense<->entity for swapped row
    this._denseToEntity[denseI] = lastEntity!;
    this._entityToDense[lastEntity!] = denseI;

    // clear last slot
    this._denseToEntity[last] = -1;
    this._size--;

    // clear removed
    this._entityToDense[entity] = -1;

    this.storeEpoch++;
    return true;
  }

  /**
   * Remap entity ids in mappings and rewrite link fields according to `remap[oldId] = newId` (>=0).
   * Dead/unmapped ids must have remap[...] < 0. NONE (-1) stays -1.
   */
  remapEntitiesAndLinks(remap: Int32Array): void {
    // 1) Rewrite denseToEntity to new ids, track max id to size entityToDense
    let maxNewId = -1;
    for (let i = 0; i < this._size; i++) {
      const oldId = this._denseToEntity[i]!;
      const mapped = oldId >= 0 && oldId < remap.length ? remap[oldId]! : -1;
      const newId = mapped >= 0 ? mapped : oldId; // if unmapped, keep old (supports non-densify remaps)
      this._denseToEntity[i] = newId;
      if (newId > maxNewId) maxNewId = newId;
    }

    // 2) Rebuild entityToDense with enough capacity for new ids
    if (maxNewId >= this._entityToDense.length) {
      const n = maxNewId + 1;
      const next = new Int32Array(n).fill(-1);
      next.set(this._entityToDense);
      this._entityToDense = next;
    }
    // Clear old indices
    this._entityToDense.fill(-1);
    for (let i = 0; i < this._size; i++) {
      const e = this._denseToEntity[i]!;
      if (e >= 0) this._entityToDense[e] = i;
    }

    // 3) Rewrite link fields
    for (const f of this.meta.fields) {
      if (!f.link) continue;
      const col = (this._fields as any)[f.key] as Int32Array;
      for (let i = 0; i < this._size; i++) {
        const old = col[i]! | 0;
        if (old < 0) continue; // NONE
        const mapped = old < remap.length ? remap[old]! : -1;
        if (mapped >= 0) col[i] = mapped;
      }
    }

    // 4) Bump all row versions once; bump store epoch
    for (let i = 0; i < this._size; i++) {
      this.rowVersion[i] = (this.rowVersion[i]! + 1) >>> 0;
    }
    this.storeEpoch++;
  }

  export(): ComponentStoreExport {
    const fields: Record<string, number[]> = Object.create(null);
    for (const f of this.meta.fields) {
      const col = (this._fields as any)[f.key] as TypedArrayLike;
      fields[f.key] = Array.from(col);
    }
    return {
      name: this.name,
      size: this._size,
      capacity: this._capacity,
      storeEpoch: this.storeEpoch,
      entityToDense: Array.from(this._entityToDense),
      denseToEntity: Array.from(this._denseToEntity),
      rowVersion: Array.from(this.rowVersion),
      fields,
    };
  }

  import(data: ComponentStoreExport): void {
    // Capacity and basic arrays
    this._capacity = Math.max(1, data.capacity | 0);
    this._size = data.size | 0;

    // Resize and load mappings/epochs
    this._entityToDense = new Int32Array(this._capacity).fill(-1);
    this._denseToEntity = new Int32Array(this._capacity).fill(-1);
    this.rowVersion = new Uint32Array(this._capacity);

    this._entityToDense.set(Int32Array.from(data.entityToDense));
    this._denseToEntity.set(Int32Array.from(data.denseToEntity));
    this.rowVersion.set(Uint32Array.from(data.rowVersion));
    this.storeEpoch = data.storeEpoch | 0;

    // Rebuild field columns with exact capacity and copy values
    const nFields: any = {};
    for (const f of this.meta.fields) {
      const ctor = f.ctor as any;
      const arr = new ctor(this._capacity);
      const src = data.fields[f.key] ?? [];
      for (let i = 0; i < Math.min(src.length, this._capacity); i++) {
        (arr as any)[i] = src[i] as number;
      }
      nFields[f.key] = arr;
    }
    this._fields = nFields;
  }
}

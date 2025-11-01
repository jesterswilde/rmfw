import type { ComponentMeta, FieldMeta, MutableColumnsOf, ColumnsOf, KeysOf } from "../interfaces";

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
      column[denseIndex] = v as any;
      updated = true;
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
}
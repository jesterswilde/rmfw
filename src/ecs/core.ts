// Phase 1 core (updated):
// - Entity allocator
// - Scalar-only SoA stores (true SoA) using self-describing component metadata
// - Query view
// - Epochs

export type Entity = number;

export interface WorldConfig {
  initialCapacity?: number; // default 1024
}

export type ScalarCtor =
  | Float32ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor;

type TypedArrayLike = Float32Array | Int32Array | Uint32Array;

export interface FieldSpec {
  /** Column key in the SoA store (stable). */
  key: string;
  /** Typed array constructor for the column. */
  ctor: ScalarCtor;
  /** Default numeric value for this column (used by loaders/savers). */
  default?: number;
  /** True if column stores entity IDs (saves/loaders remap them). */
  link?: boolean;
}

/** Component metadata: ordered list of fields defines the stable field order. */
export interface ComponentMeta {
  name: string;
  fields: FieldSpec[]; // ORDER MATTERS
}

export interface QueryView {
  driver: string;
  count: number;
  entities: Int32Array;             // [count]
  rows: Record<string, Int32Array>; // rows[name][i] = dense row index in that store
}

const GROW = (n: number) => Math.max(2, n << 1);

// -----------------------------
// Entity allocator (dense/sparse)
// -----------------------------
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

  get capacity() { return this._sparse.length | 0; }
  get size() { return this._dense.length | 0; }
  get dense() { return this._dense; }

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

  destroy(id: number) {
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

  denseIndexOf(id: number) { return this._sparse[id] ?? -1; }
}

// ---------------------------------
// SoA sparse-set store (scalar columns only) w/ metadata
// ---------------------------------
export class ComponentStore<M extends ComponentMeta = ComponentMeta> {
  readonly name: string;
  readonly meta: M;

  private _capacity: number;
  private _size = 0;

  // entity <-> dense index maps
  private _entityToDense: Int32Array;
  private _denseToEntity: Int32Array;

  // columns keyed by field.key
  private _columns: Record<string, TypedArrayLike>;

  // epochs
  storeEpoch = 0;
  rowVersion: Uint32Array;

  // stable field order (same as meta.fields.map(f => f.key))
  readonly fieldOrder: string[];

  constructor(meta: M, initialCapacity = 256) {
    this.name = meta.name;
    this.meta = meta;

    const cap = Math.max(1, initialCapacity | 0);
    this._capacity = cap;

    this._entityToDense = new Int32Array(cap).fill(-1);
    this._denseToEntity = new Int32Array(cap).fill(-1);
    this.rowVersion = new Uint32Array(cap);

    this._columns = Object.create(null);
    for (const f of meta.fields) {
      (this._columns as any)[f.key] = new (f.ctor as any)(cap);
    }
    this.fieldOrder = meta.fields.map(f => f.key);
  }

  get size() { return this._size; }
  get capacity() { return this._capacity; }
  get entityToDense() { return this._entityToDense; }
  get denseToEntity() { return this._denseToEntity; }

  fields(): Readonly<Record<string, TypedArrayLike>> { return this._columns; }

  has(entity: number) {
    return entity >= 0 && entity < this._entityToDense.length && this._entityToDense[entity]! >= 0;
  }
  denseIndexOf(entity: number) { return this._entityToDense[entity] ?? -1; }

  private grow() {
    const nCap = GROW(this._capacity);

    const nE2D = new Int32Array(nCap).fill(-1);
    const nD2E = new Int32Array(nCap).fill(-1);
    const nRowV = new Uint32Array(nCap);

    nE2D.set(this._entityToDense);
    nD2E.set(this._denseToEntity);
    nRowV.set(this.rowVersion);

    const nCols: any = {};
    for (const f of this.meta.fields) {
      const old = (this._columns as any)[f.key] as TypedArrayLike;
      const neu = new (f.ctor as any)(nCap);
      (neu as any).set(old);
      nCols[f.key] = neu;
    }

    this._capacity = nCap;
    this._entityToDense = nE2D;
    this._denseToEntity = nD2E;
    this.rowVersion = nRowV;
    this._columns = nCols;
  }

  /**
   * Add this component to an entity. Initializes all scalar fields to 0,
   * then applies any provided initial scalar values.
   */
  add(entity: number, initialValues?: Partial<Record<string, number>>): number {
    const existing = this._entityToDense[entity] ?? -1;
    if (existing >= 0) {
      if (initialValues) 
        this.update(entity, initialValues);
      return existing;
    }

    if (this._size >= this._capacity) this.grow();

    const denseIndex = this._size;
    this._entityToDense[entity] = denseIndex;
    this._denseToEntity[denseIndex] = entity;

    // zero-init all scalar fields
    for (const f of this.meta.fields) {
      const column = (this._columns as any)[f.key] as TypedArrayLike;
      column[denseIndex] = 0 as any;
    }

    // apply provided initial scalar values
    if (initialValues) {
      for (const fieldName in initialValues) {
        const value = initialValues[fieldName];
        if (value == null) 
            continue;
        const column = (this._columns as any)[fieldName] as TypedArrayLike;
        if (column)
            (column as any)[denseIndex] = value as any;
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
  update(entity: number, patch: Partial<Record<string, number>>): boolean {
    const denseIndex = this._entityToDense[entity] ?? -1;
    if (denseIndex < 0) 
        return false;

    let updated = false;
    for (const fieldName in patch) {
      const v = patch[fieldName];
      if (v == null) continue;
      const column = (this._columns as any)[fieldName] as TypedArrayLike;
      if (!column) continue;
      (column as any)[denseIndex] = v as any;
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
      const col = (this._columns as any)[f.key] as TypedArrayLike;
      col[denseI] = col[last]!;
    }

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

// -----------------------------
// World + Registry plumbing
// -----------------------------
export type StoreHandle<M extends ComponentMeta = ComponentMeta> = ComponentStore<M>;
export interface ComponentDef<M extends ComponentMeta = ComponentMeta> { meta: M; }

export class World {
  readonly entities: EntityAllocator;
  private _stores = new Map<string, ComponentStore<any>>();
  private _registry = new Map<string, ComponentDef<any>>();

  readonly entityEpoch: Uint32Array;

  constructor(cfg: WorldConfig = {}) {
    const cap = cfg.initialCapacity ?? 1024;
    this.entities = new EntityAllocator(cap);
    this.entityEpoch = this.entities.entityEpoch;
  }

  register<M extends ComponentMeta>(def: ComponentDef<M>, initialCapacity = 256): StoreHandle<M> {
    const name = def.meta.name;
    if (this._registry.has(name)) throw new Error(`Component '${name}' already registered`);
    const store = new ComponentStore(def.meta, initialCapacity);
    this._registry.set(name, def);
    this._stores.set(name, store);
    return store as StoreHandle<M>;
  }

  store<M extends ComponentMeta = ComponentMeta>(name: string): StoreHandle<M> {
    const store = this._stores.get(name);
    if (!store) throw new Error(`Unknown component store '${name}'`);
    return store as StoreHandle<M>;
  }

  createEntity(): Entity { return this.entities.create(); }

  // Full teardown: remove from all stores, then free the entity.
  destroyEntity(entity: Entity) {
    for (const store of this._stores.values()) {
      if ((store as ComponentStore<any>).has(entity)) (store as ComponentStore<any>).remove(entity);
    }
    this.entities.destroy(entity);
  }

  // Single-pass materialized query view (scalar-only stores)
  queryView(...requiredComponents: string[]): QueryView {
    if (requiredComponents.length === 0) {
      return { driver: "", count: 0, entities: new Int32Array(0), rows: {} };
    }

    // Pick smallest store as the driver
    let driverName = requiredComponents[0]!;
    let driver = this._stores.get(driverName);
    if (!driver) throw new Error(`Unknown component '${driverName}'`);
    for (let i = 1; i < requiredComponents.length; i++) {
      const compStore = this._stores.get(requiredComponents[i]!);
      if (!compStore) throw new Error(`Unknown component '${requiredComponents[i]}'`);
      if (compStore.size < driver!.size) { driver = compStore; driverName = requiredComponents[i]!; }
    }
    if (!driver || driver.size === 0) {
      return { driver: driverName, count: 0, entities: new Int32Array(0), rows: {} };
    }

    const compStores = requiredComponents.map(n => this._stores.get(n)!);

    const maxN = driver.size;
    const entities = new Int32Array(maxN);
    const rows: Record<string, Int32Array> = Object.create(null);
    for (const name of requiredComponents) 
        rows[name] = new Int32Array(maxN);

    const staged: number[] = new Array(compStores.length);
    let out = 0;

    for (let denseI = 0; denseI < maxN; denseI++) {
      const entity = driver.denseToEntity[denseI];
      let ok = true;

      for (let cI = 0; cI < compStores.length; cI++) {
        const comp = compStores[cI]!;
        const rowIndex = comp.denseIndexOf(entity!);
        if (rowIndex < 0) { ok = false; break; }
        staged[cI] = rowIndex;
      }
      if (!ok) continue;

      entities[out] = entity!;
      for (let cI = 0; cI < compStores.length; cI++) {
        const comp = compStores[cI]!;
        rows[comp.name as string]![out] = staged[cI]!;
      }
      out++;
    }

    const entitiesView = entities.subarray(0, out);
    const rowsView: Record<string, Int32Array> = Object.create(null);
    for (const name of requiredComponents) rowsView[name] = rows[name]!.subarray(0, out);

    return { driver: driverName, count: out, entities: entitiesView, rows: rowsView };
  }
}

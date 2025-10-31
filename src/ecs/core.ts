// src/ecs/core.ts
// Meta-driven ECS core: entity allocator + scalar SoA stores with typed metadata.
// - Clear, condensed type aliases
// - defineMeta() preserves literal 'name' and field keys
// - storeOf(meta) returns slim StoreView<N,K> for clean hovers & key-safe add/update
// - queryView() materializes a joined view over required components

export type Entity = number;

export interface WorldConfig {
  initialCapacity?: number; // default 1024
}

// ------------------------------------------------------------
// 🧩 Clear, condensed type aliases
// ------------------------------------------------------------

export type ScalarCtor =
  | Float32ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor;

export type FieldMeta<K extends string = string> = Readonly<{
  key: K;
  ctor: ScalarCtor;
  default?: number;
  link?: boolean; // true if the field encodes an entity-id/link (e.g. parent)
}>;

export type ComponentMeta<
  Name extends string = string,
  K extends string = string
> = Readonly<{
  name: Name;
  fields: ReadonlyArray<FieldMeta<K>>;
}>;

/** Union of field keys for a given meta. */
export type KeysOf<M extends ComponentMeta> = M["fields"][number]["key"];

/** Readonly column map for a given meta. */
export type ColumnsOf<M extends ComponentMeta> = Readonly<{
  [K in KeysOf<M>]: Float32Array | Int32Array | Uint32Array;
}>;

/** Mutable column map (internal use). */
type MutableColumnsOf<M extends ComponentMeta> = {
  [K in KeysOf<M>]: Float32Array | Int32Array | Uint32Array;
};

/** A Component definition: just the meta. */
export type Def<M extends ComponentMeta = ComponentMeta> = Readonly<{
  meta: M;
}>;

/** Extract the meta from a Def. */
export type MetaOf<D extends Def> = D["meta"];

/** A typed store handle for a given meta. */
export type StoreOf<M extends ComponentMeta = ComponentMeta> =
  ComponentStore<M>;

/** Factory to preserve literal name & field keys. */
export function defineMeta<
  const N extends string,
  const F extends readonly FieldMeta<string>[]
>(meta: Readonly<{ name: N; fields: F }>) {
  return meta as Readonly<{ name: N; fields: F }>;
}

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

// ------------------------------------------------------------
// 🔎 Query view (materialized join across stores)
// ------------------------------------------------------------

export interface QueryView {
  driver: string;
  count: number;
  entities: Int32Array; // [count]
  rows: Record<string, Int32Array>; // rows[name][i] = dense row index in that store
}

// ------------------------------------------------------------
// ⚙️ Internals
// ------------------------------------------------------------

type TypedArrayLike = Float32Array | Int32Array | Uint32Array;
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

// ---------------------------------
// SoA sparse-set store (scalar columns only) — meta-driven
// ---------------------------------
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
export type HierarchyLike = {
  /** Detach subtree root 'entity' (becomes root); no-ops if entity isn't present. */
  remove(entity: number): void;
  /** Name for debugging (e.g., "TransformNode", "RenderNode") */
  componentName?: string;
};

export class World {
  readonly entities: EntityAllocator;
  private _stores = new Map<string, ComponentStore<any>>();
  private _registry = new Map<string, Def<any>>();
  private _hierarchies = new Map<string, HierarchyLike>();

  readonly entityEpoch: Uint32Array;

  constructor(cfg: WorldConfig = {}) {
    const cap = cfg.initialCapacity ?? 1024;
    this.entities = new EntityAllocator(cap);
    this.entityEpoch = this.entities.entityEpoch;
  }

  /** Register a component definition (meta). */
  register<D extends Def>(def: D, initialCapacity = 256): StoreOf<MetaOf<D>> {
    const meta = def.meta;
    if (this._registry.has(meta.name))
      throw new Error(`Component '${meta.name}' already registered`);
    const store = new ComponentStore(meta, initialCapacity) as StoreOf<
      MetaOf<D>
    >;
    this._registry.set(meta.name, def);
    this._stores.set(meta.name, store);
    return store;
  }

  /** Un-typed lookup by name (kept for compatibility). */
  store<M extends ComponentMeta = ComponentMeta>(name: string): StoreOf<M> {
    const store = this._stores.get(name);
    if (!store) throw new Error(`Unknown component store '${name}'`);
    return store as StoreOf<M>;
  }

  /** Strongly-typed lookup by meta object, returns slim StoreView for clean hovers. */
  storeOf<const N extends string, const F extends readonly FieldMeta<string>[]>(
    meta: Readonly<{ name: N; fields: F }>
  ): StoreView<N, F[number]["key"]> {
    const s = this.store(meta.name) as ComponentStore<
      Readonly<{ name: N; fields: F }>
    >;
    // Narrow public surface to reduce hover noise:
    return {
      name: s.name,
      meta: s.meta,
      get size() {
        return s.size;
      },
      get capacity() {
        return s.capacity;
      },
      get entityToDense() {
        return s.entityToDense;
      },
      get denseToEntity() {
        return s.denseToEntity;
      },
      get rowVersion() {
        return s.rowVersion;
      },
      get storeEpoch() {
        return s.storeEpoch;
      },
      fields: () => s.fields() as any,
      has: (e) => s.has(e),
      denseIndexOf: (e) => s.denseIndexOf(e),
      add: (e, init) => s.add(e, init as any),
      update: (e, patch) => s.update(e, patch as any),
      remove: (e) => s.remove(e),
    };
  }

  createEntity(): Entity {
    return this.entities.create();
  }

  // Full teardown: remove from all stores, then free the entity.
  destroyEntity(entity: Entity) {
    for (const store of this._stores.values()) {
      if ((store as ComponentStore<any>).has(entity))
        (store as ComponentStore<any>).remove(entity);
    }
    this.entities.destroy(entity);
  }
  /** Register a hierarchy view by component name (idempotent). */
  registerHierarchy(name: string, h: HierarchyLike) {
    this._hierarchies.set(name, h);
  }
  /** Unregister a hierarchy view by component name (no-op if missing). */
  unregisterHierarchy(name: string) {
    this._hierarchies.delete(name);
  }
  /** Iterate registered hierarchies (internal/testing). */
  forEachHierarchy(cb: (name: string, h: HierarchyLike) => void) {
    for (const [n, h] of this._hierarchies) cb(n, h);
  }

  /**
   * Safely destroy an entity:
   * - If removeFromTrees is true (default): detach from all registered hierarchies first.
   * - Then remove from all component stores and free the entity id.
   * If you pass false, it will skip the hierarchy detaches. Only do this if you know the entity
   * is not part of a registered hierarchy (or you have already detached it).
   */
  destroyEntitySafe(entity: Entity, removeFromTrees = true) {
    // 1) Optionally detach from hierarchies
    if (removeFromTrees) {
      for (const h of this._hierarchies.values()) {
        try {
          h.remove(entity);
        } catch {
          /* ignore */
        }
      }
    }
    // 2) Remove from all component stores (existing logic)
    this.destroyEntity(entity);
  }

  /** @internal */
  __listStoreNames?(): string[] {
    return Array.from(this._stores.keys());
  }
  /** @internal */
  __forEachStore?(cb: (name: string, store: ComponentStore<any>) => void) {
    for (const [name, store] of this._stores) cb(name, store);
  }

  // -----------------------------
  // queryView: single-pass materialized join across stores
  // -----------------------------
  queryView(...requiredComponents: string[]): any {
    if (requiredComponents.length === 0) {
      return { driver: "", count: 0, entities: new Int32Array(0), rows: {} };
    }

    // Pick smallest store as the driver
    let driverName = requiredComponents[0]!;
    let driver = this._stores.get(driverName);
    if (!driver) throw new Error(`Unknown component '${driverName}'`);
    for (let i = 1; i < requiredComponents.length; i++) {
      const compStore = this._stores.get(requiredComponents[i]!);
      if (!compStore)
        throw new Error(`Unknown component '${requiredComponents[i]}'`);
      if (compStore.size < driver!.size) {
        driver = compStore;
        driverName = requiredComponents[i]!;
      }
    }
    if (!driver || driver.size === 0) {
      return {
        driver: driverName,
        count: 0,
        entities: new Int32Array(0),
        rows: {},
      };
    }

    const compStores = requiredComponents.map((n) => this._stores.get(n)!);

    const maxN = driver.size;
    const entities = new Int32Array(maxN);
    const rows: Record<string, Int32Array> = Object.create(null);
    for (const name of requiredComponents) rows[name] = new Int32Array(maxN);

    const staged: number[] = new Array(compStores.length);
    let out = 0;

    for (let denseI = 0; denseI < maxN; denseI++) {
      const entity = driver.denseToEntity[denseI]!;
      let ok = true;

      for (let cI = 0; cI < compStores.length; cI++) {
        const comp = compStores[cI]!;
        const rowIndex = comp.denseIndexOf(entity!);
        if (rowIndex < 0) {
          ok = false;
          break;
        }
        staged[cI] = rowIndex;
      }
      if (!ok) continue;

      entities[out] = entity!;
      for (let cI = 0; cI < compStores.length; cI++) {
        const comp = compStores[cI]!;
        rows[(comp as any).name as string]![out] = staged[cI]!;
      }
      out++;
    }

    const entitiesView = entities.subarray(0, out);
    const rowsView: Record<string, Int32Array> = Object.create(null);
    for (const name of requiredComponents)
      rowsView[name] = rows[name]!.subarray(0, out);

    return {
      driver: driverName,
      count: out,
      entities: entitiesView,
      rows: rowsView,
    };
  }
}

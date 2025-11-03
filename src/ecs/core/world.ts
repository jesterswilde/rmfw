// src/ecs/core/world.ts
import type { Def, HierarchyLike, MetaOf, ComponentMeta, FieldMeta, Entity } from "../interfaces";
import { ComponentStore, type StoreOf, type StoreView } from "./componentStore";
import { EntityAllocator } from "./entityAllocator";

export interface WorldConfig {
  initialCapacity?: number; // default 1024
}

export class World {
  readonly entities: EntityAllocator;
  private _stores = new Map<string, ComponentStore<any>>();
  private _registry = new Map<string, Def<any>>();
  private _hierarchies = new Map<string, HierarchyLike>();

  /** Entities that cannot be destroyed (e.g. tree roots). */
  private readonly protectedEntities = new Set<number>();

  // Always return the allocator's CURRENT epoch buffer (never a stale reference).
  get entityEpoch(): Uint32Array {
    return this.entities.entityEpoch;
  }

  constructor(cfg: WorldConfig = {}) {
    const cap = cfg.initialCapacity ?? 1024;
    this.entities = new EntityAllocator(cap);
  }

  /** Mark an entity as protected from deletion. */
  protectEntity(entity: Entity) {
    this.protectedEntities.add(entity | 0);
  }
  /** Remove protection from an entity. */
  unprotectEntity(entity: Entity) {
    this.protectedEntities.delete(entity | 0);
  }
  /** Query if an entity is protected from deletion. */
  isEntityProtected(entity: Entity): boolean {
    return this.protectedEntities.has(entity | 0);
  }

  /** Register a component definition (meta). */
  register<D extends Def>(def: D, initialCapacity = 256): StoreOf<MetaOf<D>> {
    const meta = def.meta;
    if (this._registry.has(meta.name))
      throw new Error(`Component '${meta.name}' already registered`);
    const store = new ComponentStore(meta, initialCapacity) as StoreOf<MetaOf<D>>;
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

  /** Strongly-typed lookup by meta object, returns slim StoreView */
  storeOf<const N extends string, const F extends readonly FieldMeta<string>[]>(
    meta: Readonly<{ name: N; fields: F }>
  ): StoreView<N, F[number]["key"]> {
    const s = this.store(meta.name) as ComponentStore<Readonly<{ name: N; fields: F }>>;
    return {
      name: s.name,
      meta: s.meta,
      get size() { return s.size; },
      get capacity() { return s.capacity; },
      get entityToDense() { return s.entityToDense; },
      get denseToEntity() { return s.denseToEntity; },
      get rowVersion() { return s.rowVersion; },
      get storeEpoch() { return s.storeEpoch; },
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

  /**
   * Safely destroy an entity:
   * - If removeFromTrees is true (default): detach from all registered hierarchies first.
   * - Then remove from all component stores and free the entity id.
   * Throws if the entity is protected (e.g., a tree root).
   */
  destroyEntitySafe(entity: Entity, removeFromTrees = true) {
    const id = entity | 0;
    if (this.protectedEntities.has(id)) {
      throw new Error(`Cannot destroy protected entity ${id}`);
    }
    if (removeFromTrees) {
      for (const h of this._hierarchies.values()) {
        try { h.remove(id); } catch { /* ignore */ }
      }
    }
    this.destroyEntity(id);
  }

  /** Register a hierarchy view by component name (idempotent). */
  registerHierarchy(name: string, h: HierarchyLike) {
    this._hierarchies.set(name, h);
  }
  /** Unregister a hierarchy view by component name (no-op if missing). */
  unregisterHierarchy(name: string) {
    this._hierarchies.delete(name);
  }
  /** Iterate registered hierarchies (internal/testing) SLOW. */
  forEachHierarchy(cb: (name: string, h: HierarchyLike) => void) {
    for (const [n, h] of this._hierarchies) cb(n, h);
  }

  /** @internal */
  __listStoreNames?(): string[] {
    return Array.from(this._stores.keys());
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
      if (!compStore) throw new Error(`Unknown component '${requiredComponents[i]}'`);
      if (compStore.size < driver!.size) {
        driver = compStore;
        driverName = requiredComponents[i]!;
      }
    }
    if (!driver || driver.size === 0) {
      return { driver: driverName, count: 0, entities: new Int32Array(0), rows: {} };
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
        if (rowIndex < 0) { ok = false; break; }
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
    for (const name of requiredComponents) rowsView[name] = rows[name]!.subarray(0, out);

    return { driver: driverName, count: out, entities: entitiesView, rows: rowsView };
  }

  /**
   * Densify entity ids across the entire world:
   * - Compute remap from current dense order (old -> new).
   * - Remap all component stores (mappings + link fields).
   * - Remap the protected set (mutate in place).
   * - Finally apply the remap to the allocator (ids become 0..N-1).
   * Returns the remap used (old -> new).
   */
  densifyEntities(): Int32Array {
    const { remap } = this.entities.computeDenseRemap();

    // Remap all stores first (while ids still refer to "old")
    for (const store of this._stores.values()) {
      store.remapEntitiesAndLinks(remap);
    }

    // Remap protected set in place
    const keep: number[] = [];
    for (const id of this.protectedEntities) {
      const m = id < remap.length ? remap[id]! : -1;
      if (m >= 0) keep.push(m);
    }
    this.protectedEntities.clear();
    for (const nid of keep) this.protectedEntities.add(nid);

    // Apply to allocator last
    this.entities.applyRemap(remap);

    return remap;
  }

  export(opts: { densify?: boolean } = {}): any {
    const densify = opts.densify ?? true;
    if (densify) this.densifyEntities();

    // snapshot allocator
    const allocator = this.entities.export();

    // snapshot stores
    const components: Record<string, any> = Object.create(null);
    for (const [name, store] of this._stores) {
      components[name] = store.export();
    }

    // protected ids
    const protectedIds = Array.from(this.protectedEntities);

    return {
      allocator,
      components,
      protectedIds,
    };
  }

  import(payload: { allocator: any; components: Record<string, any>; protectedIds: number[] }): void {
    // allocator first (this will swap internal epoch buffer)
    this.entities.import(payload.allocator);

    // stores must already be registered with matching metas
    for (const [name, snap] of Object.entries(payload.components)) {
      const store = this._stores.get(name);
      if (!store) throw new Error(`Import failed: store '${name}' is not registered`);
      store.import(snap);
    }

    // protected ids
    this.protectedEntities.clear();
    for (const id of payload.protectedIds)
      this.protectedEntities.add(id | 0);
  }
}

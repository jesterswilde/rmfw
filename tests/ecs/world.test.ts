// tests/ecs/world.test.ts
import { World } from "../../src/ecs/core/world.js";
import type { ComponentMeta, Def } from "../../src/ecs/interfaces.js";

type Vec2 = "x" | "y";
type Vel = "vx" | "vy";
type ScaleKey = "scale";

const positionMeta: ComponentMeta<"Position", Vec2> = {
  name: "Position",
  fields: [
    { key: "x", ctor: Float32Array, default: 0 },
    { key: "y", ctor: Float32Array, default: 0 },
  ],
};

const velocityMeta: ComponentMeta<"Velocity", Vel> = {
  name: "Velocity",
  fields: [
    { key: "vx", ctor: Float32Array, default: 0 },
    { key: "vy", ctor: Float32Array, default: 0 },
  ],
};

const scaleMeta: ComponentMeta<"Scale", ScaleKey> = {
  name: "Scale",
  fields: [{ key: "scale", ctor: Float32Array, default: 1 }],
};

const linkMeta: ComponentMeta<"Links", "parent" | "next" | "prev"> = {
  name: "Links",
  fields: [
    { key: "parent", ctor: Int32Array, default: -1, link: true },
    { key: "next",   ctor: Int32Array, default: -1, link: true },
    { key: "prev",   ctor: Int32Array, default: -1, link: true },
  ],
};

const positionDef: Def<typeof positionMeta> = { meta: positionMeta } as const;
const velocityDef: Def<typeof velocityMeta> = { meta: velocityMeta } as const;
const scaleDef: Def<typeof scaleMeta> = { meta: scaleMeta } as const;
const linkDef: Def<typeof linkMeta> = { meta: linkMeta } as const;

describe("World", () => {
  it("registers components and exposes stores", () => {
    const world = new World({ initialCapacity: 2 });
    const posStore = world.register(positionDef, 1);

    expect(posStore.capacity).toBe(1);
    expect(world.store("Position")).toBe(posStore);

    const view = world.storeOf(positionMeta);
    expect(view.name).toBe("Position");
    expect(view.capacity).toBe(1);

    const entity = world.createEntity();
    posStore.add(entity, { x: 5, y: 6 });
    expect(view.size).toBe(1);
    expect(view.denseToEntity[0]).toBe(entity);
    expect(view.fields().x[0]).toBeCloseTo(5);

    expect(() => world.register(positionDef, 1)).toThrow();
    expect(() => world.store("Missing")).toThrow();

    const fakeMeta: ComponentMeta<"Missing", never> = { name: "Missing", fields: [] };
    expect(() => world.storeOf(fakeMeta)).toThrow();
  });

  it("grows stores as entities add rows", () => {
    const world = new World({ initialCapacity: 1 });
    const posStore = world.register(positionDef, 1);

    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const entity = world.createEntity();
      ids.push(entity);
      posStore.add(entity, { x: i, y: i + 1 });
    }

    expect(posStore.capacity).toBeGreaterThanOrEqual(6);
    expect(posStore.size).toBe(6);

    for (let i = 0; i < ids.length; i++) {
      const dense = posStore.denseIndexOf(ids[i]!);
      expect(dense).toBeGreaterThanOrEqual(0);
      expect(posStore.fields().x[dense]).toBeCloseTo(i);
      expect(posStore.fields().y[dense]).toBeCloseTo(i + 1);
    }
  });

  it("creates, destroys, and reuses entity ids", () => {
    const world = new World({ initialCapacity: 1 });
    const posStore = world.register(positionDef, 1);
    const velStore = world.register(velocityDef, 1);

    const a = world.createEntity();
    const b = world.createEntity();
    posStore.add(a, { x: 1, y: 2 });
    posStore.add(b, { x: 10, y: 20 });
    velStore.add(b, { vx: 5, vy: 6 });

    expect(Array.from(world.entities.dense)).toEqual([0, 1]);

    world.destroyEntity(a);
    expect(posStore.has(a)).toBe(false);
    expect(world.entities.isAlive(a)).toBe(false);
    expect(world.entities.entityEpoch[a]).toBe(1);

    const reused = world.createEntity();
    expect(reused).toBe(a);
    expect(world.entities.isAlive(reused)).toBe(true);
    expect(world.entities.entityEpoch[reused]).toBe(1);

    posStore.add(reused, { x: 7, y: 8 });
    world.destroyEntitySafe(b);
    expect(velStore.has(b)).toBe(false);
    expect(world.entities.isAlive(b)).toBe(false);
    expect(world.entities.entityEpoch[b]).toBe(1);
  });

  it("notifies hierarchies when safely destroying entities", () => {
    const world = new World();
    const posStore = world.register(positionDef, 1);
    const entity = world.createEntity();
    posStore.add(entity, { x: 0, y: 0 });

    const keep = { remove: jest.fn() };
    const drop = { remove: jest.fn() };

    world.registerHierarchy("keep", keep);
    world.registerHierarchy("drop", drop);
    world.unregisterHierarchy("drop");

    world.destroyEntitySafe(entity);

    expect(keep.remove).toHaveBeenCalledWith(entity);
    expect(drop.remove).not.toHaveBeenCalled();
  });

  it("skips hierarchy removal when requested", () => {
    const world = new World();
    const posStore = world.register(positionDef, 1);
    const entity = world.createEntity();
    posStore.add(entity, { x: 0, y: 0 });

    const h = { remove: jest.fn() };
    world.registerHierarchy("tree", h);

    world.destroyEntitySafe(entity, false);

    expect(h.remove).not.toHaveBeenCalled();
    expect(posStore.has(entity)).toBe(false);
    expect(world.entities.isAlive(entity)).toBe(false);
  });

  it("enforces entity protection for safe destruction", () => {
    const world = new World();
    const entity = world.createEntity();
    world.protectEntity(entity);

    expect(world.isEntityProtected(entity)).toBe(true);
    expect(() => world.destroyEntitySafe(entity)).toThrow();

    world.unprotectEntity(entity);
    expect(world.isEntityProtected(entity)).toBe(false);
    world.destroyEntity(entity);
    expect(world.entities.isAlive(entity)).toBe(false);
  });

  it("joins stores and filters entities without required components", () => {
    const world = new World();
    const posStore = world.register(positionDef, 4);
    const velStore = world.register(velocityDef, 4);
    world.register(scaleDef, 4);

    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();

    posStore.add(a, { x: 1, y: 1 });
    posStore.add(b, { x: 2, y: 2 });
    posStore.add(c, { x: 3, y: 3 });

    velStore.add(a, { vx: 10, vy: 20 });
    velStore.add(c, { vx: 30, vy: 40 });

    const joined = world.queryView("Position", "Velocity");
    expect(joined.driver).toBe("Velocity");
    expect(joined.count).toBe(2);
    expect(Array.from(joined.entities)).toEqual(expect.arrayContaining([a, c]));

    for (let i = 0; i < joined.count; i++) {
      const entity = joined.entities[i]!;
      expect(joined.rows.Position[i]).toBe(posStore.denseIndexOf(entity));
      expect(joined.rows.Velocity[i]).toBe(velStore.denseIndexOf(entity));
    }

    const emptyJoin = world.queryView("Position", "Scale");
    expect(emptyJoin.count).toBe(0);
    expect(emptyJoin.entities.length).toBe(0);

    const missing = world.queryView("Scale");
    expect(missing.count).toBe(0);
    expect(missing.entities.length).toBe(0);

    const none = world.queryView();
    expect(none.count).toBe(0);
    expect(none.entities.length).toBe(0);
  });

  it("handles large create/destroy cycles", () => {
    const world = new World({ initialCapacity: 4 });
    const posStore = world.register(positionDef, 2);
    const ids: number[] = [];

    for (let i = 0; i < 128; i++) {
      const id = world.createEntity();
      ids.push(id);
      posStore.add(id, { x: i, y: -i });
    }

    expect(posStore.size).toBe(128);

    for (let i = ids.length - 1; i >= 0; i--) {
      world.destroyEntity(ids[i]!);
    }

    expect(world.entities.size).toBe(0);
    expect(posStore.size).toBe(0);
  });

  it("densifies entities across stores and remaps link fields & protected set", () => {
    const world = new World({ initialCapacity: 8 });
    const pos = world.register(positionDef, 4);
    const links = world.register(linkDef, 4);

    // Create sparse ids: [0,1,2,3,4], then remove 1 and 3 to force gaps
    const ids = [world.createEntity(), world.createEntity(), world.createEntity(), world.createEntity(), world.createEntity()];
    pos.add(ids[0]!, { x: 0, y: 0 });
    pos.add(ids[1]!, { x: 1, y: 1 });
    pos.add(ids[2]!, { x: 2, y: 2 });
    pos.add(ids[3]!, { x: 3, y: 3 });
    pos.add(ids[4]!, { x: 4, y: 4 });

    // Link chain: 0 -> 2 -> 4 (parent is previous, next is next, prev is previous)
    links.add(ids[0]!, { parent: -1, next: ids[2]!, prev: -1 });
    links.add(ids[2]!, { parent: ids[0]!, next: ids[4]!, prev: ids[0]! });
    links.add(ids[4]!, { parent: ids[2]!, next: -1, prev: ids[2]! });

    // Protect id 0 and 4
    world.protectEntity(ids[0]!);
    world.protectEntity(ids[4]!);

    world.destroyEntity(ids[1]!);
    world.destroyEntity(ids[3]!);

    // Densify: live ids [0,2,4] should remap to [0,1,2]
    const remap = world.densifyEntities();

    const live = Array.from(world.entities.dense);
    expect(live).toEqual([0, 1, 2]);

    // Position rows track new entity ids
    for (let i = 0; i < pos.size; i++) {
      const e = pos.denseToEntity[i]!;
      expect(e).toBeGreaterThanOrEqual(0);
      expect(world.entities.isAlive(e)).toBe(true);
    }

    // Link fields remapped through densify
    const lf = links.fields() as any;
    // old 0 -> new 0, old 2 -> new 1, old 4 -> new 2
    expect(lf.next[links.entityToDense[0]]).toBe(1);
    expect(lf.parent[links.entityToDense[1]]).toBe(0);
    expect(lf.next[links.entityToDense[1]]).toBe(2);
    expect(lf.prev[links.entityToDense[1]]).toBe(0);
    expect(lf.parent[links.entityToDense[2]]).toBe(1);
    expect(lf.prev[links.entityToDense[2]]).toBe(1);

    // Protected set remapped
    const protRemapped = [remap[ids[0]!]!, remap[ids[4]!]!];
    expect(protRemapped.every((p) => world.isEntityProtected(p))).toBe(true);
  });

  it("exports and imports a world (with and without densify)", () => {
    const makeWorld = () => {
      const w = new World({ initialCapacity: 2 });
      const pos = w.register(positionDef, 2);
      const vel = w.register(velocityDef, 2);
      const a = w.createEntity();
      const b = w.createEntity();
      pos.add(a, { x: 1, y: 2 });
      vel.add(a, { vx: 3, vy: 4 });
      pos.add(b, { x: 5, y: 6 });
      w.protectEntity(a);
      return { w, pos, vel };
    };

    // 1) With densify (default)
    {
      const { w } = makeWorld();
      const dump = w.export(); // densify = true by default

      const w2 = new World({ initialCapacity: 1 });
      // Re-register matching metas before import
      w2.register(positionDef, 1);
      w2.register(velocityDef, 1);

      w2.import(dump);

      // Same number of entities, stores, and protected ids
      expect(w2.entities.size).toBe(w.entities.size);
      expect(Array.from(w2.entities.dense)).toEqual(Array.from(w.entities.dense));
      expect(Array.from(w2["entityEpoch"])).toHaveLength(w["entityEpoch"].length);

      const p2 = w2.store("Position");
      const v2 = w2.store("Velocity");
      expect(p2.size).toBe(w.store("Position").size);
      expect(v2.size).toBe(w.store("Velocity").size);
    }

    // 2) Without densify (sparse save shape)
    {
      const { w } = makeWorld();
      // Create sparsity
      const extra = w.createEntity();
      w.destroyEntity(extra);

      const dump = w.export({ densify: false });

      const w2 = new World({ initialCapacity: 1 });
      w2.register(positionDef, 1);
      w2.register(velocityDef, 1);
      w2.import(dump);

      // Sparse allocator state preserved
      expect(w2.entities.capacity).toBeGreaterThanOrEqual(w.entities.capacity);
      expect(w2.entities.size).toBe(w.entities.size);
      expect(Array.from(w2.entities.dense)).toEqual(Array.from(w.entities.dense));
    }
  });
});

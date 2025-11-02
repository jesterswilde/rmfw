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

const positionDef: Def<typeof positionMeta> = { meta: positionMeta } as const;
const velocityDef: Def<typeof velocityMeta> = { meta: velocityMeta } as const;
const scaleDef: Def<typeof scaleMeta> = { meta: scaleMeta } as const;

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
});

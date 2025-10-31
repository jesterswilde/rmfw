// tests/ecs/worldRegistry.test.ts
import { initWorld, Transform, TransformMeta, TransformNode, TransformNodeMeta, RenderNode, ShapeLeaf, Operation } from "../../src/ecs/registry";

describe("World + Registry", () => {
  test("initWorld registers all components and store() retrieves them", () => {
    const world = initWorld({ initialCapacity: 8 });

    // Prefer typed lookups
    const t  = world.storeOf(TransformMeta);
    const tn = world.storeOf(TransformNodeMeta);
    const rn = world.store(RenderNode.meta.name);
    const sl = world.store(ShapeLeaf.meta.name);
    const op = world.store(Operation.meta.name);

    expect(t.name).toBe(TransformMeta.name);
    expect(tn.name).toBe(TransformNodeMeta.name);
    expect(rn.name).toBe(RenderNode.meta.name);
    expect(sl.name).toBe(ShapeLeaf.meta.name);
    expect(op.name).toBe(Operation.meta.name);

    // Meta is present and ordered
    expect(Array.isArray(t.meta.fields)).toBe(true);
    expect(Array.isArray(tn.meta.fields)).toBe(true);

    const tFieldOrder = t.meta.fields.map(f => f.key);
    expect(tFieldOrder.slice(0, 4)).toEqual(["local_r00", "local_r01", "local_r02", "local_tx"]);
  });

  test("destroyEntity removes rows from all stores and bumps allocator entityEpoch", () => {
    const world = initWorld({ initialCapacity: 8 });
    const t  = world.storeOf(TransformMeta);
    const tn = world.storeOf(TransformNodeMeta);

    const e = world.createEntity();

    t.add(e, { local_tx: 1 });
    tn.add(e, { parent: -1, firstChild: -1, nextSibling: -1 });

    const epochBefore = world.entityEpoch[e]!;
    world.destroyEntity(e);

    expect(t.has(e)).toBe(false);
    expect(tn.has(e)).toBe(false);
    expect(world.entities.isAlive(e)).toBe(false);
    expect(world.entityEpoch[e]).toBe((epochBefore + 1) >>> 0);
  });
});

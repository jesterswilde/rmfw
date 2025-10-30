// tests/ecs/worldRegistry.test.ts
import {
  initWorld,
  Transform,
  TransformNode,
  RenderNode,
  ShapeLeaf,
  Operation,
} from "../../src/ecs/registry";

describe("World + Registry", () => {
  test("initWorld registers all components and store() retrieves them", () => {
    const world = initWorld({ initialCapacity: 8 });

    const t  = world.store(Transform.meta.name);
    const tn = world.store(TransformNode.meta.name);
    const rn = world.store(RenderNode.meta.name);
    const sl = world.store(ShapeLeaf.meta.name);
    const op = world.store(Operation.meta.name);

    expect(t.name).toBe("Transform");
    expect(tn.name).toBe("TransformNode");
    expect(rn.name).toBe("RenderNode");
    expect(sl.name).toBe("ShapeLeaf");
    expect(op.name).toBe("Operation");

    // sanity: stores expose ordered field list
    expect(Array.isArray(t.fieldOrder)).toBe(true);
    expect(t.fieldOrder.length).toBeGreaterThan(0);
  });

  test("destroyEntity removes rows from all stores and bumps allocator entityEpoch", () => {
    const world = initWorld({ initialCapacity: 8 });
    const t  = world.store(Transform.meta.name);
    const tn = world.store(TransformNode.meta.name);

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

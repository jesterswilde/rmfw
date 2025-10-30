// tests/worldRegistry.test.ts
import { initWorld, Transform, TransformNode, RenderNode, ShapeLeaf, Operation } from "../src/ecs/registry";

describe("World + Registry", () => {
  test("initWorld registers all components and store() retrieves them", () => {
    const world = initWorld({ initialCapacity: 8 });
    const t = world.store<typeof Transform.schema>(Transform.name);
    const tn = world.store<typeof TransformNode.schema>(TransformNode.name);
    const rn = world.store<typeof RenderNode.schema>(RenderNode.name);
    const sl = world.store<typeof ShapeLeaf.schema>(ShapeLeaf.name);
    const op = world.store<typeof Operation.schema>(Operation.name);

    expect(t.name).toBe("Transform");
    expect(tn.name).toBe("TransformNode");
    expect(rn.name).toBe("RenderNode");
    expect(sl.name).toBe("ShapeLeaf");
    expect(op.name).toBe("Operation");
  });

  test("destroyEntity removes rows from all stores and bumps allocator entityEpoch", () => {
    const world = initWorld({ initialCapacity: 8 });
    const t = world.store<any>("Transform");
    const tn = world.store<any>("TransformNode");
    const e = world.createEntity();

    t.add(e, { local_tx: 1 });
    tn.add(e, { parent: -1 });

    const epochBefore = world.entityEpoch[e];
    world.destroyEntity(e);

    expect(t.has(e)).toBe(false);
    expect(tn.has(e)).toBe(false);
    expect(world.entities.isAlive(e)).toBe(false);
    expect(world.entityEpoch[e]).toBe((epochBefore + 1) >>> 0);
  });
});

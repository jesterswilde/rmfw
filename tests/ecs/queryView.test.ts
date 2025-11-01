// tests/queryView.test.ts
import { initWorld, Transform } from "../../src/ecs/core/registry";

describe("World.queryView", () => {
  test("returns only entities that have all required components", () => {
    const world = initWorld({ initialCapacity: 16 });
    const T = world.store<any>("Transform");
    const RN = world.store<any>("RenderNode");

    // Create 5 entities; only some get both components
    const e0 = world.createEntity(); T.add(e0, { local_tx: 1 });
    const e1 = world.createEntity(); T.add(e1, { local_tx: 2 }); RN.add(e1, { parent: -1 });
    const e2 = world.createEntity(); /* RN intentionally NOT added here */
    const e3 = world.createEntity(); T.add(e3, { local_tx: 3 }); RN.add(e3, { parent: -1 });
    const e4 = world.createEntity(); /* none */

    // Now: RN.size (2) < T.size (3) => RN should be driver
    const q = world.queryView("Transform", "RenderNode");

    expect(q.driver).toBe("RenderNode");
    expect(q.count).toBe(2);
    const got = Array.from(q.entities);
    expect(new Set(got)).toEqual(new Set([e1, e3]));

    for (let i = 0; i < q.count; i++) {
      const ent = q.entities[i]!;
      expect(q.rows["Transform"][i]).toBe(T.denseIndexOf(ent));
      expect(q.rows["RenderNode"][i]).toBe(RN.denseIndexOf(ent));
    }
  });

  test("empty driver store returns empty view", () => {
    const world = initWorld({ initialCapacity: 8 });
    const q = world.queryView("Transform"); // Transform store empty
    expect(q.count).toBe(0);
    expect(q.entities.length).toBe(0);
  });

  test("throws on unknown component name", () => {
    const world = initWorld({ initialCapacity: 8 });
    expect(() => world.queryView("Nope")).toThrow(/Unknown component/);
  });
});

// test/trees.test.ts
import { initWorld } from "../../src/ecs/registry";
import { TransformTree, RenderTree } from "../../src/ecs/trees";

const NONE = -1;

describe("Phase 2 — Tree wrappers (TransformTree, RenderTree)", () => {
  test("addChild builds deterministic DFS order (root-first, stable siblings)", () => {
    const world = initWorld({ initialCapacity: 32 });
    const tTree = new TransformTree(world);
    const rTree = new RenderTree(world);

    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();

    // Create A -> {B, C} (append preserves sibling order)
    tTree.addChild(a, b);
    tTree.addChild(a, c);
    rTree.addChild(a, b);
    rTree.addChild(a, c);

    expect(Array.from(tTree.order)).toEqual([a, b, c]);
    expect(Array.from(rTree.order)).toEqual([a, b, c]);

    // Basic lengths
    expect(tTree.order.length).toBe(3);
    expect(rTree.order.length).toBe(3);
  });

  test("reparent moves subtree and preserves DFS semantics", () => {
    const world = initWorld({ initialCapacity: 32 });
    const tTree = new TransformTree(world);
    const rTree = new RenderTree(world);

    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();

    tTree.addChild(a, b);
    tTree.addChild(a, c);
    rTree.addChild(a, b);
    rTree.addChild(a, c);

    const epochBeforeT = tTree.epoch;
    const epochBeforeR = rTree.epoch;

    // Move C under B → DFS: A, B, C
    tTree.reparent(c, b);
    rTree.reparent(c, b);

    expect(Array.from(tTree.order)).toEqual([a, b, c]);
    expect(Array.from(rTree.order)).toEqual([a, b, c]);

    // Epochs bumped
    expect(tTree.epoch).toBeGreaterThan(epochBeforeT);
    expect(rTree.epoch).toBeGreaterThan(epochBeforeR);
  });

  test("remove detaches a subtree root (becomes its own root)", () => {
    const world = initWorld({ initialCapacity: 32 });
    const tTree = new TransformTree(world);
    const rTree = new RenderTree(world);

    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();

    tTree.addChild(a, b);
    tTree.addChild(a, c);
    rTree.addChild(a, b);
    rTree.addChild(a, c);

    const epochBeforeT = tTree.epoch;

    // Detach B (it becomes a root)
    tTree.remove(b);
    rTree.remove(b);

    // Both trees still include all entities
    const tSet = new Set(Array.from(tTree.order));
    const rSet = new Set(Array.from(rTree.order));
    expect(tSet.has(a) && tSet.has(b) && tSet.has(c)).toBe(true);
    expect(rSet.has(a) && rSet.has(b) && rSet.has(c)).toBe(true);

    // B's parent is NONE in both node stores
    const tn = world.store("TransformNode");
    const rn = world.store("RenderNode");
    const bTRow = tn.denseIndexOf(b);
    const bRRow = rn.denseIndexOf(b);
    expect(tn.fields().parent[bTRow]).toBe(NONE);
    expect(rn.fields().parent[bRRow]).toBe(NONE);

    // Epoch bumped
    expect(tTree.epoch).toBeGreaterThan(epochBeforeT);
  });

  test("multi-root order is deterministic across roots (ascending entity id)", () => {
    const world = initWorld({ initialCapacity: 32 });
    const tTree = new TransformTree(world);
    const rTree = new RenderTree(world);

    const a = world.createEntity();
    const b = world.createEntity();
    const d = world.createEntity();

    // A -> B
    tTree.addChild(a, b);
    rTree.addChild(a, b);

    // Explicitly make D a root by giving it node components (and Transform for TransformTree).
    const tStore = world.store("Transform");
    const tnStore = world.store("TransformNode");
    const rnStore = world.store("RenderNode");

    if (!tStore.has(d)) tStore.add(d);
    if (!tnStore.has(d))
      tnStore.add(d, { parent: -1, firstChild: -1, nextSibling: -1 });
    if (!rnStore.has(d))
      rnStore.add(d, { parent: -1, firstChild: -1, nextSibling: -1 });

    // Recompute orders
    tTree.rebuildOrder();
    rTree.rebuildOrder();

    // With two roots (A and D), DFS should start from the smaller entity id root (A).
    expect(tTree.order[0]).toBe(a);
    expect(rTree.order[0]).toBe(a);

    // Order must contain all tree members
    const tAll = new Set(Array.from(tTree.order));
    const rAll = new Set(Array.from(rTree.order));
    expect(tAll.has(a) && tAll.has(b) && tAll.has(d)).toBe(true);
    expect(rAll.has(a) && rAll.has(b) && rAll.has(d)).toBe(true);
  });

  test("TransformTree ensures Transform is present; RenderTree ensures RenderNode is present", () => {
    const world = initWorld({ initialCapacity: 32 });
    const tTree = new TransformTree(world);
    const rTree = new RenderTree(world);

    const p = world.createEntity();
    const c = world.createEntity();

    // Before addChild, these entities have no components. addChild should ensure required components.
    tTree.addChild(p, c);
    rTree.addChild(p, c);

    const tStore = world.store("Transform");
    const tnStore = world.store("TransformNode");
    const rnStore = world.store("RenderNode");

    expect(tStore.has(p)).toBe(true);
    expect(tStore.has(c)).toBe(true);
    expect(tnStore.has(p)).toBe(true);
    expect(tnStore.has(c)).toBe(true);
    expect(rnStore.has(p)).toBe(true);
    expect(rnStore.has(c)).toBe(true);
  });

  test("reparent throws on self-parent; remove is a no-op for non-node entities", () => {
    const world = initWorld({ initialCapacity: 32 });
    const tTree = new TransformTree(world);

    const a = world.createEntity();

    // Self-parent guard
    expect(() => tTree.reparent(a, a)).toThrow();

    // Removing an entity without a node component should not throw
    const x = world.createEntity(); // never added to TransformNode
    expect(() => tTree.remove(x)).not.toThrow();
  });

  test("order rebuild reflects structural changes consistently", () => {
    const world = initWorld({ initialCapacity: 32 });
    const tTree = new TransformTree(world);

    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();
    const d = world.createEntity();

    tTree.addChild(a, b);
    tTree.addChild(a, c);
    tTree.addChild(c, d);

    // Current DFS: A, B, C, D
    expect(Array.from(tTree.order)).toEqual([a, b, c, d]);

    // Detach C → becomes root; after rebuild, both roots A and C should appear,
    // with A first (smaller id), then its subtree, then C and D.
    tTree.remove(c);
    tTree.rebuildOrder();

    const order = Array.from(tTree.order);
    const idxA = order.indexOf(a);
    const idxB = order.indexOf(b);
    const idxC = order.indexOf(c);
    const idxD = order.indexOf(d);

    expect(idxA).toBeLessThan(idxC);
    expect(idxB).toBeGreaterThan(idxA); // B remains under A
    expect(idxD).toBeGreaterThan(idxC); // D remains under C
  });
});

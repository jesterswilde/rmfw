// tests/ecs/trees.edge.test.ts
import { initWorld, defineMeta } from "../../src/ecs/core/registry";
import { buildAllHierarchyTrees, TransformTree } from "../../src/ecs/trees";

const NONE = -1;

describe("Phase 2 — Hierarchy edge cases and invariants", () => {
  test("isHierarchyStore requires lastChild (legacy 4-link should NOT qualify)", () => {
    const world = initWorld({ initialCapacity: 16 });

    // Legacy 4-link meta (intentionally missing lastChild)
    const LegacyNodeMeta = defineMeta({
      name: "LegacyNode",
      fields: [
        { key: "parent", ctor: Int32Array, default: NONE, link: true },
        { key: "firstChild", ctor: Int32Array, default: NONE, link: true },
        { key: "nextSibling", ctor: Int32Array, default: NONE, link: true },
        { key: "prevSibling", ctor: Int32Array, default: NONE, link: true },
      ] as const,
    });

    world.register({ meta: LegacyNodeMeta }, 16);

    const trees = buildAllHierarchyTrees(world);
    expect(trees.has("LegacyNode")).toBe(false); // must NOT be treated as a hierarchy
    expect(trees.has("TransformNode")).toBe(true);
    expect(trees.has("RenderNode")).toBe(true);
  });

  test("unlinking head, middle, tail maintains firstChild/lastChild and sibling pointers", () => {
    const world = initWorld({ initialCapacity: 16 });
    const tTree = new TransformTree(world);
    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();
    const d = world.createEntity();
    const e = world.createEntity();

    // A -> {B, C, D}
    tTree.addChild(a, b);
    tTree.addChild(a, c);
    tTree.addChild(a, d);

    const tn = world.store("TransformNode");
    const cols = tn.fields() as any;

    // Remove head (B)
    tTree.remove(b);
    let aRow = tn.denseIndexOf(a);
    let cRow = tn.denseIndexOf(c);
    let dRow = tn.denseIndexOf(d);
    expect(cols.firstChild[aRow]).toBe(c);
    expect(cols.prevSibling[cRow]).toBe(NONE);

    // Append E, then remove tail (E)
    tTree.addChild(a, e);
    aRow = tn.denseIndexOf(a);
    let eRow = tn.denseIndexOf(e);
    expect(cols.lastChild[aRow]).toBe(e);
    tTree.remove(e);
    aRow = tn.denseIndexOf(a);
    expect(cols.lastChild[aRow]).toBe(d);

    // Remove middle (C)
    tTree.remove(c);
    aRow = tn.denseIndexOf(a);
    dRow = tn.denseIndexOf(d);
    cRow = tn.denseIndexOf(c);
    expect(cols.firstChild[aRow]).toBe(d);        // since only D remains
    expect(cols.prevSibling[dRow]).toBe(NONE);
    expect(cols.parent[cRow]).toBe(NONE);
    expect(cols.nextSibling[cRow]).toBe(NONE);
    expect(cols.prevSibling[cRow]).toBe(NONE);
  });

  test("reparent prevents cycles (cannot parent A under its descendant B)", () => {
    const world = initWorld({ initialCapacity: 16 });
    const tTree = new TransformTree(world);
    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();

    // A -> B -> C
    tTree.addChild(a, b);
    tTree.addChild(b, c);

    // Attempt to reparent A under C (descendant)
    expect(() => tTree.reparent(a, c)).toThrow();
  });

  test("makeRoot preserves local = previous world when Transform is present", () => {
    const world = initWorld({ initialCapacity: 16 });
    const tTree = new TransformTree(world);

    const p = world.createEntity();
    const x = world.createEntity();

    // Ensure Transform exists with some non-identity world on x.
    const T = world.store("Transform");
    const tCols = T.fields() as any;
    // Give both local and world some custom values
    const rowX = T.add(x);
    tCols.world_r00[rowX] = 2; tCols.world_r11[rowX] = 3; tCols.world_r22[rowX] = 4;
    tCols.world_tx[rowX] = 10; tCols.world_ty[rowX] = 20; tCols.world_tz[rowX] = 30;

    // Parent x under p first, then make root
    tTree.addChild(p, x);
    tTree.makeRoot(x);

    const rx = T.denseIndexOf(x);
    expect(tCols.local_r00[rx]).toBe(tCols.world_r00[rx]);
    expect(tCols.local_r11[rx]).toBe(tCols.world_r11[rx]);
    expect(tCols.local_r22[rx]).toBe(tCols.world_r22[rx]);
    expect(tCols.local_tx[rx]).toBe(tCols.world_tx[rx]);
    expect(tCols.local_ty[rx]).toBe(tCols.world_ty[rx]);
    expect(tCols.local_tz[rx]).toBe(tCols.world_tz[rx]);

    const tn = world.store("TransformNode");
    const nx = tn.denseIndexOf(x);
    expect((tn.fields() as any).parent[nx]).toBe(NONE);
  });

  test("destroyEntitySafe respects removeFromTrees=false (no detach), and true detaches before destroy", () => {
    const world = initWorld({ initialCapacity: 16 });
    const tTree = new TransformTree(world);

    // Case 1: removeFromTrees=false on an entity with NO node component
    const lone = world.createEntity();
    expect(() => world.destroyEntitySafe(lone, false)).not.toThrow();
    expect(world.entities.isAlive(lone)).toBe(false);

    // Case 2: true on a node child detaches and removes cleanly
    const p = world.createEntity();
    const c = world.createEntity();
    tTree.addChild(p, c);

    const tn = world.store("TransformNode");
    const pRow = tn.denseIndexOf(p);
    expect((tn.fields() as any).firstChild[pRow]).toBe(c);

    world.destroyEntitySafe(c, true);

    // Child is gone; parent pointers updated (no dangling first/last)
    const pRowAfter = tn.denseIndexOf(p);
    expect((tn.fields() as any).firstChild[pRowAfter]).toBe(NONE);
    expect((tn.fields() as any).lastChild[pRowAfter]).toBe(NONE);
    expect(world.entities.isAlive(c)).toBe(false);
  });

  test("DFS order stays deterministic under mixed mutations", () => {
    const world = initWorld({ initialCapacity: 32 });
    const tTree = new TransformTree(world);

    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();
    const d = world.createEntity();
    const e = world.createEntity();

    // A -> {B, C}; C -> {D, E}
    tTree.addChild(a, b);
    tTree.addChild(a, c);
    tTree.addChild(c, d);
    tTree.addChild(c, e);

    // Baseline
    expect(Array.from(tTree.order)).toEqual([a, b, c, d, e]);

    // Mutate: detach B (root), then append back under C (tail)
    tTree.remove(b);
    expect(Array.from(tTree.order)[0]).toBe(a);
    tTree.addChild(c, b);
    expect(Array.from(tTree.order)).toEqual([a, c, d, e, b]);
  });

  test("entity epochs bump on tree edits; store epoch bumps only on row-level ops", () => {
    const world = initWorld({ initialCapacity: 16 });
    const tTree = new TransformTree(world);

    const p = world.createEntity();
    const ch = world.createEntity();

    // Tree addChild should bump the child's entity epoch
    const entityEpochBefore = world.entityEpoch[ch]!;
    tTree.addChild(p, ch);
    expect(world.entityEpoch[ch]).toBe((entityEpochBefore + 1) >>> 0);

    // Capture epochs before a structural (link) change.
    const tn = world.store("TransformNode");
    const storeEpochBefore = tn.storeEpoch;
    const treeEpochBefore = tTree.epoch;

    // Structural change via tree op (rewire pointers only)
    tTree.remove(ch);

    // Tree epoch bumps, store epoch does NOT (no row add/remove/update invoked)
    expect(tTree.epoch).toBeGreaterThan(treeEpochBefore);
    expect(tn.storeEpoch).toBe(storeEpochBefore);

    // Now perform a true row-level op to prove storeEpoch does bump.
    const storeEpochBeforeRemove = tn.storeEpoch;
    tn.remove(ch); // remove the row from the store
    expect(tn.storeEpoch).toBeGreaterThan(storeEpochBeforeRemove);
  });
});

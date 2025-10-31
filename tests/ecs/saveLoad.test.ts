// tests/ecs/saveload.test.ts
import { initWorld, TransformMeta } from "../../src/ecs/registry";
import { saveScene } from "../../src/ecs/save";
import { loadScene } from "../../src/ecs/load";
import { buildAllHierarchyTrees } from "../../src/ecs/trees";

const NONE = -1;

describe("Scene Save/Load v1 — meta-driven, robust, and deterministic", () => {
  test("round-trip (full columns): topology, transforms, and roots are preserved", () => {
    const world = initWorld({ initialCapacity: 64 });

    // Build a small transform+render hierarchy:
    // A -> {B, C}; C -> D
    const A = world.createEntity();
    const B = world.createEntity();
    const C = world.createEntity();
    const D = world.createEntity();

    const trees = buildAllHierarchyTrees(world);
    const tTree = trees.get("TransformNode")!;
    const rTree = trees.get("RenderNode")!;
    tTree.addChild(A, B);
    tTree.addChild(A, C);
    tTree.addChild(C, D);
    rTree.addChild(A, B);
    rTree.addChild(A, C);
    rTree.addChild(C, D);

    // Give some non-default world transforms to ensure numeric fidelity.
    const T = world.storeOf(TransformMeta);
    const tf = T.fields();
    const aRow = T.add(A);
    const cRow = T.add(C);
    const dRow = T.add(D);

    tf.world_r00[aRow] = 1.25;
    tf.world_r11[aRow] = 0.75;
    tf.world_tx[aRow] = 10;
    tf.world_r22[aRow] = 2.0;
    tf.world_ty[aRow] = -3;
    tf.world_tz[aRow] = 5;

    tf.world_r00[cRow] = 0.5;
    tf.world_r11[cRow] = 2.0;
    tf.world_tx[cRow] = -7;
    tf.world_r22[cRow] = 1.0;
    tf.world_ty[cRow] = 9;
    tf.world_tz[cRow] = 0.25;

    tf.world_r00[dRow] = 3.0;
    tf.world_r11[dRow] = 3.0;
    tf.world_tx[dRow] = 2;

    // Save with full columns & includeRoots
    const saved = saveScene(world, {
      dropDefaultColumns: false,
      includeRoots: true,
    });

    // Load into a new world
    const world2 = initWorld({ initialCapacity: 8 });
    const { trees: loadedTrees } = loadScene(world2, saved);

    // Verify entity count
    expect(world2.entities.size).toBe(saved.entityCount);

    // Verify transform node structure via pointers
    const tn2 = world2.store("TransformNode");
    const tn2Cols = tn2.fields() as any;

    const a2 = 0,
      b2 = 1,
      c2 = 2,
      d2 = 3; // loadScene constructs entities [0..N-1] dense
    const a2Row = tn2.denseIndexOf(a2);
    const b2Row = tn2.denseIndexOf(b2);
    const c2Row = tn2.denseIndexOf(c2);
    const d2Row = tn2.denseIndexOf(d2);

    expect(tn2Cols.parent[a2Row]).toBe(NONE);
    expect(tn2Cols.parent[b2Row]).toBe(a2);
    expect(tn2Cols.parent[c2Row]).toBe(a2);
    expect(tn2Cols.parent[d2Row]).toBe(c2);

    // Verify roots (legacy shape saved)
    expect(saved.roots?.transform).toEqual([0]); // only A was a root in transform tree
    expect(saved.roots?.render).toEqual([0]); // only A was a root in render tree

    // Verify DFS order is deterministic
    const tTree2 = loadedTrees.get("TransformNode")!;
    const rTree2 = loadedTrees.get("RenderNode")!;
    expect(Array.from(tTree2.order)).toEqual([a2, b2, c2, d2]);
    expect(Array.from(rTree2.order)).toEqual([a2, b2, c2, d2]);

    // Verify selected world transform values persisted
    const T2 = world2.store("Transform");
    const t2 = T2.fields() as any;
    const a2t = T2.denseIndexOf(a2);
    const c2t = T2.denseIndexOf(c2);
    const d2t = T2.denseIndexOf(d2);

    expect(t2.world_r00[a2t]).toBeCloseTo(1.25);
    expect(t2.world_r11[a2t]).toBeCloseTo(0.75);
    expect(t2.world_tx[a2t]).toBeCloseTo(10);

    expect(t2.world_r00[c2t]).toBeCloseTo(0.5);
    expect(t2.world_tx[c2t]).toBeCloseTo(-7);
    expect(t2.world_ty[c2t]).toBeCloseTo(9);

    expect(t2.world_r00[d2t]).toBeCloseTo(3.0);
    expect(t2.world_tx[d2t]).toBeCloseTo(2);
  });

  test("save with dropDefaultColumns ⇒ loader fills defaults; full-resave matches baseline", () => {
    const world = initWorld({ initialCapacity: 16 });

    const P = world.createEntity();
    const C = world.createEntity();

    const trees = buildAllHierarchyTrees(world);
    trees.get("TransformNode")!.addChild(P, C);

    // Baseline full save (no dropping) for comparison
    const baseline = saveScene(world, {
      dropDefaultColumns: false,
      includeRoots: true,
    });

    // Save with defaults dropped
    const compact = saveScene(world, {
      dropDefaultColumns: true,
      includeRoots: true,
    });

    // Expect the Transform block to potentially omit many columns (identity defaults)
    const tBlockCompact = compact.components.find(
      (c) => c.name === "Transform"
    );
    if (tBlockCompact) {
      expect(Array.isArray(tBlockCompact.fieldOrder)).toBe(true);
      // Ensure at least some fields are present; but many identity columns may be omitted
      expect(tBlockCompact.fieldOrder!.length).toBeGreaterThan(0);
    }

    // Load compact into a fresh world, then save fully
    const world2 = initWorld({ initialCapacity: 16 });
    loadScene(world2, compact);
    const round = saveScene(world2, {
      dropDefaultColumns: false,
      includeRoots: true,
    });

    // Compare baseline vs round-trip on key properties (entityCount, TransformNode parents, roots)
    expect(round.entityCount).toBe(baseline.entityCount);

    const tnBase = baseline.components.find((c) => c.name === "TransformNode")!;
    const tnRound = round.components.find((c) => c.name === "TransformNode")!;
    expect(tnRound.present).toEqual(tnBase.present);

    const baseParentIdx = tnBase.fieldOrder!.indexOf("parent");
    const roundParentIdx = tnRound.fieldOrder!.indexOf("parent");
    // Extract dense-present arrays
    const baseParents = tnBase.columns![baseParentIdx]!;
    const roundParents = tnRound.columns![roundParentIdx]!;
    expect(roundParents).toEqual(baseParents);

    // Roots preserved
    expect(round.roots?.transform).toEqual(baseline.roots?.transform);
    expect(round.roots?.render).toEqual(baseline.roots?.render);
  });

  test("loader ignores unknown component blocks gracefully", () => {
    const world = initWorld({ initialCapacity: 8 });
    world.createEntity(); // ensure at least 1 entity

    // Minimal valid save (no components)
    const base = saveScene(world, {
      dropDefaultColumns: false,
      includeRoots: true,
    });

    // Inject an unknown component
    const withUnknown = {
      ...base,
      components: [
        ...base.components,
        {
          name: "TotallyUnknownComponent",
          present: new Array(base.entityCount).fill(0),
          fieldOrder: ["bogus"],
          columns: [[]],
        },
      ],
    };

    const world2 = initWorld({ initialCapacity: 8 });
    expect(() => loadScene(world2, withUnknown as any)).not.toThrow();
    expect(world2.entities.size).toBe(base.entityCount);
  });
  test("large scenes (> store capacity) save & load without corruption; arrays grow under the hood", () => {
    const COUNT = 700; // > default per-store initialCapacity 256 to force growth
    const world = initWorld({ initialCapacity: 64 });

    const trees = buildAllHierarchyTrees(world);
    const tTree = trees.get("TransformNode")!;

    // Build a single linked chain using the hierarchy: e0 -> e1 -> e2 -> ... -> e{COUNT-1}
    const ids: number[] = [];
    for (let i = 0; i < COUNT; i++) ids.push(world.createEntity());
    for (let i = 0; i < COUNT - 1; i++) tTree.addChild(ids[i]!, ids[i + 1]!);

    const saved = saveScene(world, {
      dropDefaultColumns: true,
      includeRoots: true,
    });

    // Load into a new world
    const world2 = initWorld({ initialCapacity: 32 });
    const { trees: trees2 } = loadScene(world2, saved);

    const tn2 = world2.store("TransformNode");
    const cols = tn2.fields() as any;

    // Sanity: every entity should have a node row
    for (let e = 0; e < COUNT; e++) {
      expect(tn2.has(e)).toBe(true);
    }

    // 1) Find all roots by scanning parent == NONE; we expect exactly one root for a chain.
    const roots: number[] = [];
    for (let e = 0; e < COUNT; e++) {
      const r = tn2.denseIndexOf(e);
      expect(r).toBeGreaterThanOrEqual(0);
      if (cols.parent[r] === -1) roots.push(e);
    }
    expect(roots.length).toBe(1);
    const root = roots[0]!;

    // 2) Walk the chain using firstChild pointers, verifying invariants along the way.
    const visited = new Set<number>();
    const orderByWalk: number[] = [];

    let cur = root;
    for (let step = 0; step < COUNT; step++) {
      if (visited.has(cur)) {
        throw new Error("Cycle detected in chain walk");
      }
      visited.add(cur);
      orderByWalk.push(cur);

      const row = tn2.denseIndexOf(cur);
      const child = cols.firstChild[row] as number;

      if (child === -1) {
        // Tail reached; must be last step
        expect(step).toBe(COUNT - 1);
        break;
      }

      // Chain invariant: single child implies no siblings for that child.
      const childRow = tn2.denseIndexOf(child);
      expect(cols.prevSibling[childRow]).toBe(-1);
      expect(cols.nextSibling[childRow]).toBe(-1);

      // Tail pointer invariant: parent's lastChild equals its only child.
      expect(cols.lastChild[row]).toBe(child);

      // Parent link invariant.
      expect(cols.parent[childRow]).toBe(cur);

      // Advance
      cur = child;
    }

    // 3) We must have visited exactly COUNT distinct nodes.
    expect(visited.size).toBe(COUNT);

    // 4) DFS order of the rebuilt tree should exactly match our single-chain walk.
    const dfs = Array.from(trees2.get("TransformNode")!.order);
    expect(dfs).toEqual(orderByWalk);
  });

  test("present-mask-only component (all columns dropped) still loads with defaults", () => {
    const world = initWorld({ initialCapacity: 8 });

    const A = world.createEntity();
    const B = world.createEntity();
    const trees = buildAllHierarchyTrees(world);
    trees.get("TransformNode")!.addChild(A, B);

    // Save with defaults dropped
    const compact = saveScene(world, {
      dropDefaultColumns: true,
      includeRoots: false,
    });

    // Add a present-mask-only block deliberately (no fieldOrder/columns)
    compact.components.push({
      name: "Operation",
      present: [1, 0], // only entity 0 has Operation
    });

    const world2 = initWorld({ initialCapacity: 8 });
    loadScene(world2, compact);

    const op2 = world2.store("Operation");
    expect(op2.has(0)).toBe(true);
    const cols = op2.fields() as any;
    const row0 = op2.denseIndexOf(0);
    // Default opType is 0
    expect(cols.opType[row0]).toBe(0);
  });

  test("link remapping across non-compact original ids: save → load preserves topology", () => {
    // Build with holes in entity ids:
    const world = initWorld({ initialCapacity: 16 });
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(world.createEntity());
    // Destroy a couple to leave holes (e.g., 1 and 3)
    world.destroyEntity(ids[1]!);
    world.destroyEntity(ids[3]!);

    const trees = buildAllHierarchyTrees(world);
    const tTree = trees.get("TransformNode")!;

    // Use remaining alive ids and form a small tree
    // survivors [0,2,4,5]; make 0 -> 2,4 and 4 -> 5
    tTree.addChild(ids[0]!, ids[2]!);
    tTree.addChild(ids[0]!, ids[4]!);
    tTree.addChild(ids[4]!, ids[5]!);

    const saved = saveScene(world, {
      dropDefaultColumns: false,
      includeRoots: true,
    });

    // Load into a fresh compact-id world
    const world2 = initWorld({ initialCapacity: 8 });
    loadScene(world2, saved);

    const tn2 = world2.store("TransformNode");
    const cols2 = tn2.fields() as any;

    // There were 4 live entities → new ids [0..3]
    expect(world2.entities.size).toBe(4);

    const p = (e: number) => cols2.parent[tn2.denseIndexOf(e)];
    // Expected structure (remapped): 0 -> {1,2}; 2 -> 3
    expect(p(0)).toBe(NONE);
    expect(p(1)).toBe(0);
    expect(p(2)).toBe(0);
    expect(p(3)).toBe(2);
  });

  test("loader accepts roots map as well as legacy {transform, render}", () => {
    const world = initWorld({ initialCapacity: 16 });

    // Create two independent roots by giving both node components.
    const R1 = world.createEntity();
    const R2 = world.createEntity();
    const trees = buildAllHierarchyTrees(world);
    trees.get("TransformNode")!.addChild(R1, world.createEntity());
    const C = world.createEntity();
    trees.get("TransformNode")!.addChild(R2, C);

    // Save legacy roots
    const legacy = saveScene(world, {
      dropDefaultColumns: true,
      includeRoots: true,
    });

    // Convert roots to map form
    const mapped = {
      ...legacy,
      roots: {
        TransformNode: (legacy.roots as any).transform ?? [],
        RenderNode: (legacy.roots as any).render ?? [],
      },
    };

    const world2 = initWorld({ initialCapacity: 16 });
    const { trees: trees2 } = loadScene(world2, mapped as any);
    const tTree2 = trees2.get("TransformNode")!;
    // Should rebuild order successfully with provided hints (no crash and includes all entities)
    expect(tTree2.order.length).toBe(world2.entities.size);
  });

  test("field order permutation in saved JSON loads correctly (keyed by field names)", () => {
    const world = initWorld({ initialCapacity: 8 });
    const A = world.createEntity();
    const B = world.createEntity();
    const trees = buildAllHierarchyTrees(world);
    trees.get("TransformNode")!.addChild(A, B);

    // Ensure Transform rows exist so a Transform block is emitted
    const T = world.store("Transform");
    T.add(A);
    T.add(B);

    const saved = saveScene(world, {
      dropDefaultColumns: false,
      includeRoots: false,
    });

    // Find the Transform block and permute some fields
    const tBlock = saved.components.find((c) => c.name === "Transform")!;
    expect(tBlock).toBeTruthy();
    if (tBlock.fieldOrder && tBlock.columns) {
      if (tBlock.fieldOrder.length >= 2) {
        const fo = tBlock.fieldOrder.slice();
        const co = tBlock.columns.slice();
        [fo[0], fo[1]] = [fo[1]!, fo[0]!];
        [co[0], co[1]] = [co[1]!, co[0]!];
        tBlock.fieldOrder = fo;
        tBlock.columns = co;
      }
    }

    const world2 = initWorld({ initialCapacity: 8 });
    expect(() => loadScene(world2, saved)).not.toThrow();

    // Spot-check identity defaults still hold for at least one entity
    const T2 = world2.store("Transform");
    const rowA = T2.denseIndexOf(0);
    if (rowA >= 0) {
      const c = T2.fields() as any;
      expect(c.local_r00[rowA]).toBeCloseTo(1);
      expect(c.local_r11[rowA]).toBeCloseTo(1);
      expect(c.local_r22[rowA]).toBeCloseTo(1);
    }
  });
});

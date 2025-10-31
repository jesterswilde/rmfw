// tests/ecs/saveLoad.test.ts
import { initWorld, Transform, TransformNode, RenderNode, ShapeLeaf, Operation } from "../../src/ecs/registry";
import { TransformTree, RenderTree } from "../../src/ecs/trees";
import { saveScene } from "../../src/ecs/save";
import { loadScene } from "../../src/ecs/load";

const NONE = -1;

describe("rmfw save/load (dynamic, meta-driven)", () => {
  test("round-trip: world → save → load (values, DFS, roots) without hardcoded component lists", () => {
    // Build a sample world
    const world1 = initWorld({ initialCapacity: 64 });
    const T  = world1.store(Transform.meta.name);
    const TN = world1.store(TransformNode.meta.name);
    const RN = world1.store(RenderNode.meta.name);
    const SH = world1.store(ShapeLeaf.meta.name);
    const OP = world1.store(Operation.meta.name);

    // Entities: 0=A, 1=B, 2=C, 3=D
    const A = world1.createEntity();
    const B = world1.createEntity();
    const C = world1.createEntity();
    const D = world1.createEntity();

    // Transform tree: A -> { B -> { C } }
    T.add(A); TN.add(A, { parent: NONE, firstChild: B, nextSibling: NONE });
    T.add(B); TN.add(B, { parent: A,    firstChild: C, nextSibling: NONE });
    T.add(C); TN.add(C, { parent: B,    firstChild: NONE, nextSibling: NONE });

    // Render tree: D (root only)
    RN.add(D, { parent: NONE, firstChild: NONE, nextSibling: NONE });

    // Transforms (locals)
    T.update(A, { local_tx: 10, local_ty: 2 });
    T.update(B, { local_tx: 3 });
    T.update(C, { local_tx: 5 });

    // Shape/Op
    SH.add(B, { shapeType: 7, p0: 1, p1: 2, p2: 3 });
    OP.add(C, { opType: 2 });

    // Pre-save DFS sanity
    const tTree1 = new TransformTree(world1);
    const rTree1 = new RenderTree(world1);
    tTree1.rebuildOrder();
    rTree1.rebuildOrder();
    expect(Array.from(tTree1.order)).toEqual([A, B, C]);
    expect(Array.from(rTree1.order)).toContain(D);

    // Save (dynamic; should consult store.meta and columns only)
    const scene = saveScene(world1, { includeRoots: true, dropDefaultColumns: true });
    expect(scene.project).toBe("rmfw");
    expect(scene.version).toBe(1);
    expect(scene.entityCount).toBe(4);

    // Load into fresh world using dynamic loader
    const world2 = initWorld({ initialCapacity: 64 });
    const { entityCount } = loadScene(world2, scene);
    expect(entityCount).toBe(4);

    // Trees should reconstruct solely from node component shape
    const tTree2 = new TransformTree(world2);
    const rTree2 = new RenderTree(world2);
    tTree2.rebuildOrder(scene.roots?.transform);
    rTree2.rebuildOrder(scene.roots?.render);

    expect(Array.from(tTree2.order)).toEqual([A, B, C]);
    expect(Array.from(rTree2.order)).toContain(D);

    // Value checks (defaults filled where omitted)
    const T2  = world2.store(Transform.meta.name);
    const TN2 = world2.store(TransformNode.meta.name);
    const RN2 = world2.store(RenderNode.meta.name);
    const SH2 = world2.store(ShapeLeaf.meta.name);
    const OP2 = world2.store(Operation.meta.name);

    const tCols = T2.fields() as any;
    const tnCols = TN2.fields() as any;
    const rnCols = RN2.fields() as any;
    const shCols = SH2.fields() as any;
    const opCols = OP2.fields() as any;

    // Transforms preserved
    expect(tCols.local_tx[T2.denseIndexOf(A)]).toBeCloseTo(10);
    expect(tCols.local_ty[T2.denseIndexOf(A)]).toBeCloseTo(2);
    // Default identity entries present even if column omitted on save
    expect(tCols.local_r00[T2.denseIndexOf(A)]).toBe(1);
    expect(tCols.local_r11[T2.denseIndexOf(A)]).toBe(1);
    expect(tCols.local_r22[T2.denseIndexOf(A)]).toBe(1);

    // TransformNode links
    expect(tnCols.parent[TN2.denseIndexOf(A)]).toBe(NONE);
    expect(tnCols.firstChild[TN2.denseIndexOf(A)]).toBe(B);
    expect(tnCols.parent[TN2.denseIndexOf(B)]).toBe(A);
    expect(tnCols.firstChild[TN2.denseIndexOf(B)]).toBe(C);

    // RenderNode root
    expect(rnCols.parent[RN2.denseIndexOf(D)]).toBe(NONE);

    // Shape/Operation preserved
    expect(SH2.has(B)).toBe(true);
    expect(shCols.shapeType[SH2.denseIndexOf(B)]).toBe(7);
    expect(OP2.has(C)).toBe(true);
    expect(opCols.opType[OP2.denseIndexOf(C)]).toBe(2);
  });

  test("save with all-default Transform columns: saver may drop them; loader must restore defaults", () => {
    const world = initWorld({ initialCapacity: 16 });
    const T  = world.store(Transform.meta.name);
    const TN = world.store(TransformNode.meta.name);

    const e = world.createEntity();
    T.add(e); // identity defaults
    TN.add(e, { parent: NONE, firstChild: NONE, nextSibling: NONE });

    const scene = saveScene(world, { dropDefaultColumns: true, includeRoots: true });
    const tBlock = scene.components.find(c => c.name === Transform.meta.name)!;

    // Transform present mask exists
    expect(tBlock.present.some(v => v === 1)).toBe(true);
    // Saver is allowed to omit all columns for Transform if everything is default
    // (we don't assert either way; loader must reconstruct)
    const world2 = initWorld({ initialCapacity: 16 });
    loadScene(world2, scene);

    const T2 = world2.store(Transform.meta.name);
    const cols = T2.fields() as any;
    const row = T2.denseIndexOf(e);
    expect(cols.local_r00[row]).toBe(1);
    expect(cols.local_r11[row]).toBe(1);
    expect(cols.local_r22[row]).toBe(1);
    expect(cols.local_tx[row]).toBe(0);
  });

  test("loader ignores unknown component blocks gracefully (dynamic lookup by world.store(name))", () => {
    const world = initWorld({ initialCapacity: 8 });

    const scene = {
      version: 1 as const,
      project: "rmfw" as const,
      entityCount: 1,
      components: [
        { name: "NotARealComponent", present: [1], fieldOrder: ["foo"], columns: [[123]] },
      ],
    };

    // Should not throw
    const res = loadScene(world, scene as any);
    expect(res.entityCount).toBe(1);

    // No known components were added
    const TN = world.store(TransformNode.meta.name);
    expect(TN.size).toBe(0);
  });

  test("loader rejects unsupported format (bad project/version)", () => {
    const world = initWorld({ initialCapacity: 8 });

    const badVersion = { version: 2, project: "rmfw", entityCount: 0, components: [] as any[] };
    expect(() => loadScene(world, badVersion as any)).toThrow();

    const badProject = { version: 1, project: "not-rmfw", entityCount: 0, components: [] as any[] };
    expect(() => loadScene(world, badProject as any)).toThrow();
  });

  test("mask length vs entityCount mismatch: loader creates N entities and applies what fits", () => {
    const world = initWorld({ initialCapacity: 8 });

    const scene = {
      version: 1 as const,
      project: "rmfw" as const,
      entityCount: 2, // only 0 and 1 exist after load
      components: [
        {
          name: TransformNode.meta.name,
          present: [1, 0, 1], // extra entry ignored
          fieldOrder: ["parent", "firstChild", "nextSibling"],
          columns: [
            [-1], // only one present row specified; loader should not crash
            [-1],
            [-1],
          ],
        },
      ],
    };

    const result = loadScene(world, scene as any);
    expect(result.entityCount).toBe(2);

    const TN = world.store(TransformNode.meta.name);
    expect(TN.has(0)).toBe(true);
    expect(TN.has(1)).toBe(false); // second entry in mask is 0, third is out-of-range
  });
});

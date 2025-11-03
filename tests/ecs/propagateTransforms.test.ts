// tests/ecs/propagateTransforms.test.ts
import { World } from "../../src/ecs/core/world.js";
import { TransformMeta, TransformNodeMeta, TransfromRoot } from "../../src/ecs/registry.js";
import { TransformTree } from "../../src/ecs/tree/transformTree.js";
import { propagateTransforms, PropagateWorkspace } from "../../src/ecs/systems/propagateTransforms.js";

const NONE = -1;

// Small helpers
function setLocalTx(world: World, e: number, tx: number, ty = 0, tz = 0) {
  const T = world.storeOf(TransformMeta);
  const row = T.denseIndexOf(e);
  if (row < 0) throw new Error("entity missing Transform");
  const tf = T.fields();
  tf.local_r00[row] = 1; tf.local_r01[row] = 0; tf.local_r02[row] = 0; tf.local_tx[row] = tx;
  tf.local_r10[row] = 0; tf.local_r11[row] = 1; tf.local_r12[row] = 0; tf.local_ty[row] = ty;
  tf.local_r20[row] = 0; tf.local_r21[row] = 0; tf.local_r22[row] = 1; tf.local_tz[row] = tz;
  (tf as any).dirty[row] = 1;
}

function addNode(world: World, e: number) {
  // Give the entity both Transform and TransformNode rows
  const T = world.storeOf(TransformMeta);
  const N = world.storeOf(TransformNodeMeta);
  T.add(e); // defaults to identity local/world/inv, dirty=0
  N.add(e, { parent: NONE, firstChild: NONE, lastChild: NONE, nextSibling: NONE, prevSibling: NONE } as any);
}

describe("propagateTransforms system", () => {
  it("updates world & inverse for a simple chain when dirty", () => {
    const world = new World({ initialCapacity: 8 });
    // Build tree (registers Transform + TransformNode, makes a protected single root with identity)
    const tree = new TransformTree(world, TransformNodeMeta, TransfromRoot);
    const root = tree.root;

    // Create child entity under root with a local translation
    const c = world.createEntity();
    addNode(world, c);
    tree.setParent(c, root);

    setLocalTx(world, c, 10, 0, 0);

    // Run
    propagateTransforms(world);

    const T = world.storeOf(TransformMeta);
    const row = T.denseIndexOf(c);
    const tf = T.fields();

    // world should match local (parent is identity)
    expect(tf.world_r00[row]).toBeCloseTo(1);
    expect(tf.world_r11[row]).toBeCloseTo(1);
    expect(tf.world_r22[row]).toBeCloseTo(1);
    expect(tf.world_tx[row]).toBeCloseTo(10);
    expect(tf.world_ty[row]).toBeCloseTo(0);
    expect(tf.world_tz[row]).toBeCloseTo(0);

    // inverse should be translation -10 on x
    expect(tf.inv_r00[row]).toBeCloseTo(1);
    expect(tf.inv_r11[row]).toBeCloseTo(1);
    expect(tf.inv_r22[row]).toBeCloseTo(1);
    expect(tf.inv_tx[row]).toBeCloseTo(-10);
    expect(tf.inv_ty[row]).toBeCloseTo(0);
    expect(tf.inv_tz[row]).toBeCloseTo(0);

    // dirty cleared and row/store epochs incremented
    expect((tf as any).dirty[row]).toBe(0);
    expect(T.rowVersion[row]).toBeGreaterThan(0);
    expect(world.store(TransformMeta.name).storeEpoch).toBeGreaterThan(0);
  });

  it("propagates ancestor dirtiness to descendants", () => {
    const world = new World({ initialCapacity: 8 });
    const tree = new TransformTree(world, TransformNodeMeta, TransfromRoot);
    const root = tree.root;

    const p = world.createEntity();
    const c = world.createEntity();
    addNode(world, p);
    addNode(world, c);
    tree.setParent(p, root);
    tree.setParent(c, p);

    // parent local = translate (3, 0, 0), child local = translate (4, 0, 0)
    setLocalTx(world, p, 3, 0, 0);
    setLocalTx(world, c, 4, 0, 0);
    // Clear child's dirty so only ancestor dirtiness forces recompute
    const T = world.storeOf(TransformMeta);
    (T.fields() as any).dirty[T.denseIndexOf(c)] = 0;

    propagateTransforms(world);

    const rP = T.denseIndexOf(p);
    const rC = T.denseIndexOf(c);
    const tf = T.fields();

    // parent world = (3,0,0)
    expect(tf.world_tx[rP]).toBeCloseTo(3);
    // child world = parent.world + child.local = 3 + 4
    expect(tf.world_tx[rC]).toBeCloseTo(7);

    // both should have been recomputed (parent was dirty, child via ancestor)
    expect((tf as any).dirty[rP]).toBe(0);
    expect((tf as any).dirty[rC]).toBe(0);
  });

  it("handles nodes without Transform (carry-through parent context to children)", () => {
    const world = new World({ initialCapacity: 8 });
    const tree = new TransformTree(world, TransformNodeMeta, TransfromRoot);
    const root = tree.root;

    const mid = world.createEntity(); // will have only TransformNode
    const leaf = world.createEntity();

    // TransformNode membership
    const N = world.storeOf(TransformNodeMeta);
    N.add(mid, { parent: NONE, firstChild: NONE, lastChild: NONE, nextSibling: NONE, prevSibling: NONE } as any);
    N.add(leaf, { parent: NONE, firstChild: NONE, lastChild: NONE, nextSibling: NONE, prevSibling: NONE } as any);

    // Only give Transform to the leaf
    const T = world.storeOf(TransformMeta);
    T.add(leaf);

    // Chain: root -> mid -> leaf
    tree.setParent(mid, root);
    tree.setParent(leaf, mid);

    // leaf local = translate (9, 0, 0); parent(mid) has no Transform
    setLocalTx(world, leaf, 9, 0, 0);

    propagateTransforms(world);

    const rLeaf = T.denseIndexOf(leaf);
    const tf = T.fields();

    // leaf world should equal its local (since effective parent world is identity)
    expect(tf.world_tx[rLeaf]).toBeCloseTo(9);
    // dirty cleared
    expect((tf as any).dirty[rLeaf]).toBe(0);
  });

  it("reuses workspace across frames and grows when needed", () => {
    const world = new World({ initialCapacity: 8 });
    const tree = new TransformTree(world, TransformNodeMeta, TransfromRoot);
    const root = tree.root;

    // Build a skinny deep chain to force workspace growth
    const ws = new PropagateWorkspace();

    let parent = root;
    const depth = 200; // exceeds START_STACK_SIZE
    const ids: number[] = [];
    for (let i = 0; i < depth; i++) {
      const e = world.createEntity();
      addNode(world, e);
      tree.setParent(e, parent);
      ids.push(e);
      parent = e;
    }

    // Mark the last node dirty with a small translation
    const last = ids[ids.length - 1]!;
    setLocalTx(world, last, 1, 0, 0);

    // First run grows workspace
    const beforeLen = ws.nodeStack.length;
    propagateTransforms(world, ws);
    const afterLen = ws.nodeStack.length;
    expect(afterLen).toBeGreaterThanOrEqual(depth);
    expect(afterLen).toBeGreaterThanOrEqual(beforeLen);

    // Second run (no new dirtiness): should not change workspace size
    propagateTransforms(world, ws);
    expect(ws.nodeStack.length).toBe(afterLen);
  });
});

// tests/ecs/reparent.preserveWorld.test.ts
// Reparenting a node preserves its world transform by baking a new local.

import { initWorld, TransformMeta, TransformNodeMeta } from "../../src/ecs/core/registry.js";
import { TransformTree } from "../../src/ecs/trees.js";
import { propagateTransforms } from "../../src/ecs/systems/propagateTransforms.js";

const NONE = -1;

function addNode(world: any, e: number) {
  world.storeOf(TransformNodeMeta).add(e, { parent: NONE, firstChild: NONE, nextSibling: NONE });
}
function addTransformTx(world: any, e: number, tx=0, ty=0, tz=0) {
  world.storeOf(TransformMeta).add(e, {
    local_r00: 1, local_r01: 0, local_r02: 0, local_tx: tx,
    local_r10: 0, local_r11: 1, local_r12: 0, local_ty: ty,
    local_r20: 0, local_r21: 0, local_r22: 1, local_tz: tz,
    dirty: 1,
  });
}

describe("TransformTree.reparent preserves world transform", () => {
  test("child world remains identical after reparent under translated parent", () => {
    const world = initWorld({ initialCapacity: 64 });

    const T = world.storeOf(TransformMeta);
    const N = world.storeOf(TransformNodeMeta);

    // Entities
    const parentA = world.createEntity();
    const parentB = world.createEntity();
    const child   = world.createEntity();

    // Nodes
    addNode(world, parentA);
    addNode(world, parentB);
    addNode(world, child);

    // Transforms
    // parentA: identity
    addTransformTx(world, parentA, 0, 0, 0);
    // parentB: translate +10 on X
    addTransformTx(world, parentB, 10, 0, 0);
    // child: local +1 on X (under parentA initially → world = (1,0,0))
    addTransformTx(world, child, 1, 0, 0);

    // Hook into hierarchy: parentA -> child ; parentB is separate root
    const nf = N.fields();
    const paRow = N.denseIndexOf(parentA)!;
    const chRow = N.denseIndexOf(child)!;
    nf.firstChild[paRow] = child | 0;
    nf.parent[chRow] = parentA | 0;

    // Initial propagate
    propagateTransforms(world);

    // Sanity: child's world == (1,0,0)
    const tf = T.fields();
    const cRow = T.denseIndexOf(child)!;
    expect(tf.world_tx[cRow]).toBeCloseTo(1);
    expect(tf.world_ty[cRow]).toBeCloseTo(0);
    expect(tf.world_tz[cRow]).toBeCloseTo(0);

    // Reparent child under parentB (which is at +10 x)
    const tree = new TransformTree(world);
    tree.reparent(child, parentB);

    // Propagate again so inverse is refreshed and subtree validated
    propagateTransforms(world);

    // Child world should still be (1,0,0)
    const cRow2 = T.denseIndexOf(child)!;
    expect(tf.world_tx[cRow2]).toBeCloseTo(1);
    expect(tf.world_ty[cRow2]).toBeCloseTo(0);
    expect(tf.world_tz[cRow2]).toBeCloseTo(0);

    // And the child's LOCAL should have adjusted to counter parentB (+10),
    // i.e. local_tx ~= -9
    expect(tf.local_tx[cRow2]).toBeCloseTo(-9);
  });
});

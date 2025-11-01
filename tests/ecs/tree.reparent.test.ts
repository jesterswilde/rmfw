// tests/ecs/tree.reparent.test.ts
import { initWorld, TransformMeta, TransformNode } from "../../src/ecs/core/registry.js";
import { TransformTree } from "../../src/ecs/trees.js";
import { propagateTransforms, PropagateWorkspace } from "../../src/ecs/systems/propagateTransforms.js";

const EPS = 1e-5;

function expectVec3Close(a: [number, number, number], b: [number, number, number], eps = EPS) {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(eps);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(eps);
  expect(Math.abs(a[2] - b[2])).toBeLessThan(eps);
}

describe("reparent preserves world (2D intuition)", () => {
  test("bar under foo@(0,2) with bar_local@(1,0) → world@(1,2); then makeRoot(bar) → local' == world", () => {
    const world = initWorld({ initialCapacity: 64 });
    const transforms = world.storeOf(TransformMeta);
    const nodes = world.storeOf(TransformNode.meta);

    const tTree = new TransformTree(world);
    const ws = new PropagateWorkspace();

    // Entities
    const root = world.createEntity();
    const foo  = world.createEntity();
    const bar  = world.createEntity();

    // Add components
    nodes.add(root, { parent: -1, firstChild: -1, nextSibling: -1 });
    nodes.add(foo,  { parent: -1, firstChild: -1, nextSibling: -1 });
    nodes.add(bar,  { parent: -1, firstChild: -1, nextSibling: -1 });

    // Transforms: identity locals
    transforms.add(root);
    transforms.add(foo);
    transforms.add(bar);

    // Set foo local = translate(0,2,0)
    const fRow = transforms.denseIndexOf(foo);
    const tf = transforms.fields();
    tf.local_ty[fRow] = 2;
    tf.dirty[fRow] = 1;

    // Set bar local = translate(1,0,0)
    const bRow = transforms.denseIndexOf(bar);
    tf.local_tx[bRow] = 1;
    tf.dirty[bRow] = 1;

    // Build hierarchy: root -> foo -> bar
    tTree.addChild(root, foo);
    tTree.addChild(foo, bar);

    // Propagate
    propagateTransforms(world, ws);

    // Assert initial world(bar) == (1,2,0)
    const wx = tf.world_tx[bRow]!;
    const wy = tf.world_ty[bRow]!;
    const wz = tf.world_tz[bRow]!;
    expectVec3Close([wx, wy, wz], [1, 2, 0]);

    // Now make bar a root (preserve world): local' = world
    tTree.makeRoot(bar);

    // Recompute
    propagateTransforms(world, ws);

    // local(bar) should equal world(bar) (still 1,2,0)
    expectVec3Close(
      [tf.local_tx[bRow]!, tf.local_ty[bRow]!, tf.local_tz[bRow]!],
      [tf.world_tx[bRow]!, tf.world_ty[bRow]!, tf.world_tz[bRow]!]
    );
    expectVec3Close(
      [tf.local_tx[bRow]!, tf.local_ty[bRow]!, tf.local_tz[bRow]!],
      [1, 2, 0]
    );
  });

  test("reparent to baz@(4,4) → bar local becomes world - baz.world == (-3,-2,0)", () => {
    const world = initWorld({ initialCapacity: 64 });
    const transforms = world.storeOf(TransformMeta);
    const nodes = world.storeOf(TransformNode.meta);

    const tTree = new TransformTree(world);
    const ws = new PropagateWorkspace();

    // Entities
    const root = world.createEntity();
    const foo  = world.createEntity();
    const bar  = world.createEntity();
    const baz  = world.createEntity();

    // Node comps
    nodes.add(root, { parent: -1, firstChild: -1, nextSibling: -1 });
    nodes.add(foo,  { parent: -1, firstChild: -1, nextSibling: -1 });
    nodes.add(bar,  { parent: -1, firstChild: -1, nextSibling: -1 });
    nodes.add(baz,  { parent: -1, firstChild: -1, nextSibling: -1 });

    // Transform comps (identity locals)
    transforms.add(root);
    transforms.add(foo);
    transforms.add(bar);
    transforms.add(baz);

    const tf = transforms.fields();
    const fRow = transforms.denseIndexOf(foo);
    const bRow = transforms.denseIndexOf(bar);
    const zRow = transforms.denseIndexOf(baz);

    // foo local = (0,2,0)
    tf.local_ty[fRow] = 2; tf.dirty[fRow] = 1;
    // bar local = (1,0,0)
    tf.local_tx[bRow] = 1; tf.dirty[bRow] = 1;
    // baz local = (4,4,0)
    tf.local_tx[zRow] = 4; tf.local_ty[zRow] = 4; tf.dirty[zRow] = 1;

    // Hierarchy: root -> foo -> bar, and root -> baz
    tTree.addChild(root, foo);
    tTree.addChild(foo, bar);
    tTree.addChild(root, baz);

    // Propagate
    propagateTransforms(world, ws);

    // world(bar) should be (1,2,0)
    expectVec3Close([tf.world_tx[bRow]!, tf.world_ty[bRow]!, tf.world_tz[bRow]!], [1,2,0]);
    // world(baz) should be (4,4,0)
    expectVec3Close([tf.world_tx[zRow]!, tf.world_ty[zRow]!, tf.world_tz[zRow]!], [4,4,0]);

    // Reparent bar under baz (preserve world)
    tTree.reparent(bar, baz);

    // Recompute
    propagateTransforms(world, ws);

    // local(bar) should now be world(bar) - world(baz) = (-3,-2,0)
    expectVec3Close([tf.local_tx[bRow]!, tf.local_ty[bRow]!, tf.local_tz[bRow]!], [-3, -2, 0]);

    // And world(bar) unchanged
    expectVec3Close([tf.world_tx[bRow]!, tf.world_ty[bRow]!, tf.world_tz[bRow]!], [1, 2, 0]);
  });
});

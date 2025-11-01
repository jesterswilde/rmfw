// src/ecs/tests/propagateTransforms.test.ts
// Jest tests for implicit dirty cascade and world/inverse correctness.

import { initWorld, TransformMeta, TransformNodeMeta } from "../../src/ecs/core/registry.js";
import { World } from "../../src/ecs/core/index.js";
import { propagateTransforms } from "../../src/ecs/systems/propagateTransforms.js";

const NONE = -1;

function addTransform(world: World, entity: number, tx=0, ty=0, tz=0) {
  const T = world.storeOf(TransformMeta);
  T.add(entity, {
    local_r00: 1, local_r01: 0, local_r02: 0, local_tx: tx,
    local_r10: 0, local_r11: 1, local_r12: 0, local_ty: ty,
    local_r20: 0, local_r21: 0, local_r22: 1, local_tz: tz,
    dirty: 1,
  });
}

function link(world: World, parent: number, child: number) {
  const N = world.storeOf(TransformNodeMeta);
  const nRowP = N.denseIndexOf(parent);
  const nRowC = N.denseIndexOf(child);
  // Add node rows if missing
  if (nRowP < 0) N.add(parent, { parent: NONE, firstChild: NONE, nextSibling: NONE });
  if (nRowC < 0) N.add(child,  { parent: NONE, firstChild: NONE, nextSibling: NONE });

  const pRow = N.denseIndexOf(parent);
  const cRow = N.denseIndexOf(child);
  const nf = N.fields();

  // prepend at head for test simplicity
  const curHead = nf.firstChild[pRow]!;
  nf.firstChild[pRow] = child;
  nf.parent[cRow] = parent;
  nf.nextSibling[cRow] = curHead;
}

describe("propagateTransforms", () => {
  test("dirty cascades to descendants; world/ inverse computed", () => {
    const world = initWorld({ initialCapacity: 32 });
    const T = world.storeOf(TransformMeta);
    const N = world.storeOf(TransformNodeMeta);

    const root = world.createEntity();
    const childA = world.createEntity();
    const childB = world.createEntity();

    // Nodes
    N.add(root,  { parent: NONE, firstChild: NONE, nextSibling: NONE });
    N.add(childA,{ parent: NONE, firstChild: NONE, nextSibling: NONE });
    N.add(childB,{ parent: NONE, firstChild: NONE, nextSibling: NONE });

    link(world, root, childA);
    link(world, childA, childB);

    // Transforms: root translates by +1 on X; childA by +2 on Y; childB identity
    addTransform(world, root, 1, 0, 0);
    addTransform(world, childA, 0, 2, 0);
    addTransform(world, childB, 0, 0, 0);

    // Only mark root dirty explicitly; cascade should update all
    const Tf = T.fields();
    const rowRoot = T.denseIndexOf(root);
    const rowA = T.denseIndexOf(childA);
    const rowB = T.denseIndexOf(childB);
    Tf.dirty[rowA] = 0;
    Tf.dirty[rowB] = 0;
    Tf.dirty[rowRoot] = 1;

    propagateTransforms(world);

    // Expected worlds:
    // root world.t = (1,0,0)
    // childA world.t = parent + local = (1,2,0)
    // childB world.t = (1,2,0) + (0,0,0) = (1,2,0)
    expect(Tf.world_tx[rowRoot!]).toBeCloseTo(1);
    expect(Tf.world_ty[rowRoot!]).toBeCloseTo(0);
    expect(Tf.world_tz[rowRoot!]).toBeCloseTo(0);

    expect(Tf.world_tx[rowA!]).toBeCloseTo(1);
    expect(Tf.world_ty[rowA!]).toBeCloseTo(2);
    expect(Tf.world_tz[rowA!]).toBeCloseTo(0);

    expect(Tf.world_tx[rowB!]).toBeCloseTo(1);
    expect(Tf.world_ty[rowB!]).toBeCloseTo(2);
    expect(Tf.world_tz[rowB!]).toBeCloseTo(0);

    // Inverse sanity: inverse translation should be negative of world (rigid identity rotation)
    expect(Tf.inv_tx[rowB!]).toBeCloseTo(-1);
    expect(Tf.inv_ty[rowB!]).toBeCloseTo(-2);
    expect(Tf.inv_tz[rowB!]).toBeCloseTo(0);

    // Dirty cleared
    expect(Tf.dirty[rowRoot!]).toBe(0);
    expect(Tf.dirty[rowA!]).toBe(0);
    expect(Tf.dirty[rowB!]).toBe(0);
  });
});

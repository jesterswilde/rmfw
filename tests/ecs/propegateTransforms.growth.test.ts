// tests/ecs/propagateTransforms.growth.test.ts
// Ensures propagateTransforms handles depth > 64 by growing its preallocated stacks
// and still computes correct world transforms for all descendants.

import { initWorld, TransformMeta, TransformNodeMeta } from "../../src/ecs/registry.js";
import { World } from "../../src/ecs/core.js";
import { propagateTransforms, PropagateWorkspace } from "../../src/ecs/systems/propagateTransforms.js";

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

function addNode(world: World, entity: number) {
  const N = world.storeOf(TransformNodeMeta);
  N.add(entity, { parent: NONE, firstChild: NONE, nextSibling: NONE });
}

describe("propagateTransforms stack growth", () => {
  test("handles very deep trees by regrowing internal stacks (depth > 64)", () => {
    const world = initWorld({ initialCapacity: 512 });
    const T = world.storeOf(TransformMeta);
    const N = world.storeOf(TransformNodeMeta);

    // Build a single chain root -> n1 -> n2 -> ... -> n(depth-1)
    const DEPTH = 130; // > 64 to force growth (64 -> 128 -> should regrow again past boundary)
    const entities: number[] = new Array(DEPTH);

    for (let i = 0; i < DEPTH; i++) {
      const e = world.createEntity();
      entities[i] = e;
      addNode(world, e);
      // Each node translates +1 on Z in local space
      addTransform(world, e, 0, 0, 1);
    }

    // Link into a deep chain: entities[i] is parent of entities[i+1]
    const nf = N.fields();
    for (let i = 0; i < DEPTH - 1; i++) {
      const p = entities[i]!;
      const c = entities[i + 1]!;
      const pRow = N.denseIndexOf(p)!;
      const cRow = N.denseIndexOf(c)!;
      nf.firstChild[pRow] = c;
      nf.parent[cRow] = p;
      nf.nextSibling[cRow] = NONE;
    }
    // Mark only the root as explicitly dirty; cascade should update all
    const rootRow = T.denseIndexOf(entities[0]!)!;
    T.fields().dirty[rootRow] = 1;

    // Use a workspace so we can verify it regrew
    const ws = new PropagateWorkspace();
    const initialLen = ws.nodeStack.length;

    // Execute
    propagateTransforms(world, ws);

    // Workspace must grow beyond its initial capacity
    expect(ws.nodeStack.length).toBeGreaterThan(initialLen);
    expect(ws.nodeStack.length).toBeGreaterThanOrEqual(DEPTH + 1);

    // Verify deepest node world translation on Z == DEPTH
    const tf = T.fields();
    const lastRow = T.denseIndexOf(entities[DEPTH - 1]!)!;
    expect(tf.world_tz[lastRow]).toBeCloseTo(DEPTH);

    // All nodes should have dirty cleared after propagation
    for (let i = 0; i < DEPTH; i++) {
      const row = T.denseIndexOf(entities[i]!)!;
      expect(tf.dirty[row]).toBe(0);
    }
  });
});

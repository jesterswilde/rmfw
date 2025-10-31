// tests/ecs/gpu/bridge.bufferResize.test.ts
// Buffer resize when DFS length grows/shrinks → recreates buffer + full rewrite once, no duplicate uploads.

import { initWorld, TransformMeta, TransformNode } from "../../../src/ecs/registry.js";
import { TransformTree } from "../../../src/ecs/trees.js";
import { propagateTransforms, PropagateWorkspace } from "../../../src/ecs/systems/propagateTransforms.js";
import { GpuBridge } from "../../../src/ecs/gpu/index.js";
import { TransformsChannel } from "../../../src/ecs/gpu/channels.js";
import { installWebGPUShims, MockQueue, makeMockDevice } from "../../utils/webgpu.mock.js";

installWebGPUShims();

test("buffer resizes on DFS growth/shrink; one full rewrite per resize only", () => {
  const world = initWorld({ initialCapacity: 32 });
  const tStore = world.storeOf(TransformMeta);
  const nStore = world.storeOf(TransformNode.meta);

  // root->a
  const root = world.createEntity();
  const a = world.createEntity();
  nStore.add(root, { parent: -1, firstChild: -1, nextSibling: -1 });
  nStore.add(a,    { parent: -1, firstChild: -1, nextSibling: -1 });
  tStore.add(root); tStore.add(a);

  const tree = new TransformTree(world);
  tree.addChild(root, a);
  tree.rebuildOrder();

  const ws = new PropagateWorkspace();
  propagateTransforms(world, ws);

  const queue = new MockQueue();
  const device = makeMockDevice(queue);

  const bridge = new GpuBridge();
  const chan = new TransformsChannel();
  bridge.register({
    group: 2, binding: 2, channel: chan,
    argsProvider: (w) => ({ order: tree.order, orderEpoch: tree.epoch, store: w.storeOf(TransformMeta) }),
  });

  // Initial sync (full write)
  bridge.syncAll(world, device, queue);
  expect(queue.writes.length).toBe(1);
  queue.reset();

  // Grow: add b as child of a -> DFS longer
  const b = world.createEntity();
  nStore.add(b, { parent: -1, firstChild: -1, nextSibling: -1 });
  tStore.add(b);
  tree.addChild(a, b); // bumps epoch
  propagateTransforms(world, ws);

  // Resize triggers one full write
  bridge.syncAll(world, device, queue);
  expect(queue.writes.length).toBe(1);
  queue.reset();

  // Shrink: remove b from hierarchy & destroy entity -> DFS shorter
  tree.remove(b);
  world.destroyEntitySafe(b);
  tree.rebuildOrder();
  propagateTransforms(world, ws);

  // Resize triggers one full write
  bridge.syncAll(world, device, queue);
  expect(queue.writes.length).toBe(1);
});

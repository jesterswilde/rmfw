// tests/ecs/gpu/bridge.orderEpochFullWrite.test.ts
// Order epoch flip without size change → exactly one full-range write.

import { initWorld, TransformMeta, TransformNode } from "../../../src/ecs/core/registry.js";
import { TransformTree } from "../../../src/ecs/trees.js";
import { propagateTransforms, PropagateWorkspace } from "../../../src/ecs/systems/propagateTransforms.js";
import { GpuBridge, TransformsChannel } from "../../../src/ecs/gpu/index.js";
import { installWebGPUShims, MockQueue, makeMockDevice } from "../../utils/webgpu.mock.js";

installWebGPUShims();

test("order epoch change (same length) -> one full-range write", () => {
  const world = initWorld({ initialCapacity: 16 });
  const tStore = world.storeOf(TransformMeta);
  const nStore = world.storeOf(TransformNode.meta);

  const root = world.createEntity();
  const a = world.createEntity();
  const b = world.createEntity();

  for (const e of [root, a, b]) {
    nStore.add(e, { parent: -1, firstChild: -1, nextSibling: -1 });
    tStore.add(e);
  }

  const tree = new TransformTree(world);
  tree.addChild(root, a);
  tree.addChild(root, b);
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

  bridge.syncAll(world, device, queue); // initial full write
  queue.reset();

  // Reparent to flip order but keep same cardinality
  tree.reparent(b, a); // epoch++
  propagateTransforms(world, ws);

  bridge.syncAll(world, device, queue);

  // Fast-path in flush() should produce exactly one full write (0..count-1)
  expect(queue.writes.length).toBe(1);
});

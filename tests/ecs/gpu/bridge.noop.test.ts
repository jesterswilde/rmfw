// tests/ecs/gpu/bridge.noop.test.ts
// No-op frame where storeEpoch doesn’t change → zero writes.

import { initWorld, TransformMeta, TransformNode } from "../../../src/ecs/registry.js";
import { TransformTree } from "../../../src/ecs/trees.js";
import { propagateTransforms, PropagateWorkspace } from "../../../src/ecs/systems/propagateTransforms.js";
import { GpuBridge, TransformsChannel } from "../../../src/ecs/gpu/index.js";
import { installWebGPUShims, MockQueue, makeMockDevice } from "../../utils/webgpu.mock.js";

installWebGPUShims();

test("no-op frame (storeEpoch stable) -> zero writes", () => {
  const world = initWorld({ initialCapacity: 16 });
  const tStore = world.storeOf(TransformMeta);
  const nStore = world.storeOf(TransformNode.meta);

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

  // Initial full write
  bridge.syncAll(world, device, queue);
  queue.reset();

  // No changes: storeEpoch stable
  bridge.syncAll(world, device, queue);

  expect(queue.writes.length).toBe(0);
});

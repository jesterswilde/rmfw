// tests/ecs/gpu/bridge.deletions.test.ts
// Ensure rowVersion snapshot safety across deletions (no crashes; proper uploads).

import { initWorld, TransformMeta, TransformNode } from "../../../src/ecs/registry.js";
import { TransformTree } from "../../../src/ecs/trees.js";
import { propagateTransforms, PropagateWorkspace } from "../../../src/ecs/systems/propagateTransforms.js";
import { GpuBridge } from "../../../src/ecs/gpu/index.js";
import { TransformsChannel } from "../../../src/ecs/gpu/channels.js";
import { installWebGPUShims, MockQueue, makeMockDevice } from "../../utils/webgpu.mock.js";

installWebGPUShims();

test("entity deletions handled: incremental writes still correct", () => {
  const world = initWorld({ initialCapacity: 32 });
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
  tree.addChild(a, b);
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

  // Initial
  bridge.syncAll(world, device, queue);
  queue.reset();

  // Delete 'a' subtree root -> 'b' becomes root only if reparented; here we just remove & destroy 'a'.
  world.destroyEntitySafe(a);
  tree.rebuildOrder(); // DFS now excludes 'a'
  propagateTransforms(world, ws);

  // Should full-write once (order epoch change)
  bridge.syncAll(world, device, queue);
  expect(queue.writes.length).toBe(1);
});

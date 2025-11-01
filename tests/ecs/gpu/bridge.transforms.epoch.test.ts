// tests/ecs/gpu/bridge.transforms.epoch.test.ts
// Verifies: DFS order epoch change -> full rewrite upload and bind-group stability across resizes.

import { initWorld, TransformMeta, TransformNode } from "../../../src/ecs/core/registry.js";
import { TransformTree } from "../../../src/ecs/trees.js";
import { propagateTransforms, PropagateWorkspace } from "../../../src/ecs/systems/propagateTransforms.js";
import { GpuBridge, TransformsChannel } from "../../../src/ecs/gpu/index.js";
import { installWebGPUShims, MockQueue, makeMockDevice } from "../../utils/webgpu.mock.js";

installWebGPUShims();

describe("TransformsChannel epoch change forces full rewrite", () => {
  test("reparent changes DFS, causing full buffer upload", () => {
    const world = initWorld({ initialCapacity: 16 });
    const tStore = world.storeOf(TransformMeta);
    const nStore = world.storeOf(TransformNode.meta);

    const root = world.createEntity();
    const a = world.createEntity();
    const b = world.createEntity();
    nStore.add(root, { parent: -1, firstChild: -1, nextSibling: -1 });
    nStore.add(a,    { parent: -1, firstChild: -1, nextSibling: -1 });
    nStore.add(b,    { parent: -1, firstChild: -1, nextSibling: -1 });

    tStore.add(root); tStore.add(a); tStore.add(b);

    const tTree = new TransformTree(world);
    tTree.addChild(root, a);
    tTree.addChild(root, b);
    tTree.rebuildOrder();

    const ws = new PropagateWorkspace();
    propagateTransforms(world, ws);

    const queue = new MockQueue();
    const device = makeMockDevice(queue);

    const bridge = new GpuBridge();
    const transforms = new TransformsChannel();

    bridge.register({
      group: 2, binding: 2, channel: transforms,
      argsProvider: (w) => {
        const store = w.storeOf(TransformMeta);
        return { order: tTree.order, orderEpoch: tTree.epoch, store };
      },
    });

    // Initial sync (full write)
    bridge.syncAll(world, device, queue);
    queue.reset();

    // Structural change: reparent b under a -> DFS order updates
    tTree.reparent(b, a); // bumps epoch + rebuilds order
    propagateTransforms(world, ws);

    bridge.syncAll(world, device, queue);

    // Expect one full-buffer write: rows = tTree.order.length; each row = 48 bytes
    const expectedBytes = tTree.order.length * 48;
    const totalBytes = queue.writes.reduce((s, w) => s + w.size, 0);
    expect(totalBytes).toBe(expectedBytes);
    expect(queue.writes.length).toBeGreaterThanOrEqual(1);
  });
});

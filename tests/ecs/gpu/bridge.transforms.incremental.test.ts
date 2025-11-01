// tests/ecs/gpu/bridge.transforms.incremental.test.ts

import { initWorld, TransformMeta, TransformNode } from "../../../src/ecs/core/registry.js";
import { TransformTree } from "../../../src/ecs/trees.js";
import { propagateTransforms, PropagateWorkspace } from "../../../src/ecs/systems/propagateTransforms.js";
import { GpuBridge, TransformsChannel } from "../../../src/ecs/gpu/index.js";
import { installWebGPUShims, MockQueue, makeMockDevice } from "../../utils/webgpu.mock.js";

installWebGPUShims();

describe("TransformsChannel incremental dirty uploads (merged runs)", () => {
  test("two adjacent edits -> one merged write (descendants included)", () => {
    const world = initWorld({ initialCapacity: 32 });
    const tStore = world.storeOf(TransformMeta);
    const nStore = world.storeOf(TransformNode.meta);

    // Build a simple chain root->a->b->c->d (5 rows)
    const root = world.createEntity();
    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();
    const d = world.createEntity();

    nStore.add(root, { parent: -1, firstChild: -1, nextSibling: -1 });
    nStore.add(a,    { parent: -1, firstChild: -1, nextSibling: -1 });
    nStore.add(b,    { parent: -1, firstChild: -1, nextSibling: -1 });
    nStore.add(c,    { parent: -1, firstChild: -1, nextSibling: -1 });
    nStore.add(d,    { parent: -1, firstChild: -1, nextSibling: -1 });

    tStore.add(root);
    tStore.add(a);
    tStore.add(b);
    tStore.add(c);
    tStore.add(d);

    const tTree = new TransformTree(world);
    tTree.addChild(root, a);
    tTree.addChild(a, b);
    tTree.addChild(b, c);
    tTree.addChild(c, d);
    tTree.rebuildOrder();

    const ws = new PropagateWorkspace();
    propagateTransforms(world, ws);

    // Minimal WebGPU stubs
    const queue = new MockQueue();
    const device = makeMockDevice(queue);

    const bridge = new GpuBridge();
    const transforms = new TransformsChannel();

    // Register transforms at @group(2) binding(2)
    bridge.register({
      group: 2, binding: 2, channel: transforms,
      argsProvider: (w) => {
        const store = w.storeOf(TransformMeta);
        return { order: tTree.order, orderEpoch: tTree.epoch, store };
      },
    });

    // First sync: full upload (buffer creation)
    bridge.syncAll(world, device, queue);
    queue.reset();

    // Two adjacent edits: mark dirty for 'b' and 'c'
    const tf = tStore.fields();
    const bRow = tStore.denseIndexOf(b);
    const cRow = tStore.denseIndexOf(c);
    tf.local_tx[bRow] = 1; tf.dirty[bRow] = 1;
    tf.local_ty[cRow] = 2; tf.dirty[cRow] = 1;

    propagateTransforms(world, ws);

    bridge.syncAll(world, device, queue);

    // Because dirtiness cascades to descendants, affected rows are [b, c, d] = 3 rows.
    expect(queue.writes.length).toBe(1);
    expect(queue.writes[0]!.size).toBe(3 * 48);
  });
});

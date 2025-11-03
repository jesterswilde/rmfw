// tests/ecs/gpu/bridge.test.ts
import { GpuBridge } from "../../../src/ecs/gpu/bridge.js";
import { TransformsChannel } from "../../../src/ecs/gpu/transformsChannel.js";
import { RenderChannel } from "../../../src/ecs/gpu/renderChannel.js";
import { World } from "../../../src/ecs/core/world.js";
import { TransformMeta, TransformNodeMeta, ShapeMeta, OperationMeta, RenderNodeMeta } from "../../../src/ecs/registry.js";
import { MockQueue, makeMockDevice, installWebGPUShims } from "../../utils/webgpu.mock.js";

installWebGPUShims();

describe("GpuBridge", () => {
  it("registers channels, builds layout/bind entries, and syncs with writes", () => {
    const world = new World({ initialCapacity: 8 });

    // Minimal stores for channels
    const T = world.register({ meta: TransformMeta }, 4);
    world.register({ meta: TransformNodeMeta }, 4);

    const e = world.createEntity();
    T.add(e); // one transform row

    const tChan = new TransformsChannel();
    const rChan = new RenderChannel();

    const bridge = new GpuBridge();

    // Register transforms channel at group 0, binding 0
    bridge.register({
      group: 0,
      binding: 0,
      channel: tChan,
      argsProvider: (w: World) => ({
        order: Int32Array.from([e]),
        orderEpoch: 1,
        store: w.storeOf(TransformMeta),
      }),
    });

    // Register render channel at group 0, binding 1 (needs render/shape/op stores even if mostly empty)
    const Shape = world.register({ meta: ShapeMeta }, 1);
    const Op = world.register({ meta: OperationMeta }, 1);
    const Render = world.register({ meta: RenderNodeMeta }, 1);

    bridge.register({
      group: 0,
      binding: 1,
      channel: rChan,
      argsProvider: (w: World) => ({
        order: Int32Array.from([]),
        orderEpoch: 1,
        shapeStore: w.storeOf(ShapeMeta),
        opStore: w.storeOf(OperationMeta),
        renderStore: w.storeOf(RenderNodeMeta),
        transformStore: w.storeOf(TransformMeta),
        transformOrder: Int32Array.from([e]),
        transformOrderEpoch: 1,
      }),
    });

    // Layout entries in binding order
    const layout = bridge.layoutEntriesFor(0);
    expect(layout.length).toBe(2);
    expect(layout[0]!.binding).toBe(0);
    expect(layout[1]!.binding).toBe(1);

    // Before first sync, bindGroupEntriesFor should throw (no buffer yet)
    expect(() => bridge.bindGroupEntriesFor(0)).toThrow();

    // Perform syncAll with mock device/queue
    const queue = new MockQueue();
    const device = makeMockDevice(queue);
    bridge.syncAll(world, device, queue);

    // Now bind entries should exist
    const bind = bridge.bindGroupEntriesFor(0);
    expect(bind.length).toBe(2);
    expect(bind[0]!.binding).toBe(0);
    expect(bind[1]!.binding).toBe(1);

    // At least one write should have happened (TransformsChannel wrote one row)
    expect(queue.writes.length).toBeGreaterThanOrEqual(1);

    // Second call with no changes should early-out (no further writes)
    queue.reset();
    bridge.syncAll(world, device, queue);
    expect(queue.writes.length).toBe(0);
  });

  it("prevents duplicate registration, supports unregister and destroy", () => {
    const world = new World();
    const bridge = new GpuBridge();
    const chan = new TransformsChannel();

    bridge.register({
      group: 1,
      binding: 3,
      channel: chan,
      argsProvider: (_w: World) => ({ order: new Int32Array(0), orderEpoch: 0, store: _w.storeOf(TransformMeta) }),
    });

    expect(() =>
      bridge.register({
        group: 1,
        binding: 3,
        channel: chan,
        argsProvider: (_w: World) => ({ order: new Int32Array(0), orderEpoch: 0, store: _w.storeOf(TransformMeta) }),
      })
    ).toThrow();

    // Unregister should remove the mapping
    bridge.unregister({ group: 1, binding: 3 });
    // After unregister, bindGroup entries for group 1 should be empty
    expect(bridge.bindGroupEntriesFor(1)).toEqual([]);

    // Destroy is idempotent and clears all
    bridge.destroy();
    expect(bridge.layoutEntriesFor(1)).toEqual([]);
  });

  it("recreates buffers on grow and forces a full write", () => {
    const world = new World({ initialCapacity: 1 });
    const T = world.register({ meta: TransformMeta }, 1);
    const e0 = world.createEntity();
    T.add(e0);

    const chan = new TransformsChannel();
    const bridge = new GpuBridge();
    bridge.register({
      group: 0,
      binding: 0,
      channel: chan,
      argsProvider: (w: World) => ({
        order: Int32Array.from(w.entities.dense), // all live entities with transform
        orderEpoch: 1,
        store: w.storeOf(TransformMeta),
      }),
    });

    const queue = new MockQueue();
    const device = makeMockDevice(queue);

    // First sync – creates buffer, full write of 1 row
    bridge.syncAll(world, device, queue);
    expect(queue.writes.length).toBe(1);
    const first = queue.writes[0]!;
    expect(first.size).toBe(12 * 4); // 1 row

    // Grow: add another entity with transform
    const e1 = world.createEntity();
    T.add(e1);
    // Simulate a different orderEpoch so channel repacks to 2 rows
    queue.reset();
    bridge.unregister({ group: 0, binding: 0 }, /*destroyBuffer*/ true); // ensure recreate path
    bridge.register({
      group: 0,
      binding: 0,
      channel: chan,
      argsProvider: (w: World) => ({
        order: Int32Array.from([e0, e1]),
        orderEpoch: 2,
        store: w.storeOf(TransformMeta),
      }),
    });

    bridge.syncAll(world, device, queue);
    expect(queue.writes.length).toBe(1);
    const second = queue.writes[0]!;
    expect(second.size).toBe(2 * 12 * 4); // full write of 2 rows after resize
  });
});

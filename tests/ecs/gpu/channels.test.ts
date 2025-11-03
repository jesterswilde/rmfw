// tests/ecs/gpu/channels.test.ts
import { World } from "../../../src/ecs/core/world.js";
import { TransformMeta, TransformNodeMeta, ShapeMeta, OperationMeta, RenderNodeMeta } from "../../../src/ecs/registry.js";
import { TransformsChannel } from "../../../src/ecs/gpu/transformsChannel.js";
import { RenderChannel } from "../../../src/ecs/gpu/renderChannel.js";
import { MockQueue, makeMockDevice, installWebGPUShims } from "../../utils/webgpu.mock.js";

installWebGPUShims();

const ORDER0 = (ids: number[]) => Int32Array.from(ids);

describe("GPU Channels", () => {
  it("TransformsChannel: full rebuild on order change, then incremental dirty runs", () => {
    const world = new World({ initialCapacity: 16 });
    // Register Transform + TransformNode stores (no tree required for this test)
    const T = world.register({ meta: TransformMeta }, 8);
    world.register({ meta: TransformNodeMeta }, 8);

    // Create 3 entities with Transform rows
    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();
    T.add(a); T.add(b); T.add(c);

    // Prepare channel + device/queue
    const chan = new TransformsChannel();
    const queue = new MockQueue();
    const device = makeMockDevice(queue);

    // Initial order [a,b,c] with epoch 1
    const order1 = ORDER0([a, b, c]);
    const args1 = { order: order1, orderEpoch: 1, store: world.storeOf(TransformMeta) };

    // First sync → full build, then create/resize, then flush (single full write)
    const changed1 = chan.sync(world, args1);
    expect(changed1).toBe(true);
    const recreated1 = chan.createOrResize(device);
    expect(recreated1).toBe(true);
    chan.flush(queue);
    expect(queue.writes.length).toBe(1);
    const full1 = queue.writes[0]!;
    // 3 rows × 12 floats × 4 bytes
    expect(full1.size).toBe(3 * 12 * 4);

    // Second sync with no changes → early-out (no write after flush)
    queue.reset();
    const changedNo = chan.sync(world, { order: order1, orderEpoch: 1, store: world.storeOf(TransformMeta) });
    expect(changedNo).toBe(false);
    chan.createOrResize(device);
    chan.flush(queue);
    expect(queue.writes.length).toBe(0);

    // Incremental: bump rowVersion for the middle row (b)
    const tRowB = T.denseIndexOf(b);
    T.rowVersion[tRowB] = (T.rowVersion[tRowB]! + 1) >>> 0;
    // storeEpoch must also bump to pass the channel's epoch gate
    T.storeEpoch++;

    queue.reset();
    const changedInc = chan.sync(world, { order: order1, orderEpoch: 1, store: world.storeOf(TransformMeta) });
    expect(changedInc).toBe(true);
    chan.createOrResize(device);
    chan.flush(queue);
    // One contiguous run write expected for just that row
    expect(queue.writes.length).toBe(1);
    const incWrite = queue.writes[0]!;
    expect(incWrite.size).toBe(12 * 4); // single row
    // offset should land at row index 1
    expect(incWrite.offset).toBe(1 * 12 * 4);

    // Change order epoch (e.g., [c,b,a]) → full rebuild; one full write
    queue.reset();
    const order2 = ORDER0([c, b, a]);
    const changed2 = chan.sync(world, { order: order2, orderEpoch: 2, store: world.storeOf(TransformMeta) });
    expect(changed2).toBe(true);
    chan.createOrResize(device);
    chan.flush(queue);
    expect(queue.writes.length).toBe(1);
    expect(queue.writes[0]!.size).toBe(3 * 12 * 4);
  });

  it("RenderChannel: full rebuild on order change, incremental shape/op updates, parent/transform mapping changes", () => {
    const world = new World({ initialCapacity: 16 });
    const Shape = world.register({ meta: ShapeMeta }, 8);
    const Op = world.register({ meta: OperationMeta }, 8);
    const Render = world.register({ meta: RenderNodeMeta }, 8);
    const Transform = world.register({ meta: TransformMeta }, 8);

    // Entities: root-like op, a shape with transform, another op
    const e0 = world.createEntity(); // Op
    const e1 = world.createEntity(); // Shape
    const e2 = world.createEntity(); // Op

    Op.add(e0, { opType: 1 });
    Shape.add(e1, { shapeType: 7, p0: 1, p1: 2, p2: 3, p3: 4, p4: 5, p5: 6 });
    Op.add(e2, { opType: 2 });

    // Give all three a RenderNode row; parent links (entity IDs)
    Render.add(e0, { parent: -1, firstChild: -1, lastChild: -1, nextSibling: -1, prevSibling: -1 } as any);
    Render.add(e1, { parent: e0, firstChild: -1, lastChild: -1, nextSibling: -1, prevSibling: -1 } as any);
    Render.add(e2, { parent: e0, firstChild: -1, lastChild: -1, nextSibling: -1, prevSibling: -1 } as any);

    // Give e1 a Transform row so the channel can map to a transformRow
    Transform.add(e1);

    const chan = new RenderChannel();
    const queue = new MockQueue();
    const device = makeMockDevice(queue);

    // DFS orders for render and transform
    const rOrder1 = ORDER0([e0, e1, e2]);
    const tOrder1 = ORDER0([e1]); // only e1 has a Transform
    const args = {
      order: rOrder1,
      orderEpoch: 1,
      shapeStore: world.storeOf(ShapeMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tOrder1,
      transformOrderEpoch: 10,
    };

    // Initial sync → full build; +1 implicit root row
    const changed1 = chan.sync(world, args);
    expect(changed1).toBe(true);
    chan.createOrResize(device);
    chan.flush(queue);
    expect(queue.writes.length).toBe(1);
    // 1 (implicit root) + 3 rows = 4 rows; BYTES_PER_ROW = 10 lanes * 4 bytes
    expect(queue.writes[0]!.size).toBe(4 * 10 * 4);

    // Early-out when nothing changed (store epochs and both order epochs the same)
    queue.reset();
    const changedNo = chan.sync(world, args);
    expect(changedNo).toBe(false);
    chan.createOrResize(device);
    chan.flush(queue);
    expect(queue.writes.length).toBe(0);

    // Incremental: bump Shape rowVersion and storeEpoch → should upload only that row
    const sRow = Shape.denseIndexOf(e1);
    Shape.rowVersion[sRow] = (Shape.rowVersion[sRow]! + 1) >>> 0;
    Shape.storeEpoch++;

    queue.reset();
    const changedInc = chan.sync(world, args);
    expect(changedInc).toBe(true);
    chan.createOrResize(device);
    chan.flush(queue);
    expect(queue.writes.length).toBe(1);
    // Row index for e1 is r=1+1 (implicit root at 0, e0 at 1, e1 at 2?) — but our order puts e0 at r=1, e1 at r=2, e2 at r=3.
    // We won't assert exact offset here (layout can change), just that a single incremental write occurred.
    expect(queue.writes[0]!.size).toBe(10 * 4);

    // Parent mapping change (reparent e2 under e1) should trigger incremental rewrite for e2 row
    const rf = Render.fields() as any;
    const rRowE2 = Render.denseIndexOf(e2);
    rf.parent[rRowE2] = e1;
    // Changing parent does not bump rowVersion on Shape/Op, but mapping changes are detected in sync
    queue.reset();
    const changedMap = chan.sync(world, args);
    expect(changedMap).toBe(true);
    chan.createOrResize(device);
    chan.flush(queue);
    expect(queue.writes.length).toBe(1);

    // Transform order change should force a full rebuild/refresh due to transformOrderEpoch change gate
    queue.reset();
    const args2 = { ...args, transformOrderEpoch: 11 };
    const changedTransEpoch = chan.sync(world, args2);
    expect(changedTransEpoch).toBe(true);
    chan.createOrResize(device);
    chan.flush(queue);
    // Could be full or many runs, but our implementation early-outs on matching render order; transform epoch change
    // still leads to a (potentially) many-row incremental. We only assert we did an upload.
    expect(queue.writes.length).toBeGreaterThanOrEqual(1);

    // Render order change forces full rebuild: one full write of 4 rows
    queue.reset();
    const args3 = { ...args2, order: ORDER0([e0, e2, e1]), orderEpoch: 2 };
    const changedRepack = chan.sync(world, args3);
    expect(changedRepack).toBe(true);
    chan.createOrResize(device);
    chan.flush(queue);
    expect(queue.writes.length).toBe(1);
    expect(queue.writes[0]!.size).toBe(4 * 10 * 4);
  });
});

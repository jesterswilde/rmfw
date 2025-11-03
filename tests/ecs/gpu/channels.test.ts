// tests/ecs/gpu/channels.test.ts
import { World } from "../../../src/ecs/core/world.js";
import {
  TransformMeta,
  TransformNodeMeta,
  ShapeMeta,
  OperationMeta,
  RenderNodeMeta,
} from "../../../src/ecs/registry.js";
import { TransformsChannel } from "../../../src/ecs/gpu/transformsChannel.js";
import { RenderChannel } from "../../../src/ecs/gpu/renderChannel.js";
import { MockQueue, makeMockDevice, installWebGPUShims } from "../../utils/webgpu.mock.js";

installWebGPUShims();

const ORDER0 = (ids: number[]) => Int32Array.from(ids);
const BYTES_PER_F32 = 4;
const RENDER_ROW_BYTES = 16 * 4; // 4*i32 + 12*f32 = 64 bytes/row

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
    expect(full1.size).toBe(3 * 12 * BYTES_PER_F32);

    // Second sync with no changes → early-out (no write after flush)
    queue.reset();
    const changedNo = chan.sync(world, { order: order1, orderEpoch: 1, store: world.storeOf(TransformMeta) });
    expect(changedNo).toBe(false);
    chan.createOrResize(device);
    chan.flush(queue);
    expect(queue.writes.length).toBe(0);

    // Incremental: bump rowVersion for the middle row (b)
    const tRowB = T.denseIndexOf(b);
    T.update(b, {}); // ensure row exists; no-op but keeps API pattern
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
    expect(incWrite.size).toBe(12 * BYTES_PER_F32); // single row
    // offset should land at row index 1
    expect(incWrite.offset).toBe(1 * 12 * BYTES_PER_F32);

    // Change order epoch (e.g., [c,b,a]) → full rebuild; one full write
    queue.reset();
    const order2 = ORDER0([c, b, a]);
    const changed2 = chan.sync(world, { order: order2, orderEpoch: 2, store: world.storeOf(TransformMeta) });
    expect(changed2).toBe(true);
    chan.createOrResize(device);
    chan.flush(queue);
    expect(queue.writes.length).toBe(1);
    expect(queue.writes[0]!.size).toBe(3 * 12 * BYTES_PER_F32);
  });

  describe("RenderChannel", () => {
    it("full rebuild on render order change; incremental on shape/op/transform updates", () => {
      const world = new World({ initialCapacity: 32 });

      // Register stores we need
      const T = world.register({ meta: TransformMeta }, 16);
      const R = world.register({ meta: RenderNodeMeta }, 16);
      const S = world.register({ meta: ShapeMeta }, 16);
      const O = world.register({ meta: OperationMeta }, 16);

      // Entities:
      // root: Op.ReduceUnion
      // s1: Shape (Sphere), child of root
      // s2: Shape (Box), child of root
      const root = world.createEntity();
      const s1 = world.createEntity();
      const s2 = world.createEntity();

      // RenderNode presence
      R.add(root, { parent: -1 });
      R.add(s1, { parent: root });
      R.add(s2, { parent: root });

      // Components:
      O.add(root, { opType: 100 }); // Op.ReduceUnion (from project enum)
      S.add(s1, { shapeType: 0, p0: 1 }); // Sphere radius = 1
      S.add(s2, { shapeType: 1, p0: 1, p1: 2, p2: 3 }); // Box half-extents

      // Transforms for shapes (root may not need transform)
      T.add(s1);
      T.add(s2);

      // Initial orders (DFS)
      const renderOrder1 = ORDER0([root, s1, s2]);
      const transformOrder1 = ORDER0([s1, s2]);

      const chan = new RenderChannel();
      const queue = new MockQueue();
      const device = makeMockDevice(queue);

      // --- Initial full build ---
      const args1 = {
        order: renderOrder1,
        orderEpoch: 1,
        shapeStore: world.storeOf(ShapeMeta),
        opStore: world.storeOf(OperationMeta),
        renderStore: world.storeOf(RenderNodeMeta),
        transformStore: world.storeOf(TransformMeta),
        transformOrder: transformOrder1,
        transformOrderEpoch: 1,
      };

      let changed = chan.sync(world, args1);
      expect(changed).toBe(true);
      let recreated = chan.createOrResize(device);
      expect(recreated).toBe(true);
      chan.flush(queue);

      // Expect one full write: 3 rows × 64 bytes
      expect(queue.writes.length).toBe(1);
      expect(queue.writes[0]!.size).toBe(renderOrder1.length * RENDER_ROW_BYTES);

      // --- Early-out: no changes ---
      queue.reset();
      changed = chan.sync(world, args1);
      expect(changed).toBe(false);
      chan.createOrResize(device);
      chan.flush(queue);
      expect(queue.writes.length).toBe(0);

      // --- Incremental: change a shape param (s1 radius) ---
      const s1Row = S.denseIndexOf(s1);
      S.update(s1, { p0: 2 }); // bump radius (and rowVersion/storeEpoch)
      queue.reset();
      changed = chan.sync(world, args1);
      expect(changed).toBe(true);
      chan.createOrResize(device);
      chan.flush(queue);
      expect(queue.writes.length).toBe(1);
      const shapeInc = queue.writes[0]!;
      // Only row 1 (s1) should be rewritten: 64 bytes at offset 1*64
      expect(shapeInc.size).toBe(RENDER_ROW_BYTES);
      expect(shapeInc.offset).toBe(1 * RENDER_ROW_BYTES);

      // --- Incremental: op child count change without order change ---
      // Detach s2 from root (parent = -1), but keep renderOrder the same
      R.update(s2, { parent: -1 });
      queue.reset();
      changed = chan.sync(world, {
        ...args1,
        // orderEpoch intentionally unchanged to verify incremental path
        orderEpoch: 1,
      });
      expect(changed).toBe(true);
      chan.createOrResize(device);
      chan.flush(queue);
      // We expect at least the root op row (row 0) to update; minimal single run is acceptable
      expect(queue.writes.length).toBeGreaterThanOrEqual(1);
      // First write should begin at or before the root row
      expect(queue.writes[0]!.offset % RENDER_ROW_BYTES).toBe(0);

      // Restore s2 parent for later tests
      R.update(s2, { parent: root });

      // --- Transform order change only (reindex transforms) ---
      const transformOrder2 = ORDER0([s2, s1]); // swap
      queue.reset();
      changed = chan.sync(world, {
        ...args1,
        transformOrder: transformOrder2,
        transformOrderEpoch: 2,
      });
      expect(changed).toBe(true);
      chan.createOrResize(device);
      chan.flush(queue);
      // Depending on breadth of reindex, channel may mark-all; size must be 3*64
      expect(queue.writes.length).toBe(1);
      expect(queue.writes[0]!.size).toBe(renderOrder1.length * RENDER_ROW_BYTES);

      // --- Render order change → full rebuild ---
      const renderOrder2 = ORDER0([root, s2, s1]); // swap children order in DFS
      queue.reset();
      changed = chan.sync(world, {
        ...args1,
        order: renderOrder2,
        orderEpoch: 2,
      });
      expect(changed).toBe(true);
      chan.createOrResize(device);
      chan.flush(queue);
      expect(queue.writes.length).toBe(1);
      expect(queue.writes[0]!.size).toBe(renderOrder2.length * RENDER_ROW_BYTES);

      // --- Kind transitions: s2 from Shape → None (remove shape) ---
      S.remove(s2);
      queue.reset();
      changed = chan.sync(world, {
        ...args1,
        order: renderOrder2,
        orderEpoch: 2,
      });
      expect(changed).toBe(true);
      chan.createOrResize(device);
      chan.flush(queue);
      // At least one row (s2's row) must have been rewritten
      expect(queue.writes.length).toBeGreaterThanOrEqual(1);

      // --- Re-add s2 as Op node (kind switch) ---
      O.add(s2, { opType: 101 }); // Union
      queue.reset();
      changed = chan.sync(world, {
        ...args1,
        order: renderOrder2,
        orderEpoch: 2,
      });
      expect(changed).toBe(true);
      chan.createOrResize(device);
      chan.flush(queue);
      expect(queue.writes.length).toBeGreaterThanOrEqual(1);
    });
  });
});

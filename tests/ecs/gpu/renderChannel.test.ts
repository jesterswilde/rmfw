// tests/ecs/gpu/renderChannel.test.ts
// Updated: use local offsets for single-row write assertions to avoid DataView range errors.

import {
  RenderChannel,
  BYTES_PER_RENDER_ROW,
  LANES_PER_RENDER_ROW,
} from "../../../src/ecs/gpu/renderChannel.js";
import { initWorld, RenderNodeMeta, ShapeLeafMeta, OperationMeta, TransformMeta } from "../../../src/ecs/registry.js";

// Minimal mock GPU objects used by channel
type WriteCall = { buffer: GPUBuffer; offset: number; data: ArrayBuffer; dataOffset: number; size: number };
class MockBuffer {
  size: number;
  constructor(size: number) { this.size = size; }
  destroy() {}
}
class MockDevice {
  public createdSizes: number[] = [];
  createBuffer(desc: GPUBufferDescriptor) {
    this.createdSizes.push(desc.size!);
    return new MockBuffer(desc.size!) as unknown as GPUBuffer;
  }
}
class MockQueue {
  public writes: WriteCall[] = [];
  writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBuffer, dataOffset?: number, size?: number) {
    this.writes.push({ buffer, offset, data, dataOffset: dataOffset ?? 0, size: size ?? data.byteLength });
  }
}

const NONE = -1;
// Absolute lane offset in the *full buffer* layout
const laneByteOffsetAbs = (row: number, laneIndex: number) =>
  (row * LANES_PER_RENDER_ROW + laneIndex) * 4;

function makeTinyWorld() {
  const world = initWorld({ initialCapacity: 16 });

  // 3 entities: [root, a, b] — deterministic ids: 0,1,2
  const root = world.createEntity();
  const a = world.createEntity();
  const b = world.createEntity();

  // Attach render nodes (all rootless: parent = NONE)
  const r = world.storeOf(RenderNodeMeta);
  r.add(root, { parent: NONE });
  r.add(a,    { parent: NONE });
  r.add(b,    { parent: NONE });

  // Shapes on a and b; op on root (simple union)
  const s = world.storeOf(ShapeLeafMeta);
  s.add(a, { shapeType: 1, p0: 1 });
  s.add(b, { shapeType: 1, p0: 1 });

  const ops = world.storeOf(OperationMeta);
  ops.add(root, { opType: 20 });

  // Transforms exist for all
  world.storeOf(TransformMeta).add(root);
  world.storeOf(TransformMeta).add(a);
  world.storeOf(TransformMeta).add(b);

  // DFS order is deterministic ascending entity id:
  const order = new Int32Array([root, a, b]);
  const tOrder = order.slice(); // 1:1 for this tiny world
  let epoch = 1;
  return {
    world,
    rTree: { order, epoch },
    tTree: { order: tOrder, epoch },
  };
}

describe("RenderChannel — rebuilds, incrementals, kind switches, and resizes", () => {
  test("rootless render nodes map to implicit MIN parent row", () => {
    const { world, rTree, tTree } = makeTinyWorld();
    const chan = new RenderChannel();

    const device = new MockDevice() as unknown as GPUDevice;
    const queue = new MockQueue() as unknown as GPUQueue;

    // First sync (full rebuild)
    chan.sync(world as any, {
      order: rTree.order,
      orderEpoch: rTree.epoch,
      shapeStore: world.storeOf(ShapeLeafMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tTree.order,
      transformOrderEpoch: tTree.epoch,
    });
    chan.createOrResize(device);
    chan.flush(queue);

    // Full write → DataView spans entire buffer; absolute offsets are valid.
    const w = (queue as any).writes[0] as WriteCall;
    const dv = new DataView(w.data, w.dataOffset, w.size);
    const nodeCount = rTree.order.length;
    for (let i = 0; i < nodeCount; i++) {
      const row = i + 1;
      expect(dv.getInt32(laneByteOffsetAbs(row, 2), true)).toBe(0);
    }
  });

  test("first sync → full rebuild (one write), correct row packing size", () => {
    const { world, rTree, tTree } = makeTinyWorld();
    const chan = new RenderChannel();

    const device = new MockDevice() as unknown as GPUDevice;
    const queue = new MockQueue() as unknown as GPUQueue;

    // First sync & flush
    chan.sync(world as any, {
      order: rTree.order,
      orderEpoch: rTree.epoch,
      shapeStore: world.storeOf(ShapeLeafMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tTree.order,
      transformOrderEpoch: tTree.epoch,
    });
    chan.createOrResize(device);
    chan.flush(queue);

    // Rows = DFS length + implicit root row
    const rows = rTree.order.length + 1;
    expect((device as any).createdSizes.at(-1)).toBe(rows * BYTES_PER_RENDER_ROW);

    // One full write on first sync
    expect((queue as any).writes.length).toBe(1);
    const w = (queue as any).writes[0] as WriteCall;
    expect(w.offset).toBe(0);
    expect(w.size).toBe(rows * BYTES_PER_RENDER_ROW);
  });

  test("incremental update: mutating one shape row issues one narrow write", () => {
    const { world, rTree, tTree } = makeTinyWorld();
    const chan = new RenderChannel();

    const device = new MockDevice() as unknown as GPUDevice;
    const queue = new MockQueue() as unknown as GPUQueue;

    // Initial full
    chan.sync(world as any, {
      order: rTree.order,
      orderEpoch: rTree.epoch,
      shapeStore: world.storeOf(ShapeLeafMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tTree.order,
      transformOrderEpoch: tTree.epoch,
    });
    chan.createOrResize(device);
    chan.flush(queue);

    // Clear writes
    (queue as any).writes.length = 0;

    // Mutate a single shape param → bumps that rowVersion
    const s = world.storeOf(ShapeLeafMeta);
    const ent = rTree.order[2]!; // mutate entity 'a' (order: [root, a, b])
    s.update(ent, { p0: 2.0 });

    // Incremental pass
    chan.sync(world as any, {
      order: rTree.order,
      orderEpoch: rTree.epoch,
      shapeStore: world.storeOf(ShapeLeafMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tTree.order,
      transformOrderEpoch: tTree.epoch,
    });
    chan.createOrResize(device);
    chan.flush(queue);

    expect((queue as any).writes.length).toBe(1);
    const w = (queue as any).writes[0] as WriteCall;
    expect(w.size).toBe(BYTES_PER_RENDER_ROW); // exactly one row

    // row index for 'a' is its DFS position + 1 (implicit root at 0)
    const rowIndex = 2 + 1; // 'a' is at order[2]
    expect(w.offset).toBe(BYTES_PER_RENDER_ROW * rowIndex);
  });

  test("kind switch (Shape → Op) updates row and zeros shape payload", () => {
    const { world, rTree, tTree } = makeTinyWorld();
    const chan = new RenderChannel();

    const device = new MockDevice() as unknown as GPUDevice;
    const queue = new MockQueue() as unknown as GPUQueue;

    // Initial full
    chan.sync(world as any, {
      order: rTree.order,
      orderEpoch: rTree.epoch,
      shapeStore: world.storeOf(ShapeLeafMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tTree.order,
      transformOrderEpoch: tTree.epoch,
    });
    chan.createOrResize(device);
    chan.flush(queue);

    // Clear writes
    (queue as any).writes.length = 0;

    // Replace entity 'a' (order[2]) with an Operation
    const entA = rTree.order[2]!;
    const shape = world.storeOf(ShapeLeafMeta);
    const ops = world.storeOf(OperationMeta);

    // Remove shape and add op to same entity
    shape.remove(entA);
    ops.add(entA, { opType: 20 });

    // Incremental pass
    chan.sync(world as any, {
      order: rTree.order,
      orderEpoch: rTree.epoch,
      shapeStore: world.storeOf(ShapeLeafMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tTree.order,
      transformOrderEpoch: tTree.epoch,
    });
    chan.createOrResize(device);
    chan.flush(queue);

    const w = (queue as any).writes[0] as WriteCall;
    const rowIndex = 2 + 1; // 'a' row
    expect(w.size).toBe(BYTES_PER_RENDER_ROW);
    expect(w.offset).toBe(BYTES_PER_RENDER_ROW * rowIndex);

    // Local lane offsets within the single-row slice
    const localLaneByteOffset = (lane: number) => lane * 4;
    const dv = new DataView(w.data, w.dataOffset, w.size);
    for (let lane = 4; lane < 12; lane++) {
      expect(dv.getFloat32(localLaneByteOffset(lane), true)).toBeCloseTo(0);
    }
  });
});

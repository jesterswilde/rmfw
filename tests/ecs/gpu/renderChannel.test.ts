// tests/ecs/gpu/renderChannel.test.ts
import { initWorld, ShapeLeafMeta, OperationMeta } from "../../../src/ecs/registry";
import { buildAllHierarchyTrees } from "../../../src/ecs/trees";
import { GpuBridge } from "../../../src/ecs/gpu/bridge";
import { RenderChannel } from "../../../src/ecs/gpu/renderChannel";
import { RenderKind } from "../../../src/interfaces";

// Minimal GPU mocks
class MockGPUBuffer {
  constructor(public size: number) {}
  destroy() {}
}
class MockGPUDevice {
  createdSizes: number[] = [];
  createBuffer(opts: { size: number; usage: number }) {
    this.createdSizes.push(opts.size as number);
    return new MockGPUBuffer(opts.size as number) as unknown as GPUBuffer;
  }
}
type WriteCall = { offset: number; data: ArrayBuffer; dataOffset: number; size: number };
class MockGPUQueue {
  writes: WriteCall[] = [];
  writeBuffer(_buf: GPUBuffer, offset: number, data: ArrayBuffer, dataOffset?: number, size?: number) {
    this.writes.push({ offset, data, dataOffset: dataOffset ?? 0, size: size ?? data.byteLength });
  }
}

describe("RenderChannel — rebuilds, incrementals, kind switches, and resizes", () => {
  test("first sync → full rebuild (one write), correct row packing for shapes", () => {
    const world = initWorld({ initialCapacity: 32 });
    const trees = buildAllHierarchyTrees(world);
    const rTree = trees.get("RenderNode")!;

    // Build: root -> {e1, e2}
    const root = world.createEntity();
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    rTree.addChild(root, e1);
    rTree.addChild(root, e2);

    // Attach shapes
    const S = world.store(ShapeLeafMeta.name);
    S.add(e1, { shapeType: 3, p0: 1, p1: 2, p2: 3, p3: 4, p4: 5, p5: 6 });
    S.add(e2, { shapeType: 7, p0: 10, p1: 20, p2: 30, p3: 40, p4: 50, p5: 60 });

    const channel = new RenderChannel();
    const bridge = new GpuBridge();
    bridge.register({
      group: 2,
      binding: 0,
      channel,
      argsProvider: (w) => ({
        order: rTree.order,
        orderEpoch: rTree.epoch,
        shapeStore: w.storeOf(ShapeLeafMeta),
        opStore: w.storeOf(OperationMeta),
      }),
    });

    const device = new MockGPUDevice() as unknown as GPUDevice;
    const queue = new MockGPUQueue() as unknown as GPUQueue;

    bridge.syncAll(world, device, queue);

    // One buffer created with rows = DFS length
    const rows = rTree.order.length;
    const BYTES_PER_ROW = 8 * 4;
    expect((device as any).createdSizes.at(-1)).toBe(rows * BYTES_PER_ROW);

    // One full write on first sync
    expect((queue as any).writes.length).toBe(1);
    const w = (queue as any).writes[0] as WriteCall;
    expect(w.offset).toBe(0);
    expect(w.size).toBe(rows * BYTES_PER_ROW);

    // Validate packed ints for first two non-root rows (root has kind None)
    // NOTE: Read from dataOffset only (source AoS slice), not bufferOffset.
    const dv = new DataView(w.data, w.dataOffset, w.size);
    // Row indices in DFS: 0=root, 1=e1, 2=e2
    const lane = (row: number, laneIdx: number) => row * 8 * 4 + laneIdx * 4;

    expect(dv.getInt32(lane(1, 0), true)).toBe(RenderKind.Shape);
    expect(dv.getInt32(lane(1, 1), true)).toBe(3);
    expect(dv.getFloat32(lane(1, 2), true)).toBeCloseTo(1);
    expect(dv.getFloat32(lane(1, 7), true)).toBeCloseTo(6);

    expect(dv.getInt32(lane(2, 0), true)).toBe(RenderKind.Shape);
    expect(dv.getInt32(lane(2, 1), true)).toBe(7);
    expect(dv.getFloat32(lane(2, 2), true)).toBeCloseTo(10);
    expect(dv.getFloat32(lane(2, 7), true)).toBeCloseTo(60);
  });

  test("incremental update: mutating one shape row issues one narrow write", () => {
    const world = initWorld({ initialCapacity: 16 });
    const trees = buildAllHierarchyTrees(world);
    const rTree = trees.get("RenderNode")!;

    const root = world.createEntity();
    const a = world.createEntity();
    const b = world.createEntity();
    rTree.addChild(root, a);
    rTree.addChild(root, b);

    const S = world.store(ShapeLeafMeta.name);
    S.add(a, { shapeType: 1, p0: 0, p1: 0, p2: 0, p3: 0, p4: 0, p5: 0 });
    S.add(b, { shapeType: 2, p0: 9, p1: 9, p2: 9, p3: 9, p4: 9, p5: 9 });

    const channel = new RenderChannel();
    const bridge = new GpuBridge();
    const device = new MockGPUDevice() as unknown as GPUDevice;
    const queue = new MockGPUQueue() as unknown as GPUQueue;

    bridge.register({
      group: 2, binding: 0, channel,
      argsProvider: (w) => ({
        order: rTree.order,
        orderEpoch: rTree.epoch,
        shapeStore: w.storeOf(ShapeLeafMeta),
        opStore: w.storeOf(OperationMeta),
      }),
    });

    // initial full write
    bridge.syncAll(world, device, queue);
    (queue as any).writes = [];

    // mutate one value in 'a' (rowVersion bumps), expect one small write
    const rowA = S.denseIndexOf(a);
    (S.fields() as any).p3[rowA] = 42;
    (S as any).rowVersion[rowA] = ((S as any).rowVersion[rowA] + 1) >>> 0;
    (S as any).storeEpoch++;

    bridge.syncAll(world, device, queue);

    expect((queue as any).writes.length).toBe(1);
    const BYTES_PER_ROW = 8 * 4;
    const w = (queue as any).writes[0] as WriteCall;
    expect(w.size).toBe(BYTES_PER_ROW); // exactly one row
    // row index in DFS: 0=root, 1=a, 2=b → offset = 1*rowSize
    expect(w.offset).toBe(BYTES_PER_ROW * 1);

    // ✅ Read from dataOffset (source slice), NOT buffer offset + dataOffset
    const dv = new DataView(w.data, w.dataOffset, w.size);
    // lane 5 is p3
    expect(dv.getFloat32(5 * 4, true)).toBeCloseTo(42);
  });

  test("kind switch (Shape → Op) updates row and zeros shape payload", () => {
    const world = initWorld({ initialCapacity: 16 });
    const trees = buildAllHierarchyTrees(world);
    const rTree = trees.get("RenderNode")!;

    const root = world.createEntity();
    const x = world.createEntity();
    rTree.addChild(root, x);

    const S = world.store(ShapeLeafMeta.name);
    const O = world.store(OperationMeta.name);

    S.add(x, { shapeType: 5, p0: 11, p1: 22, p2: 33, p3: 44, p4: 55, p5: 66 });

    const channel = new RenderChannel();
    const bridge = new GpuBridge();
    const device = new MockGPUDevice() as unknown as GPUDevice;
    const queue = new MockGPUQueue() as unknown as GPUQueue;

    bridge.register({
      group: 2, binding: 0, channel,
      argsProvider: (w) => ({
        order: rTree.order,
        orderEpoch: rTree.epoch,
        shapeStore: w.storeOf(ShapeLeafMeta),
        opStore: w.storeOf(OperationMeta),
      }),
    });

    // initial full write
    bridge.syncAll(world, device, queue);
    (queue as any).writes = [];

    // remove ShapeLeaf, add Operation
    S.remove(x);
    (S as any).storeEpoch++;
    const orow = O.add(x, { opType: 9 });
    (O as any).rowVersion[orow] = ((O as any).rowVersion[orow] + 1) >>> 0;
    (O as any).storeEpoch++;

    bridge.syncAll(world, device, queue);

    // One row update at DFS index 1
    const BYTES_PER_ROW = 8 * 4;
    const w = (queue as any).writes[0] as WriteCall;
    expect(w.size).toBe(BYTES_PER_ROW);
    expect(w.offset).toBe(BYTES_PER_ROW * 1);

    // ✅ Read from dataOffset only
    const dv = new DataView(w.data, w.dataOffset, w.size);
    expect(dv.getInt32(0, true)).toBe(RenderKind.Op); // kind
    expect(dv.getInt32(4, true)).toBe(9);            // opType
    // shape payload lanes zeroed
    for (let lane = 2; lane <= 7; lane++) {
      expect(dv.getFloat32(lane * 4, true)).toBeCloseTo(0);
    }
  });

  test("buffer resize (more rows) triggers bind-group rebuild + full write", () => {
    const world = initWorld({ initialCapacity: 8 });
    const trees = buildAllHierarchyTrees(world);
    const rTree = trees.get("RenderNode")!;

    const root = world.createEntity();
    const a = world.createEntity();
    rTree.addChild(root, a);
    const S = world.store(ShapeLeafMeta.name);
    S.add(a, { shapeType: 1 });

    const channel = new RenderChannel();
    const bridge = new GpuBridge();
    const device = new MockGPUDevice() as unknown as GPUDevice;
    const queue = new MockGPUQueue() as unknown as GPUQueue;

    bridge.register({
      group: 2, binding: 0, channel,
      argsProvider: (w) => ({
        order: rTree.order,
        orderEpoch: rTree.epoch,
        shapeStore: w.storeOf(ShapeLeafMeta),
        opStore: w.storeOf(OperationMeta),
      }),
    });

    // First sync (size for 2 rows)
    bridge.syncAll(world, device, queue);
    const firstSize = (device as any).createdSizes.at(-1) as number;
    (queue as any).writes = [];

    // Add more children to increase DFS count and epoch
    const b = world.createEntity();
    const c = world.createEntity();
    rTree.addChild(root, b);
    rTree.addChild(root, c);
    S.add(b, { shapeType: 2 });
    S.add(c, { shapeType: 3 });

    bridge.syncAll(world, device, queue);
    const secondSize = (device as any).createdSizes.at(-1) as number;

    expect(secondSize).toBeGreaterThan(firstSize); // buffer recreated to larger size
    // full write after resize
    expect((queue as any).writes.length).toBe(1);
    expect(((queue as any).writes[0] as any).offset).toBe(0);
  });
});

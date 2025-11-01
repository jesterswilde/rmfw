// tests/ecs/gpu/renderChannel.test.ts
import {
  initWorld,
  ShapeLeafMeta,
  OperationMeta,
  RenderNodeMeta,
  TransformMeta,
} from "../../../src/ecs/core/registry";
import { buildAllHierarchyTrees } from "../../../src/ecs/trees";
import { GpuBridge } from "../../../src/ecs/gpu/bridge";
import { RenderChannel } from "../../../src/ecs/gpu/renderChannel";
import { RenderKind } from "../../../src/interfaces";
import { installWebGPUShims } from "../../utils/webgpu.mock";

installWebGPUShims()

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

const BYTES_PER_RENDER_ROW = 10 * 4;

describe("RenderChannel — rebuilds, incrementals, kind switches, and resizes", () => {
  test("rootless render nodes map to implicit MIN parent row", () => {
    const world = initWorld({ initialCapacity: 16 });
    const trees = buildAllHierarchyTrees(world);
    const rTree = trees.get("RenderNode")!;
    const tTree = trees.get("TransformNode")!;

    const renderStore = world.store("RenderNode");
    const shapeStore = world.store(ShapeLeafMeta.name);

    const a = world.createEntity();
    const b = world.createEntity();

    // Explicitly register render nodes with no parents (roots)
    renderStore.add(a, {
      parent: -1,
      firstChild: -1,
      lastChild: -1,
      nextSibling: -1,
      prevSibling: -1,
    });
    renderStore.add(b, {
      parent: -1,
      firstChild: -1,
      lastChild: -1,
      nextSibling: -1,
      prevSibling: -1,
    });

    // Attach shapes so rows are populated as Shape kind
    shapeStore.add(a, { shapeType: 1, p0: 1, p1: 2, p2: 3, p3: 4, p4: 5, p5: 6 });
    shapeStore.add(b, { shapeType: 2, p0: 7, p1: 8, p2: 9, p3: 10, p4: 11, p5: 12 });

    // Ensure DFS order includes the new roots
    rTree.rebuildOrder();

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
        renderStore: w.storeOf(RenderNodeMeta),
        transformStore: w.storeOf(TransformMeta),
        transformOrder: tTree.order,
      }),
    });

    const device = new MockGPUDevice() as unknown as GPUDevice;
    const queue = new MockGPUQueue() as unknown as GPUQueue;

    bridge.syncAll(world, device, queue);

    const write = (queue as any).writes[0] as WriteCall;
    const dv = new DataView(write.data, write.dataOffset, write.size);
    const lane = (row: number, laneIdx: number) => row * BYTES_PER_RENDER_ROW + laneIdx * 4;

    // Row 0 is the implicit MIN op parented to itself
    expect(dv.getInt32(lane(0, 0), true)).toBe(RenderKind.Op);
    expect(dv.getInt32(lane(0, 1), true)).toBe(0);
    expect(dv.getInt32(lane(0, 2), true)).toBe(0);
    expect(dv.getInt32(lane(0, 3), true)).toBe(-1);

    // Root entities should point to the implicit MIN row instead of -1
    const order = Array.from(rTree.order);
    for (let i = 0; i < order.length; i++) {
      const row = i + 1;
      expect(dv.getInt32(lane(row, 2), true)).toBe(0);
    }
  });

  test("first sync → full rebuild (one write), correct row packing for shapes", () => {
    const world = initWorld({ initialCapacity: 32 });
    const trees = buildAllHierarchyTrees(world);
    const rTree = trees.get("RenderNode")!;
    const tTree = trees.get("TransformNode")!;

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
        renderStore: w.storeOf(RenderNodeMeta),
        transformStore: w.storeOf(TransformMeta),
        transformOrder: tTree.order,
      }),
    });

    const device = new MockGPUDevice() as unknown as GPUDevice;
    const queue = new MockGPUQueue() as unknown as GPUQueue;

    bridge.syncAll(world, device, queue);

    // Rows = DFS length + implicit root row
    const rows = rTree.order.length + 1;
    expect((device as any).createdSizes.at(-1)).toBe(rows * BYTES_PER_RENDER_ROW);

    // One full write on first sync
    expect((queue as any).writes.length).toBe(1);
    const w = (queue as any).writes[0] as WriteCall;
    expect(w.offset).toBe(0);
    expect(w.size).toBe(rows * BYTES_PER_RENDER_ROW);

    // Validate packed ints for shape rows (skip implicit MIN + root entity rows)
    const dv = new DataView(w.data, w.dataOffset, w.size);
    const lane = (row: number, laneIdx: number) => row * BYTES_PER_RENDER_ROW + laneIdx * 4;

    expect(dv.getInt32(lane(2, 0), true)).toBe(RenderKind.Shape);
    expect(dv.getInt32(lane(2, 1), true)).toBe(3);
    expect(dv.getInt32(lane(2, 2), true)).toBe(1); // parent row (root entity)
    expect(dv.getInt32(lane(2, 3), true)).toBe(-1); // transform index absent
    expect(dv.getFloat32(lane(2, 4), true)).toBeCloseTo(1);
    expect(dv.getFloat32(lane(2, 9), true)).toBeCloseTo(6);

    expect(dv.getInt32(lane(3, 0), true)).toBe(RenderKind.Shape);
    expect(dv.getInt32(lane(3, 1), true)).toBe(7);
    expect(dv.getInt32(lane(3, 2), true)).toBe(1);
    expect(dv.getInt32(lane(3, 3), true)).toBe(-1);
    expect(dv.getFloat32(lane(3, 4), true)).toBeCloseTo(10);
    expect(dv.getFloat32(lane(3, 9), true)).toBeCloseTo(60);
  });

  test("incremental update: mutating one shape row issues one narrow write", () => {
    const world = initWorld({ initialCapacity: 16 });
    const trees = buildAllHierarchyTrees(world);
    const rTree = trees.get("RenderNode")!;
    const tTree = trees.get("TransformNode")!;

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
      group: 2,
      binding: 0,
      channel,
      argsProvider: (w) => ({
        order: rTree.order,
        orderEpoch: rTree.epoch,
        shapeStore: w.storeOf(ShapeLeafMeta),
        opStore: w.storeOf(OperationMeta),
        renderStore: w.storeOf(RenderNodeMeta),
        transformStore: w.storeOf(TransformMeta),
        transformOrder: tTree.order,
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
    const w = (queue as any).writes[0] as WriteCall;
    expect(w.size).toBe(BYTES_PER_RENDER_ROW); // exactly one row
    // row index in DFS: 0=implicit root, 1=root entity, 2=a, 3=b → offset = 2*rowSize
    expect(w.offset).toBe(BYTES_PER_RENDER_ROW * 2);

    const dv = new DataView(w.data, w.dataOffset, w.size);
    expect(dv.getFloat32(7 * 4, true)).toBeCloseTo(42); // lane 7 (p3)
  });

  test("kind switch (Shape → Op) updates row and zeros shape payload", () => {
    const world = initWorld({ initialCapacity: 16 });
    const trees = buildAllHierarchyTrees(world);
    const rTree = trees.get("RenderNode")!;
    const tTree = trees.get("TransformNode")!;

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
      group: 2,
      binding: 0,
      channel,
      argsProvider: (w) => ({
        order: rTree.order,
        orderEpoch: rTree.epoch,
        shapeStore: w.storeOf(ShapeLeafMeta),
        opStore: w.storeOf(OperationMeta),
        renderStore: w.storeOf(RenderNodeMeta),
        transformStore: w.storeOf(TransformMeta),
        transformOrder: tTree.order,
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

    const w = (queue as any).writes[0] as WriteCall;
    expect(w.size).toBe(BYTES_PER_RENDER_ROW);
    expect(w.offset).toBe(BYTES_PER_RENDER_ROW * 2);

    const dv = new DataView(w.data, w.dataOffset, w.size);
    expect(dv.getInt32(0, true)).toBe(RenderKind.Op);
    expect(dv.getInt32(4, true)).toBe(9);
    expect(dv.getInt32(8, true)).toBe(1);
    expect(dv.getInt32(12, true)).toBe(-1);
    for (let lane = 4; lane <= 9; lane++) {
      expect(dv.getFloat32(lane * 4, true)).toBeCloseTo(0);
    }
  });

  test("buffer resize (more rows) triggers bind-group rebuild + full write", () => {
    const world = initWorld({ initialCapacity: 8 });
    const trees = buildAllHierarchyTrees(world);
    const rTree = trees.get("RenderNode")!;
    const tTree = trees.get("TransformNode")!;

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
      group: 2,
      binding: 0,
      channel,
      argsProvider: (w) => ({
        order: rTree.order,
        orderEpoch: rTree.epoch,
        shapeStore: w.storeOf(ShapeLeafMeta),
        opStore: w.storeOf(OperationMeta),
        renderStore: w.storeOf(RenderNodeMeta),
        transformStore: w.storeOf(TransformMeta),
        transformOrder: tTree.order,
      }),
    });

    bridge.syncAll(world, device, queue);
    const firstSize = (device as any).createdSizes.at(-1) as number;
    (queue as any).writes = [];

    const b = world.createEntity();
    const c = world.createEntity();
    rTree.addChild(root, b);
    rTree.addChild(root, c);
    S.add(b, { shapeType: 2 });
    S.add(c, { shapeType: 3 });

    bridge.syncAll(world, device, queue);
    const secondSize = (device as any).createdSizes.at(-1) as number;

    expect(secondSize).toBeGreaterThan(firstSize);
    expect((queue as any).writes.length).toBe(1);
    expect(((queue as any).writes[0] as WriteCall).offset).toBe(0);
  });
});

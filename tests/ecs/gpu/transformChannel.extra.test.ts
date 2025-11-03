// tests/ecs/gpu/transformsChannel.extra.test.ts
import { World } from "../../../src/ecs/core/world.js";
import { TransformMeta, TransformNodeMeta } from "../../../src/ecs/registry.js";
import { TransformsChannel } from "../../../src/ecs/gpu/transformsChannel.js";
import { installWebGPUShims, MockQueue, makeMockDevice } from "../../utils/webgpu.mock.js";

installWebGPUShims();

const ORDER = (ids: number[]) => Int32Array.from(ids);
const BYTES_PER_F32 = 4;
const ROW_BYTES = 12 * BYTES_PER_F32; // 3x4 matrix

describe("TransformsChannel — full coverage of spec behaviors", () => {
  it("skips missing transforms safely; row size and offsets are 48-byte aligned", () => {
    const world = new World({ initialCapacity: 16 });
    const T = world.register({ meta: TransformMeta }, 8);
    world.register({ meta: TransformNodeMeta }, 8);

    const a = world.createEntity();
    const b = world.createEntity();
    const c = world.createEntity();

    // Only add transform to a and c
    T.add(a);
    T.add(c);

    const order = ORDER([a, b, c]);
    const chan = new TransformsChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    const changed = chan.sync(world, { order, orderEpoch: 1, store: world.storeOf(TransformMeta) });
    expect(changed).toBe(true);
    chan.createOrResize(dev);
    chan.flush(q);

    // Single full write: 3 rows × 48 bytes
    expect(q.writes.length).toBe(1);
    expect(q.writes[0]!.size).toBe(3 * ROW_BYTES);
    // Alignment: first row offset 0, rows are 48 bytes apart
    expect(q.writes[0]!.offset).toBe(0);
  });

  it("determinism: identical input yields byte-identical buffer", () => {
    const world = new World({ initialCapacity: 8 });
    const T = world.register({ meta: TransformMeta }, 8);
    world.register({ meta: TransformNodeMeta }, 8);
    const e0 = world.createEntity();
    const e1 = world.createEntity();
    T.add(e0);
    T.add(e1);

    const order = ORDER([e0, e1]);
    const chanA = new TransformsChannel();
    const chanB = new TransformsChannel();

    chanA.sync(world, { order, orderEpoch: 1, store: world.storeOf(TransformMeta) });
    chanB.sync(world, { order, orderEpoch: 1, store: world.storeOf(TransformMeta) });

    const bufA = new Uint8Array((chanA as any).cpu, 0, (chanA as any).sizeBytes);
    const bufB = new Uint8Array((chanB as any).cpu, 0, (chanB as any).sizeBytes);
    expect(Array.from(bufA)).toEqual(Array.from(bufB));
  });

  it("rowVersionSeen tracking: bump → writes once; second sync no-op", () => {
    const world = new World({ initialCapacity: 8 });
    const T = world.register({ meta: TransformMeta }, 8);
    const a = world.createEntity();
    const b = world.createEntity();
    T.add(a);
    T.add(b);

    const chan = new TransformsChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    const order = ORDER([a, b]);

    // initial build
    chan.sync(world, { order, orderEpoch: 1, store: world.storeOf(TransformMeta) });
    chan.createOrResize(dev);
    chan.flush(q);
    q.reset();

    // bump rowVersion for 'b' properly via update() (increments storeEpoch)
    T.update(b, { inv_tx: 42 });

    // first incremental: expect 1 write of 48 bytes at offset row=1
    let changed = chan.sync(world, { order, orderEpoch: 1, store: world.storeOf(TransformMeta) });
    expect(changed).toBe(true);
    chan.createOrResize(dev);
    chan.flush(q);
    expect(q.writes.length).toBe(1);
    expect(q.writes[0]!.size).toBe(ROW_BYTES);
    expect(q.writes[0]!.offset).toBe(1 * ROW_BYTES);

    // second sync without any changes: expect no writes
    q.reset();
    changed = chan.sync(world, { order, orderEpoch: 1, store: world.storeOf(TransformMeta) });
    expect(changed).toBe(false);
    chan.createOrResize(dev);
    chan.flush(q);
    expect(q.writes.length).toBe(0);
  });

  it("epoch gate: changing rowVersion without bumping storeEpoch results in no upload", () => {
    const world = new World({ initialCapacity: 8 });
    const T = world.register({ meta: TransformMeta }, 8);
    const a = world.createEntity();
    T.add(a);

    const chan = new TransformsChannel();
    const order = ORDER([a]);

    chan.sync(world, { order, orderEpoch: 1, store: world.storeOf(TransformMeta) });

    // Manually mutate rowVersion without bumping storeEpoch
    const store: any = world.storeOf(TransformMeta);
    const row = store.denseIndexOf(a);
    store.rowVersion[row] = (store.rowVersion[row] + 1) >>> 0;

    const changed = chan.sync(world, { order, orderEpoch: 1, store: world.storeOf(TransformMeta) });
    expect(changed).toBe(false);
  });

  it("capacity growth resizes internal views and uploads full rows", () => {
    const world = new World({ initialCapacity: 2 });
    const T = world.register({ meta: TransformMeta }, 2);

    const a = world.createEntity(); const b = world.createEntity(); const c = world.createEntity(); const d = world.createEntity();
    T.add(a); T.add(b); T.add(c); T.add(d);

    const order = ORDER([a, b, c, d]);
    const chan = new TransformsChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    chan.sync(world, { order, orderEpoch: 1, store: world.storeOf(TransformMeta) });
    chan.createOrResize(dev);
    chan.flush(q);
    expect(q.writes.length).toBe(1);
    expect(q.writes[0]!.size).toBe(4 * ROW_BYTES);
  });
});

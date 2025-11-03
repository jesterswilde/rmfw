// tests/ecs/gpu/renderChannel.extra.test.ts
import { World } from "../../../src/ecs/core/world.js";
import {
  TransformMeta,
  RenderNodeMeta,
  ShapeMeta,
  OperationMeta,
} from "../../../src/ecs/registry.js";
import { RenderChannel } from "../../../src/ecs/gpu/renderChannel.js";
import { installWebGPUShims, MockQueue, makeMockDevice } from "../../utils/webgpu.mock.js";

installWebGPUShims();

const ORDER = (ids: number[]) => Int32Array.from(ids);
const BYTES_PER_F32 = 4;
const RENDER_ROW_BYTES = 16 * BYTES_PER_F32; // 4*i32 + 12*f32

// Header lanes (i32)
const I_KIND = 0;
const I_FIRST_CHILD = 1;
const I_NEXT_SIBLING = 2;
const I_FLAGS = 3;

function i32At(chan: RenderChannel, laneIndex: number) {
  return ((chan as unknown) as { i32: Int32Array }).i32[laneIndex];
}
function f32At(chan: RenderChannel, laneIndex: number) {
  return ((chan as unknown) as { f32: Float32Array }).f32[laneIndex];
}

describe("RenderChannel — packing, wiring, determinism, and incremental paths", () => {
  it("packs Shape, Op, and Inert rows correctly (headers, payloads, zeroing, flags)", () => {
    const world = new World({ initialCapacity: 64 });
    const T = world.register({ meta: TransformMeta }, 16);
    const R = world.register({ meta: RenderNodeMeta }, 16);
    const S = world.register({ meta: ShapeMeta }, 16);
    const O = world.register({ meta: OperationMeta }, 16);

    // Entities
    const root = world.createEntity(); // op
    const s1 = world.createEntity();   // shape
    const inert = world.createEntity();// inert (render node but no shape/op)

    // RenderNode presence & hierarchy
    R.add(root, { parent: -1 });
    R.add(s1,   { parent: root });
    R.add(inert,{ parent: root });

    // Components
    O.add(root, { opType: 7 }); // arbitrary op
    S.add(s1,   { shapeType: 2, p0: 10, p1: 20 });
    // inert: no S/O

    // Transforms for shape only
    T.add(s1);

    const order = ORDER([root, s1, inert]);
    const tOrder = ORDER([s1]);

    const chan = new RenderChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    const args = {
      order, orderEpoch: 1,
      shapeStore: world.storeOf(ShapeMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tOrder,
      transformOrderEpoch: 1,
    };

    const changed = chan.sync(world, args);
    expect(changed).toBe(true);
    chan.createOrResize(dev);
    chan.flush(q);
    expect(q.writes.length).toBe(1);
    expect(q.writes[0]!.size).toBe(order.length * RENDER_ROW_BYTES);

    // Read headers/payloads from CPU buffer (no GPU readback needed)
    const base0 = 0 * 16;
    const base1 = 1 * 16;
    const base2 = 2 * 16;

    // Row 0: Op
    expect(i32At(chan, base0 + I_KIND)).toBe(7);
    expect(i32At(chan, base0 + I_FIRST_CHILD)).toBe(1); // first child is s1 row
    expect(i32At(chan, base0 + I_FLAGS)).toBe(0);
    // v0 as childCount must be 2 (s1 + inert)
    expect(i32At(chan, base0 + 4 + 0)).toBe(2);
    // other payload lanes zero
    for (let k = 1; k < 12; k++) expect(f32At(chan, base0 + 4 + k)).toBe(0);

    // Row 1: Shape
    expect(i32At(chan, base1 + I_KIND)).toBe(2);
    expect(i32At(chan, base1 + I_FIRST_CHILD)).toBe(-1);
    expect(i32At(chan, base1 + I_FLAGS)).toBe(0);
    // v0 is transform index (bitcast); with only s1 in tOrder it's 0
    expect(i32At(chan, base1 + 4 + 0)).toBe(0);
    // v1 is materialId = -1
    expect(i32At(chan, base1 + 4 + 1)).toBe(-1);
    // params
    expect(f32At(chan, base1 + 4 + 2)).toBe(10);
    expect(f32At(chan, base1 + 4 + 3)).toBe(20);
    for (let k = 4; k <= 7; k++) expect(f32At(chan, base1 + 4 + k)).toBe(0);
    // reserved lanes zero
    for (let k = 8; k <= 11; k++) expect(f32At(chan, base1 + 4 + k)).toBe(0);

    // Row 2: Inert
    expect(i32At(chan, base2 + I_KIND)).toBe(0);
    expect(i32At(chan, base2 + I_FIRST_CHILD)).toBe(-1);
    expect(i32At(chan, base2 + I_FLAGS)).toBe(0);
    // all payload zero
    for (let k = 0; k < 12; k++) expect(f32At(chan, base2 + 4 + k)).toBe(0);

    // Alignment sanity
    expect(q.writes[0]!.offset % RENDER_ROW_BYTES).toBe(0);
  });

  it("hierarchy wiring: firstChild/nextSibling indices follow DFS order", () => {
    const world = new World({ initialCapacity: 32 });
    const T = world.register({ meta: TransformMeta }, 16);
    const R = world.register({ meta: RenderNodeMeta }, 16);
    const S = world.register({ meta: ShapeMeta }, 16);
    const O = world.register({ meta: OperationMeta }, 16);

    const root = world.createEntity();
    const c1 = world.createEntity();
    const c2 = world.createEntity();
    const g  = world.createEntity(); // grandchild of c1

    R.add(root, { parent: -1 });
    R.add(c1,   { parent: root });
    R.add(c2,   { parent: root });
    R.add(g,    { parent: c1 });

    O.add(root, { opType: 100 });
    S.add(c1,   { shapeType: 1 });
    S.add(c2,   { shapeType: 1 });
    S.add(g,    { shapeType: 0 });

    T.add(c1); T.add(c2); T.add(g);

    const order = ORDER([root, c1, g, c2]);
    const tOrder = ORDER([c1, c2, g]);

    const chan = new RenderChannel();
    const args = {
      order, orderEpoch: 1,
      shapeStore: world.storeOf(ShapeMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tOrder,
      transformOrderEpoch: 1,
    };
    chan.sync(world, args);

    const baseRoot = 0 * 16;
    const baseC1   = 1 * 16;
    const baseG    = 2 * 16;
    const baseC2   = 3 * 16;

    expect(i32At(chan, baseRoot + I_FIRST_CHILD)).toBe(1); // c1
    expect(i32At(chan, baseC1   + I_NEXT_SIBLING)).toBe(3); // c2
    expect(i32At(chan, baseG    + I_NEXT_SIBLING)).toBe(-1);
  });

  it("transform reindex only: updates shape rows (v0) without full-buffer rewrite", () => {
    const world = new World({ initialCapacity: 32 });
    const T = world.register({ meta: TransformMeta }, 16);
    const R = world.register({ meta: RenderNodeMeta }, 16);
    const S = world.register({ meta: ShapeMeta }, 16);
    const O = world.register({ meta: OperationMeta }, 16);

    const root = world.createEntity();
    const s1 = world.createEntity();
    const s2 = world.createEntity();

    R.add(root, { parent: -1 });
    R.add(s1, { parent: root });
    R.add(s2, { parent: root });

    O.add(root, { opType: 100 });
    S.add(s1, { shapeType: 0 });
    S.add(s2, { shapeType: 1 });

    T.add(s1);
    T.add(s2);

    const renderOrder = ORDER([root, s1, s2]);
    const tOrder1 = ORDER([s1, s2]);

    const chan = new RenderChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    const argsBase = {
      order: renderOrder,
      shapeStore: world.storeOf(ShapeMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
    };

    // Initial
    chan.sync(world, { ...argsBase, orderEpoch: 1, transformOrder: tOrder1, transformOrderEpoch: 1 });
    chan.createOrResize(dev);
    chan.flush(q);

    // Swap transform order (reindex only for shapes)
    const tOrder2 = ORDER([s2, s1]);
    q.reset();
    const changed = chan.sync(world, { ...argsBase, orderEpoch: 1, transformOrder: tOrder2, transformOrderEpoch: 2 });
    expect(changed).toBe(true);
    chan.createOrResize(dev);
    chan.flush(q);

    // Expect ONLY the two shape rows (1 and 2) to be rewritten as a single contiguous run: size = 2 rows
    expect(q.writes.length).toBe(1);
    expect(q.writes[0]!.offset).toBe(1 * RENDER_ROW_BYTES);
    expect(q.writes[0]!.size).toBe(2 * RENDER_ROW_BYTES);

    // And their v0 (bitcasted transform indices) should be 1 and 0 respectively
    const base1 = 1 * 16, base2 = 2 * 16;
    expect(i32At(chan, base1 + 4 + 0)).toBe(1); // s1 now at transform row 1
    expect(i32At(chan, base2 + 4 + 0)).toBe(0); // s2 now at transform row 0
  });

  it("kind transitions zero unused payload and set flags=0; inert rows at init too", () => {
    const world = new World({ initialCapacity: 32 });
    const T = world.register({ meta: TransformMeta }, 16);
    const R = world.register({ meta: RenderNodeMeta }, 16);
    const S = world.register({ meta: ShapeMeta }, 16);
    const O = world.register({ meta: OperationMeta }, 16);

    const root = world.createEntity();
    const e = world.createEntity();

    R.add(root, { parent: -1 });
    R.add(e,    { parent: root });

    O.add(root, { opType: 1 });
    // e starts inert

    const order = ORDER([root, e]);
    const tOrder = ORDER([]); // none at first

    const chan = new RenderChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    const args = {
      order, orderEpoch: 1,
      shapeStore: world.storeOf(ShapeMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tOrder,
      transformOrderEpoch: 1,
    };

    chan.sync(world, args);
    chan.createOrResize(dev);
    chan.flush(q);
    q.reset();

    // Inert row checks
    const baseE = 1 * 16;
    expect(i32At(chan, baseE + I_KIND)).toBe(0);
    for (let k = 0; k < 12; k++) expect(f32At(chan, baseE + 4 + k)).toBe(0);

    // Transition inert -> Shape; ensure zeroing of now-unused lanes and flags remain 0
    S.add(e, { shapeType: 3, p0: 5 });
    T.add(e); // give it a transform so v0 is a valid index (0)
    const tOrder2 = ORDER([e]);

    const changed = chan.sync(world, { ...args, transformOrder: tOrder2, transformOrderEpoch: 2 });
    expect(changed).toBe(true);
    chan.createOrResize(dev);
    chan.flush(q);

    expect(i32At(chan, baseE + I_KIND)).toBe(3);
    expect(i32At(chan, baseE + I_FLAGS)).toBe(0);
    expect(i32At(chan, baseE + 4 + 0)).toBe(0); // transform idx
    expect(i32At(chan, baseE + 4 + 1)).toBe(-1); // material id
    expect(f32At(chan, baseE + 4 + 2)).toBe(5);
    for (let k = 3; k <= 11; k++) expect(f32At(chan, baseE + 4 + k)).toBe(0);
  });

  it("entity cache growth handles many entities and preserves determinism", () => {
    const world = new World({ initialCapacity: 8 });
    const T = world.register({ meta: TransformMeta }, 8);
    const R = world.register({ meta: RenderNodeMeta }, 8);
    const S = world.register({ meta: ShapeMeta }, 8);
    const O = world.register({ meta: OperationMeta }, 8);

    // Build a flat forest under a root op
    const root = world.createEntity();
    O.add(root, { opType: 9 });
    R.add(root, { parent: -1 });

    const leaves: number[] = [];
    for (let i = 0; i < 25; i++) {
      const e = world.createEntity();
      leaves.push(e);
      R.add(e, { parent: root });
      S.add(e, { shapeType: i % 4, p0: i });
      T.add(e);
    }

    const order = ORDER([root, ...leaves]);
    const tOrder = ORDER(leaves);

    const chanA = new RenderChannel();
    const chanB = new RenderChannel();

    // First sync
    chanA.sync(world, {
      order, orderEpoch: 1,
      shapeStore: world.storeOf(ShapeMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tOrder,
      transformOrderEpoch: 1,
    });

    // Second sync into a fresh channel
    chanB.sync(world, {
      order, orderEpoch: 1,
      shapeStore: world.storeOf(ShapeMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tOrder,
      transformOrderEpoch: 1,
    });

    // Deterministic CPU buffer contents
    const bufA = new Uint8Array((chanA as any).cpu, 0, (chanA as any).sizeBytes);
    const bufB = new Uint8Array((chanB as any).cpu, 0, (chanB as any).sizeBytes);
    expect(Array.from(bufA)).toEqual(Array.from(bufB));
  });

  it("missing transform for a shape falls back to index 0 (defined contract)", () => {
    const world = new World({ initialCapacity: 8 });
    const T = world.register({ meta: TransformMeta }, 8);
    const R = world.register({ meta: RenderNodeMeta }, 8);
    const S = world.register({ meta: ShapeMeta }, 8);
    const O = world.register({ meta: OperationMeta }, 8);

    const root = world.createEntity();
    const s = world.createEntity();

    R.add(root, { parent: -1 });
    R.add(s, { parent: root });

    O.add(root, { opType: 1 });
    S.add(s, { shapeType: 5 });

    // NO transform added to 's'
    const order = ORDER([root, s]);
    const tOrder = ORDER([]); // empty transform order

    const chan = new RenderChannel();
    chan.sync(world, {
      order, orderEpoch: 1,
      shapeStore: world.storeOf(ShapeMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tOrder,
      transformOrderEpoch: 1,
    });

    const baseS = 1 * 16;
    // Contract in current implementation: FALLBACK_TRANSFORM_INDEX = 0
    expect(i32At(chan, baseS + 4 + 0)).toBe(0);
  });

  it("row size/alignment and flags=0 for all rows", () => {
    const world = new World({ initialCapacity: 8 });
    const T = world.register({ meta: TransformMeta }, 8);
    const R = world.register({ meta: RenderNodeMeta }, 8);
    const S = world.register({ meta: ShapeMeta }, 8);
    const O = world.register({ meta: OperationMeta }, 8);

    const root = world.createEntity();
    const s1 = world.createEntity();
    R.add(root, { parent: -1 });
    R.add(s1, { parent: root });
    O.add(root, { opType: 4 });
    S.add(s1, { shapeType: 2 });
    T.add(s1);

    const order = ORDER([root, s1]);
    const tOrder = ORDER([s1]);

    const chan = new RenderChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    chan.sync(world, {
      order, orderEpoch: 1,
      shapeStore: world.storeOf(ShapeMeta),
      opStore: world.storeOf(OperationMeta),
      renderStore: world.storeOf(RenderNodeMeta),
      transformStore: world.storeOf(TransformMeta),
      transformOrder: tOrder,
      transformOrderEpoch: 1,
    });
    chan.createOrResize(dev);
    chan.flush(q);

    expect(q.writes.length).toBe(1);
    expect(q.writes[0]!.size).toBe(2 * RENDER_ROW_BYTES);
    expect(q.writes[0]!.offset % RENDER_ROW_BYTES).toBe(0);

    // flags are zero for both rows
    const base0 = 0 * 16;
    const base1 = 1 * 16;
    expect(i32At(chan, base0 + I_FLAGS)).toBe(0);
    expect(i32At(chan, base1 + I_FLAGS)).toBe(0);
  });
});

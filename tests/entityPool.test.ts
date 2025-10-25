import { EntityPool } from "../src/pools/entity";
import { EntityType } from "../src/entityDef";
import { Vector3 } from "../src/utils/math";

describe("EntityPool", () => {
  test("initialization + null entity invariants", () => {
    const pool = new EntityPool(4);
    expect(pool.size).toBe(1);
    expect(pool.capacity).toBeGreaterThanOrEqual(4);
    expect(pool.nullEntityId).toBe(0);
    expect(() => pool.validate()).not.toThrow();
  });

  test("Camera create/update/get", () => {
    const pool = new EntityPool(2);
    const id = pool.create({ type: EntityType.Camera, xformID: 10 });
    expect(pool.get(id)).toEqual({ type: EntityType.Camera, xformID: 10 });
    pool.update(id, { type: EntityType.Camera, xformID: 12 });
    expect(pool.get(id)).toEqual({ type: EntityType.Camera, xformID: 12 });
  });

  test("Sphere (xformID + radius only) roundtrip", () => {
    const pool = new EntityPool(4);
    const id = pool.create({
      type: EntityType.Sphere,
      xformID: 3,
      material: 7,
      radius: 5.25,
    });
    const s = pool.get(id) as any;
    expect(s.type).toBe(EntityType.Sphere);
    expect(s.xformID).toBe(3);
    expect(s.material).toBe(7);
    expect(s.radius).toBeCloseTo(5.25);
  });

  test("Box roundtrip + header lanes (TYPE, XFORM, MAT, FLAGS)", () => {
    const pool = new EntityPool(4);
    const id = pool.create({
      type: EntityType.Box,
      xformID: 22,
      material: 9,
      bounds: new Vector3(2, 3, 4),
    });

    const got = pool.get(id) as any;
    expect(got.type).toBe(EntityType.Box);
    expect(got.xformID).toBe(22);
    expect(got.material).toBe(9);
    expect(got.bounds).toEqual({ x: 2, y: 3, z: 4 });

    const { gpuI32, gpuF32, GPU_STRIDE } = pool.getBufferViews();
    const b = id * GPU_STRIDE;

    // header: [type, xform, mat, flags]
    expect(gpuI32[b + 0]).toBe(EntityType.Box);
    expect(gpuI32[b + 1]).toBe(22);
    expect(gpuI32[b + 2]).toBe(9);
    expect(gpuI32[b + 3]).toBe(0);

    // v0: bounds xyz; w = 0
    expect(gpuF32[b + 4]).toBeCloseTo(2);
    expect(gpuF32[b + 5]).toBeCloseTo(3);
    expect(gpuF32[b + 6]).toBeCloseTo(4);
    expect(gpuF32[b + 7]).toBeCloseTo(0);
  });

  test("GateBox roundtrip", () => {
    const pool = new EntityPool(4);
    const id = pool.create({
      type: EntityType.GateBox,
      xformID: 99,
      bounds: { x: 6, y: 7, z: 8 },
    } as any);

    const g = pool.get(id) as any;
    expect(g.type).toBe(EntityType.GateBox);
    expect(g.xformID).toBe(99);
    expect(g.bounds).toEqual({ x: 6, y: 7, z: 8 });
  });

  test("ReduceUnion + simple CSGs roundtrip", () => {
    const pool = new EntityPool(16);
    const ru = pool.create({ type: EntityType.ReduceUnion, children: 3 });
    const u  = pool.create({ type: EntityType.SimpleUnion });
    const s  = pool.create({ type: EntityType.SimpleSubtract });
    const i  = pool.create({ type: EntityType.SimpleIntersection });

    expect(pool.get(ru)).toEqual({ type: EntityType.ReduceUnion, children: 3 });
    expect(pool.get(u)).toEqual({ type: EntityType.SimpleUnion });
    expect(pool.get(s)).toEqual({ type: EntityType.SimpleSubtract });
    expect(pool.get(i)).toEqual({ type: EntityType.SimpleIntersection });
  });

  test("remove → free-list reuse", () => {
    const pool = new EntityPool(8);
    const a = pool.create({ type: EntityType.SimpleUnion });
    const b = pool.create({ type: EntityType.SimpleSubtract });
    expect(pool.size).toBe(3);

    pool.remove(a);
    expect(pool.size).toBe(2);
    expect(() => pool.get(a)).toThrow();

    const c = pool.create({ type: EntityType.SimpleIntersection });
    expect(c).toBe(a); // reused the freed slot
    expect(pool.size).toBe(3);
  });


  test("grow preserves data and free-list works after growth", () => {
    const pool = new EntityPool(1);

    const anchor = pool.create({
      type: EntityType.GateBox,
      xformID: 123,
      bounds: { x: 10, y: 20, z: 30 },
    } as any);

    // Force multiple grows
    const ids: number[] = [];
    for (let i = 0; i < 200; i++) ids.push(pool.create({ type: EntityType.SimpleUnion }));

    const snap = pool.get(anchor) as any;
    expect(snap.type).toBe(EntityType.GateBox);
    expect(snap.xformID).toBe(123);
    expect(snap.bounds).toEqual({ x: 10, y: 20, z: 30 });

    // Free a couple and ensure reuse
    pool.remove(ids[10]);
    pool.remove(ids[50]);
    const r1 = pool.create({ type: EntityType.SimpleSubtract });
    const r2 = pool.create({ type: EntityType.SimpleIntersection });
    expect([ids[10], ids[50]]).toContain(r1);
    expect([ids[10], ids[50]]).toContain(r2);
  });

  test("GPU upload stride advertises 12 lanes and shares buffer", () => {
    const pool = new EntityPool(2);
    const view = pool.getBufferViews();
    expect(view.GPU_STRIDE).toBe(12);
    expect(view.gpuMirrorBuffer).toBe(pool.getBufferViews().gpuMirrorBuffer);
  });

  test("validate enforces null entity and detects corruption", () => {
    const pool = new EntityPool(2);
    expect(() => pool.validate()).not.toThrow();

    // Corrupt null entity's type
    const { gpuI32, GPU_STRIDE } = pool.getBufferViews();
    gpuI32[0 * GPU_STRIDE + 0] = 123456;
    expect(() => pool.validate()).toThrow();
  });
});

// tests/mat34pool.new.spec.ts
import { Mat34Pool } from "../src/pools/matrix";
import { Vector3, deg2rad, type EulerZYX } from "../src/utils/math";

const EPS = 1e-5;
const close = (a: number, b: number, eps = EPS) => Math.abs(a - b) <= eps;

function expectVecClose(a: Vector3, b: Vector3, eps = EPS) {
  expect(close(a.x, b.x, eps)).toBe(true);
  expect(close(a.y, b.y, eps)).toBe(true);
  expect(close(a.z, b.z, eps)).toBe(true);
}

// Helpers to read 3x4s from the pool
function readLocal(pool: Mat34Pool, id: number): Float32Array {
  const { metaF32, META_STRIDE, META_LOCAL_OFFSET } = pool.getBufferViews() as any;
  const base = id * META_STRIDE + META_LOCAL_OFFSET;
  return Float32Array.from(metaF32.slice(base, base + 12));
}
function readWorld(pool: Mat34Pool, id: number): Float32Array {
  const { metaF32, META_STRIDE, META_WORLD_OFFSET } = pool.getBufferViews() as any;
  const base = id * META_STRIDE + META_WORLD_OFFSET;
  return Float32Array.from(metaF32.slice(base, base + 12));
}
function readInverseWorld(pool: Mat34Pool, id: number): Float32Array {
  const { gpuF32, GPU_STRIDE } = pool.getBufferViews();
  const base = id * GPU_STRIDE;
  return Float32Array.from(gpuF32.slice(base, base + 12));
}

// Apply a 3x4 (row-major) to a point / direction
function applyMatPoint(m: Float32Array, p: Vector3): Vector3 {
  const x = p.x, y = p.y, z = p.z;
  const nx = m[0]*x + m[1]*y + m[2]*z + m[3];
  const ny = m[4]*x + m[5]*y + m[6]*z + m[7];
  const nz = m[8]*x + m[9]*y + m[10]*z + m[11];
  return new Vector3(nx, ny, nz);
}
function applyMatDir(m: Float32Array, v: Vector3): Vector3 {
  const x = v.x, y = v.y, z = v.z;
  const nx = m[0]*x + m[1]*y + m[2]*z;
  const ny = m[4]*x + m[5]*y + m[6]*z;
  const nz = m[8]*x + m[9]*y + m[10]*z;
  return new Vector3(nx, ny, nz);
}

// Multiply 3x4 = A * B (row-major, 3x4 blocks)
function mul3x4(A: Float32Array, B: Float32Array): Float32Array {
  const r = new Float32Array(12);

  const a00=A[0], a01=A[1], a02=A[2], atx=A[3];
  const a10=A[4], a11=A[5], a12=A[6], aty=A[7];
  const a20=A[8], a21=A[9], a22=A[10], atz=A[11];

  const b00=B[0], b01=B[1], b02=B[2], btx=B[3];
  const b10=B[4], b11=B[5], b12=B[6], bty=B[7];
  const b20=B[8], b21=B[9], b22=B[10], btz=B[11];

  r[0]  = a00*b00 + a01*b10 + a02*b20;
  r[1]  = a00*b01 + a01*b11 + a02*b21;
  r[2]  = a00*b02 + a01*b12 + a02*b22;

  r[4]  = a10*b00 + a11*b10 + a12*b20;
  r[5]  = a10*b01 + a11*b11 + a12*b21;
  r[6]  = a10*b02 + a11*b12 + a12*b22;

  r[8]  = a20*b00 + a21*b10 + a22*b20;
  r[9]  = a20*b01 + a21*b11 + a22*b21;
  r[10] = a20*b02 + a21*b12 + a22*b22;

  r[3]  = a00*btx + a01*bty + a02*btz + atx;
  r[7]  = a10*btx + a11*bty + a12*btz + aty;
  r[11] = a20*btx + a21*bty + a22*btz + atz;

  return r;
}

describe("Mat34Pool (local/world + inverseWorld GPU mirror)", () => {
  test("initialization: root entry alive; local/world/inverse = identity", () => {
    const pool = new Mat34Pool(4);
    expect(pool.size).toBe(1);
    expect(pool.capacity).toBeGreaterThanOrEqual(4);
    expect(pool.root).toBe(0);

    const L0 = readLocal(pool, 0);
    const W0 = readWorld(pool, 0);
    const I0 = readInverseWorld(pool, 0);

    const eye = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0]);
    expect(Array.from(L0)).toEqual(Array.from(eye));
    expect(Array.from(W0)).toEqual(Array.from(eye));
    expect(Array.from(I0)).toEqual(Array.from(eye));
  });

  test("create/delete reuse and cannot remove root", () => {
    const pool = new Mat34Pool(2);
    const id1 = pool.create(); // 1
    const id2 = pool.create(); // 2 (or growth)
    expect(pool.size).toBe(3);

    pool.remove(id1);
    expect(pool.size).toBe(2);

    const id3 = pool.create();
    expect(id3).toBe(id1); // free-list reuse
    expect(pool.size).toBe(3);

    expect(() => pool.remove(pool.root)).toThrow();
  });

  test("setTranslation/addTranslation affect local and mark dirty; updateWorld clears dirty", () => {
    const pool = new Mat34Pool();
    const id = pool.create(true);

    // local starts identity
    expect(pool.isDirty(id)).toBe(true); // created alive & initialized → typically dirty
    pool.updateWorld(id, -1, false);     // compute world from local, don't care GPU
    expect(pool.isDirty(id)).toBe(false);

    pool.setTranslation(id, new Vector3(10, -5, 3));
    expect(pool.isDirty(id)).toBe(true);

    const { position: lp1 } = pool.getLocalTRS(id, "rad");
    expectVecClose(lp1, new Vector3(10, -5, 3));

    pool.addTranslation(id, new Vector3(1, 2, 3));
    const { position: lp2 } = pool.getLocalTRS(id, "rad");
    expectVecClose(lp2, new Vector3(11, -3, 6));
    expect(pool.isDirty(id)).toBe(true);

    // Propagate
    pool.updateWorld(id, -1, false);
    const { position: wp } = pool.getWorldTRS(id, "rad");
    expectVecClose(wp, new Vector3(11, -3, 6));
    expect(pool.isDirty(id)).toBe(false);
  });

  test("setFromTRS + getLocalTRS roundtrip; world matches local when parentId = -1", () => {
    const pool = new Mat34Pool();
    const id = pool.create(false);

    const position = new Vector3(3, -2, 5);
    const euler: EulerZYX = { yawZ: 30, pitchY: -12, rollX: 45, units: "deg" };
    pool.setFromTRS(id, position, euler);

    const { position: lp, euler: le } = pool.getLocalTRS(id, "deg");
    expectVecClose(lp, position, 1e-4);
    // Compare angular cos/sin (angle wrap tolerant)
    const cos = (d: number) => Math.cos(deg2rad(d));
    const sin = (d: number) => Math.sin(deg2rad(d));
    expect(close(cos(le.yawZ), cos(euler.yawZ))).toBe(true);
    expect(close(sin(le.yawZ), sin(euler.yawZ))).toBe(true);
    expect(close(cos(le.pitchY), cos(euler.pitchY))).toBe(true);
    expect(close(sin(le.pitchY), sin(euler.pitchY))).toBe(true);
    expect(close(cos(le.rollX), cos(euler.rollX))).toBe(true);
    expect(close(sin(le.rollX), sin(euler.rollX))).toBe(true);

    // Propagate to world with identity parent
    pool.updateWorld(id, -1, false);
    const { position: wp, euler: we } = pool.getWorldTRS(id, "deg");
    expectVecClose(wp, position, 1e-4);
    expect(close(cos(we.yawZ), cos(euler.yawZ))).toBe(true);
    expect(close(sin(we.yawZ), sin(euler.yawZ))).toBe(true);
    expect(close(cos(we.pitchY), cos(euler.pitchY))).toBe(true);
    expect(close(sin(we.pitchY), sin(euler.pitchY))).toBe(true);
    expect(close(cos(we.rollX), cos(euler.rollX))).toBe(true);
    expect(close(sin(we.rollX), sin(euler.rollX))).toBe(true);
  });

  test("addTRS composes onto local; world reflects composition after updateWorld", () => {
    const pool = new Mat34Pool();
    const id = pool.create(true);
    pool.updateWorld(id, -1, false);

    // Add delta TRS
    const dp = new Vector3(1, 2, 3);
    const de: EulerZYX = { yawZ: 0.25, pitchY: -0.1, rollX: 0.4, units: "rad" };
    pool.addTRS(id, dp, de);

    // World should become local (since parent = identity)
    pool.updateWorld(id, -1, false);

    const W = readWorld(pool, id);
    const p = new Vector3(0.3, -1.2, 2.5);
    const out = applyMatPoint(W, p); // just sanity: finite numbers
    expect(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z)).toBe(true);
  });

  test("updateWorld(child, parent) uses parent's world * child's local", () => {
    const pool = new Mat34Pool();
    const parent = pool.create(false);
    const child = pool.create(false);

    // Parent A
    pool.setFromTRS(parent, new Vector3(1, 0, 0), {
      yawZ: Math.PI / 2,
      pitchY: 0,
      rollX: 0,
      units: "rad",
    });

    // Child B (local)
    pool.setFromTRS(child, new Vector3(0, 2, 0), {
      yawZ: 0,
      pitchY: 0,
      rollX: 0,
      units: "rad",
    });

    pool.updateWorld(parent, -1, false);
    pool.updateWorld(child, parent, false);

    const Wp = readWorld(pool, parent);
    const Wc = readWorld(pool, child);

    const expected = mul3x4(Wp, readLocal(pool, child)); // A * B
    // Compare by transforming a point
    const p = new Vector3(1, 1, 0);
    const ref = applyMatPoint(expected, p);
    const got = applyMatPoint(Wc, p);
    expectVecClose(got, ref);
  });

  test("inverseWorld (gpu mirror) inverts the world transform (orthonormal case)", () => {
    const pool = new Mat34Pool();
    const id = pool.create(false);
    pool.setFromTRS(id, new Vector3(-3, 2, 1), {
      yawZ: 0.6, pitchY: -0.2, rollX: 0.4, units: "rad",
    });
    pool.updateWorld(id, -1, false);

    const W = readWorld(pool, id);
    const Inv = readInverseWorld(pool, id);

    const p = new Vector3(2, -1, 5);
    const fwd = applyMatPoint(W, p);
    const back = applyMatPoint(Inv, fwd);
    expectVecClose(back, p, 1e-4);

    // Directions should preserve length under rotation
    const v = new Vector3(1.5, -0.7, 0.2);
    const rv = applyMatDir(W, v);
    expect(close(rv.length(), v.length(), 1e-5)).toBe(true);
  });

  test("growth preserves local/world across reallocation", () => {
    const pool = new Mat34Pool(1);
    const idA = pool.create(true);
    pool.updateWorld(idA, -1, false);

    // Mutate local
    pool.setTranslation(idA, new Vector3(1, 2, 3));

    // Force growth
    const many: number[] = [];
    for (let i = 0; i < 50; i++) many.push(pool.create());

    // Propagate post-growth
    pool.updateWorld(idA, -1, false);

    const W = readWorld(pool, idA);
    const p = new Vector3(1, 1, 1);
    const out = applyMatPoint(W, p);
    expectVecClose(out, p.add(new Vector3(1, 2, 3)));
  });

  test("cloneFrom copies local/world and inverse mirror", () => {
    const pool = new Mat34Pool();
    const src = pool.create(false);
    pool.setFromTRS(src, new Vector3(4, 5, 6), {
      yawZ: 0.3, pitchY: -0.4, rollX: 0.7, units: "rad",
    });
    pool.updateWorld(src, -1, false);

    const clone = pool.cloneFrom(src);
    // No extra propagation needed: cloneFrom copied world & inverse mirror

    const Wsrc = readWorld(pool, src);
    const Wcln = readWorld(pool, clone);
    const Isrc = readInverseWorld(pool, src);
    const Icln = readInverseWorld(pool, clone);

    // Transform a point with each world
    const p = new Vector3(1, 2, 3);
    expectVecClose(applyMatPoint(Wsrc, p), applyMatPoint(Wcln, p));
    // And round-trip with inverse
    const fwd = applyMatPoint(Wcln, p);
    const back = applyMatPoint(Icln, fwd);
    expectVecClose(back, p, 1e-4);
  });

  test("getWorldTRS handles gimbal-lock (pitch ≈ +90°) by absorbing roll into yaw", () => {
    const pool = new Mat34Pool();
    const id = pool.create(false);

    const pitch = Math.PI / 2;
    const yaw = 0.7;
    const roll = -0.3;

    pool.setFromTRS(id, new Vector3(0, 0, 0), {
      yawZ: yaw, pitchY: pitch, rollX: roll, units: "rad",
    });
    pool.updateWorld(id, -1, false);

    const { euler: e } = pool.getWorldTRS(id, "rad");
    expect(Math.abs(e.pitchY - pitch)).toBeLessThan(1e-6);
    expect(Math.abs(e.rollX)).toBeLessThan(1e-6);

    // Rebuild from recovered angles and compare rotation effect on a direction
    const id2 = pool.create(false);
    pool.setFromTRS(id2, new Vector3(0, 0, 0), e);
    pool.updateWorld(id2, -1, false);

    const v = new Vector3(1.2, -0.7, 0.5);
    const r1 = applyMatDir(readWorld(pool, id), v);
    const r2 = applyMatDir(readWorld(pool, id2), v);
    expectVecClose(r1, r2);
  });
});

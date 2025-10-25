import { Mat34Pool } from "../src/pools/matrix";
import { Vector3, deg2rad, type EulerZYX } from "../src/utils/math";

const EPS = 1e-5;
const close = (a: number, b: number, eps = EPS) => Math.abs(a - b) <= eps;

function expectVecClose(a: Vector3, b: Vector3, eps = EPS) {
  expect(close(a.x, b.x, eps)).toBe(true);
  expect(close(a.y, b.y, eps)).toBe(true);
  expect(close(a.z, b.z, eps)).toBe(true);
}

describe("Mat34Pool", () => {
  test("initialization & root identity", () => {
    const pool = new Mat34Pool(4);
    expect(pool.size).toBe(1);
    expect(pool.capacity).toBeGreaterThanOrEqual(4);
    expect(pool.root).toBe(0);

    const p = new Vector3(1, 2, 3);
    const out = pool.transformPoint(pool.root, p);
    // identity should return same point
    expectVecClose(out, p);
  });

  test("create/delete, free-list reuse, and guard on root removal", () => {
    const pool = new Mat34Pool(2);
    const id1 = pool.create(); // 1
    const id2 = pool.create(); // growth or reuse
    expect(pool.size).toBe(3);

    pool.remove(id1);
    expect(pool.size).toBe(2);

    // Next allocation should reuse id1
    const id3 = pool.create();
    expect(id3).toBe(id1);
    expect(pool.size).toBe(3);

    // cannot remove root
    expect(() => pool.remove(pool.root)).toThrow();
  });

  test("set/get/add translation & transformPoint/Direction", () => {
    const pool = new Mat34Pool();
    const id = pool.create(true);

    pool.setTranslation(id, new Vector3(10, -5, 3));
    const t = pool.getTranslation(id);
    expectVecClose(t, new Vector3(10, -5, 3));

    pool.addTranslation(id, new Vector3(1, 2, 3));
    const t2 = pool.getTranslation(id);
    expectVecClose(t2, new Vector3(11, -3, 6));

    // With identity rotation, transforming a point = point + translation
    const p = new Vector3(2, 4, 6);
    const transformed = pool.transformPoint(id, p);
    expectVecClose(transformed, p.add(t2));

    // transformDirection shouldn't be affected by translation
    const d = new Vector3(1, 2, 3);
    const dirOut = pool.transformDirection(id, d);
    expectVecClose(dirOut, d); // identity rotation
  });

  test("setFromTRS & toTRS roundtrip", () => {
    const pool = new Mat34Pool();
    const id = pool.create(false);

    const position = new Vector3(3, -2, 5);
    const euler: EulerZYX = { yawZ: 30, pitchY: -12, rollX: 45, units: "deg" };
    pool.setFromTRS(id, position, euler);

    const { position: p2, euler: e2 } = pool.toTRS(id, "deg");
    expectVecClose(p2, position, 1e-4);
    // Angles can wrap; compare sin/cos rather than raw degrees
    const normalize = (deg: number) => {
      // bring to [-180, 180] to reduce wrap-around surprises
      let x = ((((deg + 180) % 360) + 360) % 360) - 180;
      return x;
    };
    expect(
      close(Math.cos(deg2rad(e2.yawZ)), Math.cos(deg2rad(euler.yawZ)))
    ).toBe(true);
    expect(
      close(Math.sin(deg2rad(e2.yawZ)), Math.sin(deg2rad(euler.yawZ)))
    ).toBe(true);

    expect(
      close(Math.cos(deg2rad(e2.pitchY)), Math.cos(deg2rad(euler.pitchY)))
    ).toBe(true);
    expect(
      close(Math.sin(deg2rad(e2.pitchY)), Math.sin(deg2rad(euler.pitchY)))
    ).toBe(true);

    expect(
      close(Math.cos(deg2rad(e2.rollX)), Math.cos(deg2rad(euler.rollX)))
    ).toBe(true);
    expect(
      close(Math.sin(deg2rad(e2.rollX)), Math.sin(deg2rad(euler.rollX)))
    ).toBe(true);

    // sanity on normalized degrees
    expect(Math.abs(normalize(e2.yawZ) - normalize(euler.yawZ))).toBeLessThan(
      1e-2
    );
    expect(
      Math.abs(normalize(e2.pitchY) - normalize(euler.pitchY))
    ).toBeLessThan(1e-2);
    expect(Math.abs(normalize(e2.rollX) - normalize(euler.rollX))).toBeLessThan(
      1e-2
    );
  });

  test("multiply, preMultiply, multiplyTo produce correct composition", () => {
    const pool = new Mat34Pool();
    const A = pool.create(true);
    const B = pool.create(true);
    const OUT = pool.create(true);

    // A: rotate Z=90deg (approx) + translate (1,0,0)
    pool.setFromTRS(A, new Vector3(1, 0, 0), {
      yawZ: Math.PI / 2,
      pitchY: 0,
      rollX: 0,
      units: "rad",
    });
    // B: translate (0, 2, 0)
    pool.setFromTRS(B, new Vector3(0, 2, 0), {
      yawZ: 0,
      pitchY: 0,
      rollX: 0,
      units: "rad",
    });

    // Compose expected: A * B
    pool.multiplyTo(A, B, OUT);

    // Apply separately to a point and compare with composed matrix
    const p = new Vector3(1, 1, 0);
    const pB = pool.transformPoint(B, p);
    const pAB_manual = pool.transformPoint(A, pB);
    const pAB_direct = pool.transformPoint(OUT, p);
    expectVecClose(pAB_direct, pAB_manual);

    // Check in-place multiply: A = A * B equals OUT result
    const Aclone = pool.cloneFrom(A);
    pool.multiply(Aclone, B);
    const pAB_inPlace = pool.transformPoint(Aclone, p);
    expectVecClose(pAB_inPlace, pAB_direct);

    // Check preMultiply: B * B (left) into B equals multiplyTo(B, B, B)
    const Bclone = pool.cloneFrom(B);
    pool.preMultiply(Bclone, B);
    const pBB = pool.transformPoint(Bclone, p);
    const B2 = pool.cloneFrom(B);
    pool.multiplyTo(B, B, B2);
    const pBB2 = pool.transformPoint(B2, p);
    expectVecClose(pBB, pBB2);
  });

  test("cloneFrom copies transform", () => {
    const pool = new Mat34Pool();
    const src = pool.create(false);
    pool.setFromTRS(src, new Vector3(4, 5, 6), {
      yawZ: 0.3,
      pitchY: -0.4,
      rollX: 0.7,
      units: "rad",
    });
    const clone = pool.cloneFrom(src);

    const v = new Vector3(1, 2, 3);
    const a = pool.transformPoint(src, v);
    const b = pool.transformPoint(clone, v);
    expectVecClose(a, b);
  });

  test("inverse (orthonormal fast path) inverts transform", () => {
    const pool = new Mat34Pool();
    const id = pool.create(false);
    pool.setFromTRS(id, new Vector3(-3, 2, 1), {
      yawZ: 0.6,
      pitchY: -0.2,
      rollX: 0.4,
      units: "rad",
    });

    const inv = pool.toInverse3x4(id, undefined, true); // assumeOrthonormal = true
    // Build a temp matrix from the 3x4 'inv' to apply it (by dropping into a fresh entry)
    const tmp = pool.create(false);
    const { gpuF32, GPU_STRIDE } = pool.getBufferViews();
    const b = tmp * GPU_STRIDE;
    for (let i = 0; i < 12; i++) gpuF32[b + i] = inv[i]!;
    // mark as alive is already true; content set above

    const p = new Vector3(2, -1, 5);
    const fwd = pool.transformPoint(id, p);
    const back = pool.transformPoint(tmp, fwd);
    expectVecClose(back, p, 1e-4);
  });

  test("inverse (general, non-orthonormal) falls back to full inverse", () => {
    const pool = new Mat34Pool();
    const id = pool.create(true);

    // Force a non-orthonormal linear part (scale X by 2, slight shear in XY)
    const { gpuF32, GPU_STRIDE } = pool.getBufferViews();
    const b = id * GPU_STRIDE;
    gpuF32[b + 0] = 2;
    gpuF32[b + 1] = 0.1;
    gpuF32[b + 2] = 0;
    gpuF32[b + 3] = 3;
    gpuF32[b + 4] = 0;
    gpuF32[b + 5] = 1.5;
    gpuF32[b + 6] = 0.2;
    gpuF32[b + 7] = -2;
    gpuF32[b + 8] = 0;
    gpuF32[b + 9] = 0;
    gpuF32[b + 10] = 1.2;
    gpuF32[b + 11] = 1;

    const inv = pool.toInverse3x4(id, undefined, false);

    const tmp = pool.create(false);
    const bb = tmp * GPU_STRIDE;
    for (let i = 0; i < 12; i++) gpuF32[bb + i] = inv[i]!;

    const p = new Vector3(0.7, -0.3, 2.1);
    const fwd = pool.transformPoint(id, p);
    const back = pool.transformPoint(tmp, fwd);
    expectVecClose(back, p, 1e-4);
  });

  test("growth preserves data", () => {
    const pool = new Mat34Pool(1);
    const idA = pool.create(true);
    pool.setTranslation(idA, new Vector3(1, 2, 3));

    // Trigger growth
    const many: number[] = [];
    for (let i = 0; i < 50; i++) many.push(pool.create());

    const p = new Vector3(1, 1, 1);
    const out = pool.transformPoint(idA, p);
    expectVecClose(out, p.add(new Vector3(1, 2, 3)));
  });


  test("toTRS handles gimbal-lock (pitch ≈ +90°) by absorbing roll into yaw", () => {
    const pool = new Mat34Pool();
    const id = pool.create(false);

    // pitch at exact +90°, so we hit the gimbal branch
    const pitch = Math.PI / 2;
    const yaw = 0.7;
    const roll = -0.3;

    pool.setFromTRS(id, new Vector3(0, 0, 0), {
      yawZ: yaw,
      pitchY: pitch,
      rollX: roll,
      units: "rad",
    });

    const { euler: e } = pool.toTRS(id, "rad");

    // Pitch is recovered; roll is conventionally set to 0 in gimbal; yaw may have absorbed roll.
    expect(Math.abs(e.pitchY - pitch)).toBeLessThan(1e-6);
    expect(Math.abs(e.rollX)).toBeLessThan(1e-6);

    // Reconstruct from recovered angles and compare the actual rotation effect.
    const id2 = pool.create(false);
    pool.setFromTRS(id2, new Vector3(0, 0, 0), e);

    const v = new Vector3(1.2, -0.7, 0.5);
    const r1 = pool.transformDirection(id, v);
    const r2 = pool.transformDirection(id2, v);

    const EPS = 1e-5;
    const close = (a: number, b: number) => Math.abs(a - b) <= EPS;
    const expectVecClose = (a: Vector3, b: Vector3) => {
      expect(close(a.x, b.x)).toBe(true);
      expect(close(a.y, b.y)).toBe(true);
      expect(close(a.z, b.z)).toBe(true);
    };

    expectVecClose(r1, r2);
  });

  test("multiplyTo supports aliasing out === a and out === b", () => {
    const pool = new Mat34Pool();
    const A = pool.create(false);
    const B = pool.create(false);
    const O = pool.create(false);

    pool.setFromTRS(A, new Vector3(1, 2, 3), {
      yawZ: 0.2,
      pitchY: -0.1,
      rollX: 0.4,
      units: "rad",
    });
    pool.setFromTRS(B, new Vector3(-2, 0.5, 1), {
      yawZ: -0.3,
      pitchY: 0.2,
      rollX: 0,
      units: "rad",
    });

    // Baseline
    pool.multiplyTo(A, B, O);
    const p = new Vector3(0.3, -1.2, 2.5);
    const ref = pool.transformPoint(O, p);

    // out === a
    const A1 = pool.cloneFrom(A);
    pool.multiplyTo(A1, B, A1);
    const r1 = pool.transformPoint(A1, p);
    expectVecClose(r1, ref);

    // out === b
    const B1 = pool.cloneFrom(B);
    pool.multiplyTo(A, B1, B1);
    const r2 = pool.transformPoint(B1, p);
    expectVecClose(r2, ref);
  });

  test("inverse fallback on singular R uses transpose and correct translation", () => {
    const pool = new Mat34Pool();
    const id = pool.create(true);

    // Make R singular: duplicate first two rows, keep a translation
    const { gpuF32, GPU_STRIDE } = pool.getBufferViews();
    const b = id * GPU_STRIDE;
    // Row0
    gpuF32[b + 0] = 1;
    gpuF32[b + 1] = 2;
    gpuF32[b + 2] = 3;
    gpuF32[b + 3] = 4;
    // Row1 = Row0 (singular)
    gpuF32[b + 4] = 1;
    gpuF32[b + 5] = 2;
    gpuF32[b + 6] = 3;
    gpuF32[b + 7] = -5;
    // Row2 arbitrary
    gpuF32[b + 8] = 0;
    gpuF32[b + 9] = 1;
    gpuF32[b + 10] = 0.5;
    gpuF32[b + 11] = 6;

    const inv = pool.toInverse3x4(id, undefined, false);

    // Expect "inverse" to be transpose fallback:
    // R^-1 ≈ R^T; t' = -R^T t
    const RT = [1, 1, 0, 2, 2, 1, 3, 3, 0.5];
    const t = [4, -5, 6];
    const tPrime = [
      -(RT[0] * t[0] + RT[1] * t[1] + RT[2] * t[2]),
      -(RT[3] * t[0] + RT[4] * t[1] + RT[5] * t[2]),
      -(RT[6] * t[0] + RT[7] * t[1] + RT[8] * t[2]),
    ];

    // Rows of 3x4 inverse should be RT with t'
    expect(
      close(inv[0], RT[0]) && close(inv[1], RT[1]) && close(inv[2], RT[2])
    ).toBe(true);
    expect(close(inv[3], tPrime[0])).toBe(true);
    expect(
      close(inv[4], RT[3]) && close(inv[5], RT[4]) && close(inv[6], RT[5])
    ).toBe(true);
    expect(close(inv[7], tPrime[1])).toBe(true);
    expect(
      close(inv[8], RT[6]) && close(inv[9], RT[7]) && close(inv[10], RT[8])
    ).toBe(true);
    expect(close(inv[11], tPrime[2])).toBe(true);
  });

  test("transformDirection preserves length for orthonormal rotations", () => {
    const pool = new Mat34Pool();
    const id = pool.create(false);
    pool.setFromTRS(id, new Vector3(7, -2, 4), {
      yawZ: 0.9,
      pitchY: -0.3,
      rollX: 0.2,
      units: "rad",
    });

    const v = new Vector3(3, -1, 2);
    const out = pool.transformDirection(id, v);
    expect(close(out.length(), v.length(), 1e-5)).toBe(true);
  });
});

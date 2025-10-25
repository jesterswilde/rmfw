import { Vector3, deg2rad, rad2deg, type EulerZYX } from "./math.js";

//Currently unused, may come back later.

export class Mat4 {
  /** Column-major storage to match WGSL (mat4x4<f32>): m[col*4 + row] */
  readonly m: Float32Array;

  constructor(data?: ArrayLike<number>) {
    this.m = new Float32Array(16);
    if (data) this.m.set(data);
    else Mat4.identityInto(this.m);
  }

  static identity(): Mat4 {
    return new Mat4();
  }

  static identityInto(out: Float32Array): Float32Array {
    out.fill(0);
    out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1;
    return out;
  }

  clone(): Mat4 {
    return new Mat4(this.m);
  }

  writeTo(out: Float32Array): void {
    out.set(this.m);
  }

  multiply(b: Mat4): this {
    const a = this.m; const bm = b.m;
    const r = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      const b0 = bm[c*4+0] as number, b1 = bm[c*4+1] as number, b2 = bm[c*4+2] as number, b3 = bm[c*4+3] as number;
      r[c*4+0] = a[0]!*b0 + a[4]!*b1 + a[8]!*b2  + a[12]!*b3;
      r[c*4+1] = a[1]!*b0 + a[5]!*b1 + a[9]!*b2  + a[13]!*b3;
      r[c*4+2] = a[2]!*b0 + a[6]!*b1 + a[10]!*b2 + a[14]!*b3;
      r[c*4+3] = a[3]!*b0 + a[7]!*b1 + a[11]!*b2 + a[15]!*b3;
    }
    this.m.set(r);
    return this;
  }

  setTranslation(p: Vector3): this {
    this.m[12] = p.x;
    this.m[13] = p.y;
    this.m[14] = p.z;
    this.m[15] = 1;
    return this;
  }

  addTranslation(dp: Vector3): this {
    this.m[12] = this.m[12]! + dp.x;
    this.m[13] = this.m[13]! + dp.y;
    this.m[14] = this.m[14]! + dp.z;
    return this;
  }

  static fromTranslation(p: Vector3): Mat4 {
    const out = new Mat4();
    out.setTranslation(p);
    return out;
  }

   /** this = a * this (pre-multiply) */
  preMultiply(a: Mat4): this {
    const am = a.m, b = this.m;
    const r = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      const b0 = b[c*4+0]!, b1 = b[c*4+1]!, b2 = b[c*4+2]!, b3 = b[c*4+3]!;
      r[c*4+0] = am[0]! * b0 + am[4]! * b1 + am[8]!  * b2 + am[12]! * b3;
      r[c*4+1] = am[1]! * b0 + am[5]! * b1 + am[9]!  * b2 + am[13]! * b3;
      r[c*4+2] = am[2]! * b0 + am[6]! * b1 + am[10]! * b2 + am[14]! * b3;
      r[c*4+3] = am[3]! * b0 + am[7]! * b1 + am[11]! * b2 + am[15]! * b3;
    }
    this.m.set(r);
    return this;
  }

  /** Rotate around a world-space axis (pre-multiply). */
  rotateWorldAxis(axis: Vector3, angleRad: number): this {
    const R = Mat4.fromAxisAngle(axis, angleRad);
    return this.preMultiply(R);
  }
  rotateAxisAngle(axis: Vector3, angleRad: number): this {
    const n = axis.normalize();
    const { x, y, z } = n;
    const c = Math.cos(angleRad), s = Math.sin(angleRad), t = 1 - c;
    const R = new Mat4([
      t*x*x + c,     t*x*y + s*z, t*x*z - s*y, 0,
      t*x*y - s*z,   t*y*y + c,   t*y*z + s*x, 0,
      t*x*z + s*y,   t*y*z - s*x, t*z*z + c,   0,
      0,             0,           0,           1,
    ]);
    return this.multiply(R);
  }
  static fromTRS(position: Vector3, euler: EulerZYX): Mat4 {
    const yawZ = euler.units === "deg" ? deg2rad(euler.yawZ) : euler.yawZ;
    const pitchY = euler.units === "deg" ? deg2rad(euler.pitchY) : euler.pitchY;
    const rollX = euler.units === "deg" ? deg2rad(euler.rollX) : euler.rollX;

    const cz = Math.cos(yawZ), sz = Math.sin(yawZ);
    const cy = Math.cos(pitchY), sy = Math.sin(pitchY);
    const cx = Math.cos(rollX), sx = Math.sin(rollX);

    const r00 = cz*cy;
    const r01 = cz*sy*sx + sz*cx;
    const r02 = cz*sy*cx - sz*sx;

    const r10 = -sz*cy;
    const r11 = -sz*sy*sx + cz*cx;
    const r12 = -sz*sy*cx - cz*sx;

    const r20 = -sy;
    const r21 = cy*sx;
    const r22 = cy*cx;

    return new Mat4([
      r00, r01, r02, 0,
      r10, r11, r12, 0,
      r20, r21, r22, 0,
      position.x, position.y, position.z, 1,
    ]);
  }

  toTRS(units: "rad" | "deg" = "rad"): { position: Vector3; euler: EulerZYX } {
    const m = this.m;
    const position = new Vector3(m[12] as number, m[13] as number, m[14] as number);

    const r20 = m[8] as number, r21 = m[9] as number, r22 = m[10] as number;
    let pitchY = Math.asin(-r20);
    let yawZ: number, rollX: number;
    const EPS = 1e-6;
    if (Math.abs(Math.cos(pitchY)) > EPS) {
      yawZ = Math.atan2(m[4] as number, m[0] as number);
      rollX = Math.atan2(r21, r22);
    } else {
      yawZ = Math.atan2(-(m[1] as number), m[5] as number);
      rollX = 0;
    }

    const euler: EulerZYX = units === "deg"
      ? { yawZ: rad2deg(yawZ), pitchY: rad2deg(pitchY), rollX: rad2deg(rollX), units: "deg" }
      : { yawZ, pitchY, rollX, units: "rad" };

    return { position, euler };
  }

  static fromAxisAngle(axis: Vector3, angleRad: number): Mat4 {
    return Mat4.identity().rotateAxisAngle(axis, angleRad);
  }
   /** Transforms a point (x,y,z,1) by this matrix, returning a NEW Vector3. */
  transformPoint(p: Vector3): Vector3 {
    const m = this.m;
    const x = p.x, y = p.y, z = p.z;
    const nx = m[0]! * x + m[4]! * y + m[8]!  * z + m[12]!;
    const ny = m[1]! * x + m[5]! * y + m[9]!  * z + m[13]!;
    const nz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    // For affine matrices in this class, w will be 1 so no divide needed.
    return new Vector3(nx, ny, nz);
  }

  /** Transforms a direction (x,y,z,0) by this matrix (ignores translation). */
  transformDirection(v: Vector3): Vector3 {
    const m = this.m;
    const x = v.x, y = v.y, z = v.z;
    const nx = m[0]! * x + m[4]! * y + m[8]!  * z;
    const ny = m[1]! * x + m[5]! * y + m[9]!  * z;
    const nz = m[2]! * x + m[6]! * y + m[10]! * z;
    return new Vector3(nx, ny, nz);
  }

  toInverse3x4(out?: Float32Array, assumeOrthonormal: boolean = false): Float32Array {
    const m = this.m;
    const o = out ?? new Float32Array(12);

    // Extract R (upper-left 3x3) and T (last column) from column-major Mat4.
    // Column-major means:
    //   [ m0  m4  m8  m12 ]
    //   [ m1  m5  m9  m13 ]
    //   [ m2  m6  m10 m14 ]
    //   [ m3  m7  m11 m15 ]
    const r00 = m[0]!,  r01 = m[4]!,  r02 = m[8]!;
    const r10 = m[1]!,  r11 = m[5]!,  r12 = m[9]!;
    const r20 = m[2]!,  r21 = m[6]!,  r22 = m[10]!;
    const tx  = m[12]!, ty  = m[13]!, tz  = m[14]!;

    let i00: number, i01: number, i02: number;
    let i10: number, i11: number, i12: number;
    let i20: number, i21: number, i22: number;

    if (assumeOrthonormal) {
      // R^-1 = R^T
      i00 = r00; i01 = r10; i02 = r20;
      i10 = r01; i11 = r11; i12 = r21;
      i20 = r02; i21 = r12; i22 = r22;
    } else {
      // General 3x3 inverse (adjugate / determinant)
      const c00 =  (r11*r22 - r12*r21);
      const c01 = -(r10*r22 - r12*r20);
      const c02 =  (r10*r21 - r11*r20);

      const c10 = -(r01*r22 - r02*r21);
      const c11 =  (r00*r22 - r02*r20);
      const c12 = -(r00*r21 - r01*r20);

      const c20 =  (r01*r12 - r02*r11);
      const c21 = -(r00*r12 - r02*r10);
      const c22 =  (r00*r11 - r01*r10);

      const det = r00*c00 + r01*c01 + r02*c02;

      // Guard against near-singular matrices
      const EPS = 1e-8;
      let invDet = 1.0 / det;
      if (!Number.isFinite(invDet) || Math.abs(det) < EPS) {
        // Fallback: assume orthonormal if the general inverse is unstable
        invDet = 1.0;
        i00 = r00; i01 = r10; i02 = r20;
        i10 = r01; i11 = r11; i12 = r21;
        i20 = r02; i21 = r12; i22 = r22;
      } else {
        // Adjugate^T * (1/det) gives the inverse rows
        i00 = c00 * invDet; i01 = c10 * invDet; i02 = c20 * invDet;
        i10 = c01 * invDet; i11 = c11 * invDet; i12 = c21 * invDet;
        i20 = c02 * invDet; i21 = c12 * invDet; i22 = c22 * invDet;
      }
    }

    // Compute inverse translation: -R^-1 * T
    const itx = -(i00*tx + i01*ty + i02*tz);
    const ity = -(i10*tx + i11*ty + i12*tz);
    const itz = -(i20*tx + i21*ty + i22*tz);

    // Write rows to output (row-major 3x4)
    o[0]  = i00; o[1]  = i01; o[2]  = i02; o[3]  = itx;
    o[4]  = i10; o[5]  = i11; o[6]  = i12; o[7]  = ity;
    o[8]  = i20; o[9]  = i21; o[10] = i22; o[11] = itz;

    return o;
  }
}
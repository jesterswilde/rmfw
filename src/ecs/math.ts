// src/ecs/math.ts
// Centralized math helpers for 3x4 rigid transforms and generic 4x4 inversion (row-major).
// All helpers are allocation-light and typed-array oriented.

export const ORTHONORMAL_EPS = 1e-4;

/** Dot/cross-free orthonormal check on column vectors of a 3x3. */
export function isOrthonormal3x3(
  r00:number,r01:number,r02:number,
  r10:number,r11:number,r12:number,
  r20:number,r21:number,r22:number
): boolean {
  // Columns of the linear part (world basis)
  const c0x=r00, c0y=r10, c0z=r20;
  const c1x=r01, c1y=r11, c1z=r21;
  const c2x=r02, c2y=r12, c2z=r22;

  const d01 = c0x*c1x + c0y*c1y + c0z*c1z;
  const d02 = c0x*c2x + c0y*c2y + c0z*c2z;
  const d12 = c1x*c2x + c1y*c2y + c1z*c2z;

  const n0 = c0x*c0x + c0y*c0y + c0z*c0z;
  const n1 = c1x*c1x + c1y*c1y + c1z*c1z;
  const n2 = c2x*c2x + c2y*c2y + c2z*c2z;

  return Math.abs(d01) < ORTHONORMAL_EPS &&
         Math.abs(d02) < ORTHONORMAL_EPS &&
         Math.abs(d12) < ORTHONORMAL_EPS &&
         Math.abs(n0 - 1) < ORTHONORMAL_EPS &&
         Math.abs(n1 - 1) < ORTHONORMAL_EPS &&
         Math.abs(n2 - 1) < ORTHONORMAL_EPS;
}

/** out := A * B, where each is a rigid 3x4 (R|t), row-major.
 *  A = [ar* | at], B = [br* | bt]
 */
export function mulRigid3x4_into(
  ar00:number, ar01:number, ar02:number, atx:number,
  ar10:number, ar11:number, ar12:number, aty:number,
  ar20:number, ar21:number, ar22:number, atz:number,
  br00:number, br01:number, br02:number, btx:number,
  br10:number, br11:number, br12:number, bty:number,
  br20:number, br21:number, br22:number, btz:number,
  out: Float32Array
) {
  out[0]  = ar00*br00 + ar01*br10 + ar02*br20;
  out[1]  = ar00*br01 + ar01*br11 + ar02*br21;
  out[2]  = ar00*br02 + ar01*br12 + ar02*br22;
  out[3]  = ar00*btx  + ar01*bty  + ar02*btz  + atx;

  out[4]  = ar10*br00 + ar11*br10 + ar12*br20;
  out[5]  = ar10*br01 + ar11*br11 + ar12*br21;
  out[6]  = ar10*br02 + ar11*br12 + ar12*br22;
  out[7]  = ar10*btx  + ar11*bty  + ar12*btz  + aty;

  out[8]  = ar20*br00 + ar21*br10 + ar22*br20;
  out[9]  = ar20*br01 + ar21*br11 + ar22*br21;
  out[10] = ar20*br02 + ar21*br12 + ar22*br22;
  out[11] = ar20*btx  + ar21*bty  + ar22*btz  + atz;
}

/** Inverse of a rigid 3x4 (R|t) with R orthonormal: inv = (R^T | -R^T t). */
export function inverseRigid3x4_into(
  r00:number,r01:number,r02:number, tx:number,
  r10:number,r11:number,r12:number, ty:number,
  r20:number,r21:number,r22:number, tz:number,
  out: Float32Array
) {
  const ir00 = r00, ir01 = r10, ir02 = r20;
  const ir10 = r01, ir11 = r11, ir12 = r21;
  const ir20 = r02, ir21 = r12, ir22 = r22;

  const itx = -(ir00*tx + ir01*ty + ir02*tz);
  const ity = -(ir10*tx + ir11*ty + ir12*tz);
  const itz = -(ir20*tx + ir21*ty + ir22*tz);

  out[0]=ir00; out[1]=ir01; out[2]=ir02; out[3]=itx;
  out[4]=ir10; out[5]=ir11; out[6]=ir12; out[7]=ity;
  out[8]=ir20; out[9]=ir21; out[10]=ir22; out[11]=itz;
}

/** Generic inverse for a 3x4 affine (extends to 4x4, inverts, slices back to 3x4). */
export function inverseGeneral3x4_into(
  r00:number,r01:number,r02:number, tx:number,
  r10:number,r11:number,r12:number, ty:number,
  r20:number,r21:number,r22:number, tz:number,
  out: Float32Array
) {
  // Build 4x4 (row-major)
  const m = new Float32Array(16);
  m[0]=r00; m[1]=r01; m[2]=r02; m[3]=tx;
  m[4]=r10; m[5]=r11; m[6]=r12; m[7]=ty;
  m[8]=r20; m[9]=r21; m[10]=r22; m[11]=tz;
  m[12]=0;  m[13]=0;  m[14]=0;   m[15]=1;

  const inv = new Float32Array(16);
  invert4x4_into(m, inv);

  // First 3 rows (3x4)
  out[0]=inv[0]!;  out[1]=inv[1]!;  out[2]=inv[2]!;  out[3]=inv[3]!;
  out[4]=inv[4]!;  out[5]=inv[5]!;  out[6]=inv[6]!;  out[7]=inv[7]!;
  out[8]=inv[8]!;  out[9]=inv[9]!;  out[10]=inv[10]!; out[11]=inv[11]!;
}

/** In-place Gauss–Jordan 4x4 inversion (row-major). Writes inverse into `out`. Throws if singular. */
export function invert4x4_into(a: Float32Array, out: Float32Array) {
  const m = new Float32Array(16); m.set(a);
  const inv = new Float32Array(16);
  inv[0]=1; inv[5]=1; inv[10]=1; inv[15]=1;

  for (let col=0; col<4; col++) {
    // Pivot
    let pivot = col, maxAbs = Math.abs(m[col*4+col]!);
    for (let r=col+1; r<4; r++) {
      const v = Math.abs(m[r*4+col]!);
      if (v > maxAbs) { maxAbs = v; pivot = r; }
    }
    if (maxAbs < 1e-12) throw new Error("Singular matrix");

    // Swap rows if needed
    if (pivot !== col) {
      for (let c=0; c<4; c++) {
        const t = m[col*4+c]!; m[col*4+c] = m[pivot*4+c]!; m[pivot*4+c] = t;
        const t2 = inv[col*4+c]!; inv[col*4+c] = inv[pivot*4+c]!; inv[pivot*4+c] = t2;
      }
    }

    // Normalize pivot row
    const d = m[col*4+col]!;
    for (let c=0; c<4; c++) {
      m[col*4+c]   = m[col*4+c]!   / d;
      inv[col*4+c] = inv[col*4+c]! / d;
    }

    // Eliminate other rows
    for (let r=0; r<4; r++) if (r !== col) {
      const f = m[r*4+col]!;
      if (f === 0) continue;
      for (let c=0; c<4; c++) {
        m[r*4+c]   = m[r*4+c]!   - f * m[col*4+c]!;
        inv[r*4+c] = inv[r*4+c]! - f * inv[col*4+c]!;
      }
    }
  }
  out.set(inv);
}

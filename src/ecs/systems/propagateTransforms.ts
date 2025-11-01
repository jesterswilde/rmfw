// src/ecs/systems/propagateTransforms.ts

import { World } from "../core/index.js";
import { TransformMeta, TransformNodeMeta } from "../core/registry.js";

const NONE = -1;
const ORTHONORMAL_EPS = 1e-4;
const START_STACK_SIZE = 64;

// Workspace can be kept and reused across frames
export class PropagateWorkspace {
  // Node index stack
  nodeStack = new Int32Array(START_STACK_SIZE);
  // Parent world rows for each stack depth (3x4)
  pr00 = new Float32Array(START_STACK_SIZE);
  pr01 = new Float32Array(START_STACK_SIZE);
  pr02 = new Float32Array(START_STACK_SIZE);
  ptx  = new Float32Array(START_STACK_SIZE);
  pr10 = new Float32Array(START_STACK_SIZE);
  pr11 = new Float32Array(START_STACK_SIZE);
  pr12 = new Float32Array(START_STACK_SIZE);
  pty  = new Float32Array(START_STACK_SIZE);
  pr20 = new Float32Array(START_STACK_SIZE);
  pr21 = new Float32Array(START_STACK_SIZE);
  pr22 = new Float32Array(START_STACK_SIZE);
  ptz  = new Float32Array(START_STACK_SIZE);

  // Dirty depth counter per stack level (0/1 encoding)
  dirtyDepth = new Int32Array(64);

  // Identity parent cached
  id_r00 = 1; id_r01 = 0; id_r02 = 0; id_tx = 0;
  id_r10 = 0; id_r11 = 1; id_r12 = 0; id_ty = 0;
  id_r20 = 0; id_r21 = 0; id_r22 = 1; id_tz = 0;

  ensure(depthNeeded: number) {
    const need = depthNeeded | 0;
    const grow = (arr: any, ctor: any) => {
      let n = arr.length;
      while (n <= need)
        n = Math.max(2, n << 1);
      const next = new ctor(n);
      next.set(arr);
      return next;
    };
    if (need > this.nodeStack.length) {
      this.nodeStack = grow(this.nodeStack, Int32Array);
      this.pr00 = grow(this.pr00, Float32Array);
      this.pr01 = grow(this.pr01, Float32Array);
      this.pr02 = grow(this.pr02, Float32Array);
      this.ptx  = grow(this.ptx,  Float32Array);
      this.pr10 = grow(this.pr10, Float32Array);
      this.pr11 = grow(this.pr11, Float32Array);
      this.pr12 = grow(this.pr12, Float32Array);
      this.pty  = grow(this.pty,  Float32Array);
      this.pr20 = grow(this.pr20, Float32Array);
      this.pr21 = grow(this.pr21, Float32Array);
      this.pr22 = grow(this.pr22, Float32Array);
      this.ptz  = grow(this.ptz,  Float32Array);
      this.dirtyDepth = grow(this.dirtyDepth, Int32Array);
    }
  }
}

export function propagateTransforms(world: World, workspace?: PropagateWorkspace) {
  const ws = workspace ?? new PropagateWorkspace();

  // StoreView (read/write fields safely)
  const transformStore = world.storeOf(TransformMeta);
  const nodeStore = world.storeOf(TransformNodeMeta);
  // RAW store for epoch bump (StoreView.storeEpoch is getter-only)
  const transformRaw = world.store(TransformMeta.name);

  const tf = transformStore.fields();
  const nf = nodeStore.fields();

  const l00 = tf.local_r00, l01 = tf.local_r01, l02 = tf.local_r02, ltx = tf.local_tx;
  const l10 = tf.local_r10, l11 = tf.local_r11, l12 = tf.local_r12, lty = tf.local_ty;
  const l20 = tf.local_r20, l21 = tf.local_r21, l22 = tf.local_r22, ltz = tf.local_tz;

  const w00 = tf.world_r00, w01 = tf.world_r01, w02 = tf.world_r02, wtx = tf.world_tx;
  const w10 = tf.world_r10, w11 = tf.world_r11, w12 = tf.world_r12, wty = tf.world_ty;
  const w20 = tf.world_r20, w21 = tf.world_r21, w22 = tf.world_r22, wtz = tf.world_tz;

  const iv00 = tf.inv_r00, iv01 = tf.inv_r01, iv02 = tf.inv_r02, ivtx = tf.inv_tx;
  const iv10 = tf.inv_r10, iv11 = tf.inv_r11, iv12 = tf.inv_r12, ivty = tf.inv_ty;
  const iv20 = tf.inv_r20, iv21 = tf.inv_r21, iv22 = tf.inv_r22, ivtz = tf.inv_tz;

  const dirtyCol = tf.dirty as Int32Array;
  const rowVersion = transformStore.rowVersion;

  // 1) Collect roots (parent == NONE), deterministic ascending entity id
  const roots: number[] = [];
  for (let denseI = 0; denseI < nodeStore.size; denseI++) {
    const entity = nodeStore.denseToEntity[denseI]!;
    const row = nodeStore.denseIndexOf(entity)!;
    if (nf.parent[row]! === NONE) roots.push(entity);
  }
  roots.sort((a, b) => a - b);

  // 2) DFS using enter/leave with an explicit isPopping flag — no reverse child sweeps
  for (let rI = 0; rI < roots.length; rI++) {
    let stackTop = 0;
    ws.ensure(stackTop);

    // Seed stack with root
    ws.nodeStack[stackTop] = roots[rI]!;
    ws.pr00[stackTop] = ws.id_r00; ws.pr01[stackTop] = ws.id_r01; ws.pr02[stackTop] = ws.id_r02; ws.ptx[stackTop] = ws.id_tx;
    ws.pr10[stackTop] = ws.id_r10; ws.pr11[stackTop] = ws.id_r11; ws.pr12[stackTop] = ws.id_r12; ws.pty[stackTop] = ws.id_ty;
    ws.pr20[stackTop] = ws.id_r20; ws.pr21[stackTop] = ws.id_r21; ws.pr22[stackTop] = ws.id_r22; ws.ptz[stackTop] = ws.id_tz;
    ws.dirtyDepth[stackTop] = 0;

    let isPopping = false;

    while (stackTop >= 0) {
      const nodeEntity = ws.nodeStack[stackTop]!;
      const nodeRow = nodeStore.denseIndexOf(nodeEntity)!;

      const parent_r00 = ws.pr00[stackTop]!, parent_r01 = ws.pr01[stackTop]!, parent_r02 = ws.pr02[stackTop]!, parent_tx = ws.ptx[stackTop]!;
      const parent_r10 = ws.pr10[stackTop]!, parent_r11 = ws.pr11[stackTop]!, parent_r12 = ws.pr12[stackTop]!, parent_ty = ws.pty[stackTop]!;
      const parent_r20 = ws.pr20[stackTop]!, parent_r21 = ws.pr21[stackTop]!, parent_r22 = ws.pr22[stackTop]!, parent_tz = ws.ptz[stackTop]!;
      const parentDirtyDepth = ws.dirtyDepth[stackTop]!;

      if (!isPopping) {
        // --- ENTER NODE ---
        const tRow = transformStore.denseIndexOf(nodeEntity);
        const ancestorDirty = parentDirtyDepth > 0;
        let selfDirty = false;

        // Compute this node's world if it has a transform
        let cur_r00 = parent_r00, cur_r01 = parent_r01, cur_r02 = parent_r02, cur_tx = parent_tx;
        let cur_r10 = parent_r10, cur_r11 = parent_r11, cur_r12 = parent_r12, cur_ty = parent_ty;
        let cur_r20 = parent_r20, cur_r21 = parent_r21, cur_r22 = parent_r22, cur_tz = parent_tz;

        if (tRow >= 0) {
          selfDirty = dirtyCol[tRow]! > 0;
          const isDirty = ancestorDirty || selfDirty;

          if (isDirty) {
            // world = parent.world × local
            mulRigid3x4_into(
              parent_r00, parent_r01, parent_r02, parent_tx,
              parent_r10, parent_r11, parent_r12, parent_ty,
              parent_r20, parent_r21, parent_r22, parent_tz,
              l00[tRow]!, l01[tRow]!, l02[tRow]!, ltx[tRow]!,
              l10[tRow]!, l11[tRow]!, l12[tRow]!, lty[tRow]!,
              l20[tRow]!, l21[tRow]!, l22[tRow]!, ltz[tRow]!,
              tempMulOut
            );
            cur_r00 = tempMulOut[0]!; cur_r01 = tempMulOut[1]!; cur_r02 = tempMulOut[2]!; cur_tx = tempMulOut[3]!;
            cur_r10 = tempMulOut[4]!; cur_r11 = tempMulOut[5]!; cur_r12 = tempMulOut[6]!; cur_ty = tempMulOut[7]!;
            cur_r20 = tempMulOut[8]!; cur_r21 = tempMulOut[9]!; cur_r22 = tempMulOut[10]!; cur_tz = tempMulOut[11]!;

            // write world
            w00[tRow] = cur_r00; w01[tRow] = cur_r01; w02[tRow] = cur_r02; wtx[tRow] = cur_tx;
            w10[tRow] = cur_r10; w11[tRow] = cur_r11; w12[tRow] = cur_r12; wty[tRow] = cur_ty;
            w20[tRow] = cur_r20; w21[tRow] = cur_r21; w22[tRow] = cur_r22; wtz[tRow] = cur_tz;

            // inverse
            if (isOrthonormal3x3(cur_r00,cur_r01,cur_r02, cur_r10,cur_r11,cur_r12, cur_r20,cur_r21,cur_r22)) {
              inverseRigid3x4_into(cur_r00,cur_r01,cur_r02,cur_tx, cur_r10,cur_r11,cur_r12,cur_ty, cur_r20,cur_r21,cur_r22,cur_tz, tempInvOut);
            } else {
              inverseGeneral3x4_into(cur_r00,cur_r01,cur_r02,cur_tx, cur_r10,cur_r11,cur_r12,cur_ty, cur_r20,cur_r21,cur_r22,cur_tz, tempInvOut);
            }
            iv00[tRow] = tempInvOut[0]!; iv01[tRow] = tempInvOut[1]!; iv02[tRow] = tempInvOut[2]!; ivtx[tRow] = tempInvOut[3]!;
            iv10[tRow] = tempInvOut[4]!; iv11[tRow] = tempInvOut[5]!; iv12[tRow] = tempInvOut[6]!; ivty[tRow] = tempInvOut[7]!;
            iv20[tRow] = tempInvOut[8]!; iv21[tRow] = tempInvOut[9]!; iv22[tRow] = tempInvOut[10]!; ivtz[tRow] = tempInvOut[11]!;

            // clear & bump
            dirtyCol[tRow] = 0;
            rowVersion[tRow] = (rowVersion[tRow]! + 1) >>> 0;
            // FIX: bump epoch on the RAW store (not on the StoreView getter)
            transformRaw.storeEpoch++;
          } else {
            // Use existing world values to carry to children
            cur_r00 = w00[tRow]!, cur_r01 = w01[tRow]!, cur_r02 = w02[tRow]!, cur_tx = wtx[tRow]!;
            cur_r10 = w10[tRow]!, cur_r11 = w11[tRow]!, cur_r12 = w12[tRow]!, cur_ty = wty[tRow]!;
            cur_r20 = w20[tRow]!, cur_r21 = w21[tRow]!, cur_r22 = w22[tRow]!, cur_tz = wtz[tRow]!;
          }
        }

        // Descend to first child if any
        const firstChildEntity = nf.firstChild[nodeRow]!;
        if (firstChildEntity !== NONE) {
          // Prepare child level
          const nextTop = stackTop + 1;
          ws.ensure(nextTop);

          ws.nodeStack[nextTop] = firstChildEntity;

          ws.pr00[nextTop] = (tRow >= 0) ? cur_r00 : parent_r00;
          ws.pr01[nextTop] = (tRow >= 0) ? cur_r01 : parent_r01;
          ws.pr02[nextTop] = (tRow >= 0) ? cur_r02 : parent_r02;
          ws.ptx [nextTop] = (tRow >= 0) ? cur_tx  : parent_tx;

          ws.pr10[nextTop] = (tRow >= 0) ? cur_r10 : parent_r10;
          ws.pr11[nextTop] = (tRow >= 0) ? cur_r11 : parent_r11;
          ws.pr12[nextTop] = (tRow >= 0) ? cur_r12 : parent_r12;
          ws.pty [nextTop] = (tRow >= 0) ? cur_ty  : parent_ty;

          ws.pr20[nextTop] = (tRow >= 0) ? cur_r20 : parent_r20;
          ws.pr21[nextTop] = (tRow >= 0) ? cur_r21 : parent_r21;
          ws.pr22[nextTop] = (tRow >= 0) ? cur_r22 : parent_r22;
          ws.ptz [nextTop] = (tRow >= 0) ? cur_tz  : parent_tz;

          const inc = (ancestorDirty || selfDirty) ? 1 : 0;
          ws.dirtyDepth[nextTop] = parentDirtyDepth + inc;

          // Stay in ENTER state for child
          stackTop = nextTop;
          isPopping = false;
          continue;
        }

        // No children → switch to LEAVE
        isPopping = true;
        continue;
      } else {
        // --- LEAVE NODE ---
        const siblingEntity = nf.nextSibling[nodeRow]!;
        if (siblingEntity !== NONE) {
          // Replace current node with sibling; parent context at this depth stays the same
          ws.nodeStack[stackTop] = siblingEntity;
          isPopping = false; // we'll enter the sibling next
          continue;
        }

        // No sibling → pop up one level
        stackTop--;
        // Loop continues; parent world/dirtiness already at new top
      }
    }
  }
}

// ---------- math helpers (in-place / temp buffers to avoid allocs) ----------
const tempMulOut = new Float32Array(12);
const tempInvOut = new Float32Array(12);

function mulRigid3x4_into(
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

function isOrthonormal3x3(
  r00:number,r01:number,r02:number,
  r10:number,r11:number,r12:number,
  r20:number,r21:number,r22:number
): boolean {
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

function inverseRigid3x4_into(
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

function inverseGeneral3x4_into(
  r00:number,r01:number,r02:number, tx:number,
  r10:number,r11:number,r12:number, ty:number,
  r20:number,r21:number,r22:number, tz:number,
  out: Float32Array
) {
  // Extend to 4x4, invert, then write first 3 rows of inverse
  const m = [
    r00, r01, r02, tx,
    r10, r11, r12, ty,
    r20, r21, r22, tz,
    0,   0,   0,   1,
  ];
  const inv = invert4x4(m);
  out[0]=inv[0]!; out[1]=inv[1]!; out[2]=inv[2]!; out[3]=inv[3]!;
  out[4]=inv[4]!; out[5]=inv[5]!; out[6]=inv[6]!; out[7]=inv[7]!;
  out[8]=inv[8]!; out[9]=inv[9]!; out[10]=inv[10]!; out[11]=inv[11]!;
}

function invert4x4(a0: number[]): number[] {
  const a = a0.slice(0);
  const inv = [1,0,0,0,  0,1,0,0,  0,0,1,0,  0,0,0,1];
  for (let col=0; col<4; col++) {
    let pivot = col, maxAbs = Math.abs(a[col*4+col]!);
    for (let r=col+1; r<4; r++) {
      const v = Math.abs(a[r*4+col]!);
      if (v > maxAbs) { maxAbs = v; pivot = r; }
    }
    if (maxAbs < 1e-12) throw new Error("Singular matrix");
    if (pivot !== col) {
      for (let c=0; c<4; c++) {
        const t = a[col*4+c]!; a[col*4+c] = a[pivot*4+c]!; a[pivot*4+c] = t;
        const t2 = inv[col*4+c]!; inv[col*4+c] = inv[pivot*4+c]!; inv[pivot*4+c] = t2;
      }
    }
    const d = a[col*4+col]!;
    for (let c=0; c<4; c++) { a[col*4+c]! /= d; inv[col*4+c]! /= d; }
    for (let r=0; r<4; r++) if (r!==col) {
      const f = a[r*4+col]!;
      if (f===0) continue;
      for (let c=0; c<4; c++) {
        a[r*4+c]! -= f * a[col*4+c]!;
        inv[r*4+c]! -= f * inv[col*4+c]!;
      }
    }
  }
  return inv;
}

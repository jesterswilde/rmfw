// Layout (row-major 3x4):
// [ r00 r01 r02 tx
//   r10 r11 r12 ty
//   r20 r21 r22 tz ]
// GPU: 12 f32 lanes per entry (inverseWorld).
// Meta per entry (32-bit lanes): STATUS(i32), DIRTY(i32), LOCAL(12 f32), WORLD(12 f32)

import { deg2rad, Vector3, type EulerZYX } from "../utils/math.js";

export class Mat34Pool {
  static readonly Layout = {
    G: {
      R00: 0, R01: 1, R02: 2, TX: 3,
      R10: 4, R11: 5, R12: 6, TY: 7,
      R20: 8, R21: 9, R22: 10, TZ: 11
    },
    GPU_LANES: 12,
    BYTES_PER_GPU: 12 * 4,

    // META: two i32 + two 3x4 f32 blocks
    M: {
      STATUS: 0,
      DIRTY: 1,
      LOCAL_START: 2,
      L: { // Local matrix offsets relative to F32_BASE
        R00: 2,  R01: 3,  R02: 4,  TX: 5,
        R10: 6,  R11: 7,  R12: 8,  TY: 9,
        R20: 10, R21: 11, R22: 12, TZ: 13
      },
      WORLD_START: 14,
      W: { // World matrix offsets relative to F32_BASE + 12
        R00: 14+0, R01: 14+1, R02: 14+2, TX: 14+3,
        R10: 14+4, R11: 14+5, R12: 14+6, TY: 14+7,
        R20: 14+8, R21: 14+9, R22: 14+10, TZ:14+11
      }
    },
    META_LANES: 2 + 12 + 12, // 26 lanes of 32-bit values
    BYTES_PER_META: (2 + 12 + 12) * 4,
  } as const;

  private static readonly SENTINEL = -1;

  // CPU-side GPU mirror (inverseWorld)
  private _gpuMirrorBuffer: ArrayBuffer;
  private _gpuF32: Float32Array;

  // CPU-only meta (status/dirty/local/world) — single buffer, dual views
  private _metaBuffer: ArrayBuffer;
  private _metaI32: Int32Array;   // whole meta as i32 lanes
  private _metaF32: Float32Array; // whole meta as f32 lanes

  private _capacity: number;
  private _count: number;

  // GPU device/buffer
  private _device: GPUDevice | null = null;
  private _gpuBuffer: GPUBuffer | null = null;
  private _version = 0;
  private _freeHead = -1;

  constructor(initialCapacity = 256) {
    if (initialCapacity < 1) initialCapacity = 1;
    this._capacity = initialCapacity;

    this._gpuMirrorBuffer = new ArrayBuffer(this._capacity * Mat34Pool.Layout.BYTES_PER_GPU);
    this._gpuF32 = new Float32Array(this._gpuMirrorBuffer);

    this._metaBuffer = new ArrayBuffer(this._capacity * Mat34Pool.Layout.BYTES_PER_META);
    this._metaI32 = new Int32Array(this._metaBuffer);
    this._metaF32 = new Float32Array(this._metaBuffer); // shared underlying buffer

    this._count = 0;
    this._freeHead = Mat34Pool.SENTINEL;

    // Init free list for ids [1..cap-1]
    for (let id = this._capacity - 1; id >= 1; id--) {
      // zero GPU inverse (not strictly needed)
      const gi = id * Mat34Pool.Layout.GPU_LANES;
      for (let i = 0; i < Mat34Pool.Layout.GPU_LANES; i++) this._gpuF32[gi + i] = 0;

      // meta: STATUS = encoded next, DIRTY=0, zero local/world
      const mb = id * Mat34Pool.Layout.META_LANES;
      this._metaI32[mb + Mat34Pool.Layout.M.STATUS] = this.encodeNextFree(this._freeHead);
      this._metaI32[mb + Mat34Pool.Layout.M.DIRTY] = 0;

      const fb = mb + Mat34Pool.Layout.M.LOCAL_START;
      for (let i = 0; i < 24; i++) this._metaF32[fb + i] = 0;
      this._freeHead = id;
    }

    // Root 0: alive; local=I; world=I; inverseWorld=I
    this.initEntryAlive(0);
    this._count = 1;
  }

  get size() { return this._count; }
  get capacity() { return this._capacity; }
  get root() { return 0; }
  get version() { return this._version; }

  /** Views (modern + legacy aliases). */
  getBufferViews() {
    return {
      gpuMirrorBuffer: this._gpuMirrorBuffer, // inverseWorld buffer
      gpuF32: this._gpuF32,
      GPU_STRIDE: Mat34Pool.Layout.GPU_LANES,

      metaBuffer: this._metaBuffer,
      metaI32: this._metaI32,
      metaF32: this._metaF32,
      META_STRIDE: Mat34Pool.Layout.META_LANES,
      META_LOCAL_OFFSET: Mat34Pool.Layout.M.LOCAL_START,
      META_WORLD_OFFSET: Mat34Pool.Layout.M.WORLD_START,
    };
  }

  getGPUBuffer(){ return this._gpuBuffer; }

  /** Create a GPUBuffer, upload all inverseWorld, store it, and bump version. */
  createGPUBuffer(
    device: GPUDevice,
    usage: GPUBufferUsageFlags = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  ): GPUBuffer {
    this._device = device;
    if (this._gpuBuffer) { try { this._gpuBuffer.destroy(); } catch {} this._gpuBuffer = null; }
    const size = Math.max(16, this._capacity * Mat34Pool.Layout.BYTES_PER_GPU);
    this._gpuBuffer = device.createBuffer({ size, usage, mappedAtCreation: false });
    this.writeAllToGPU(); // pushes inverseWorld for all entries
    this._version++;
    return this._gpuBuffer;
  }

  /** Upload entire inverseWorld mirror buffer. */
  writeAllToGPU(): void {
    if (!this._device || !this._gpuBuffer) return;
    this._device.queue.writeBuffer(this._gpuBuffer, 0, this._gpuMirrorBuffer);
  }

  writeRangeToGPU(startID: number, endID: number){
    const byteOffset = startID * Mat34Pool.Layout.BYTES_PER_GPU;
    const bytes = new Uint8Array(this._gpuMirrorBuffer, byteOffset, (startID - endID + 1) * Mat34Pool.Layout.BYTES_PER_GPU);
  }
  /** Upload a single inverseWorld. */
  private writeInverseToGPU(id: number): void {
    if (!this._device || !this._gpuBuffer) return;
    const byteOffset = id * Mat34Pool.Layout.BYTES_PER_GPU;
    const bytes = new Uint8Array(this._gpuMirrorBuffer, byteOffset, Mat34Pool.Layout.BYTES_PER_GPU);
    this._device.queue.writeBuffer(this._gpuBuffer, byteOffset, bytes);
  }

  // ===== Allocation / lifetime =====

  create(identity = true, writeToGPU = false): number {
    const id = this.allocSlot();
    if (identity) {
      this.setLocalIdentity_(id);
      this.setWorldIdentity_(id);
      this.setInverseIdentity_(id);
    } else {
      this.zeroLocal_(id);
      this.zeroWorld_(id);
      this.zeroInverse_(id);
    }
    this.markDirty(id);
    this._count++;
    if (writeToGPU) { // if asked, compute world from local (identity parent) and upload inverse
      this.updateWorld(id, -1, true);
    }
    return id;
  }

  remove(id: number, writeToGPU = true): void {
    this.assertAlive(id);
    if (id === 0) throw new Error("remove: cannot remove root (id 0)");

    // zero GPU inverse
    const gi = id * Mat34Pool.Layout.GPU_LANES;
    for (let i = 0; i < Mat34Pool.Layout.GPU_LANES; i++) this._gpuF32[gi + i] = 0;

    // free meta
    const mb = id * Mat34Pool.Layout.META_LANES;
    this._metaI32[mb + Mat34Pool.Layout.M.STATUS] = this.encodeNextFree(this._freeHead);
    this._metaI32[mb + Mat34Pool.Layout.M.DIRTY] = 0;

    // zero local/world floats (optional)
      const fb = mb + Mat34Pool.Layout.M.LOCAL_START;
      for (let i = 0; i < 24; i++) this._metaF32[fb + i] = 0;

    this._freeHead = id;
    this._count--;
    if (writeToGPU) this.writeInverseToGPU(id);
  }

  cloneFrom(srcId: number, writeToGPU = false): number {
    this.assertAlive(srcId);
    const id = this.allocSlot();

    // Copy local + world
    const srcMb = srcId * Mat34Pool.Layout.META_LANES;
    const dstMb = id    * Mat34Pool.Layout.META_LANES;

    const srcFb = srcMb + Mat34Pool.Layout.M.LOCAL_START;
    const dstFb = dstMb + Mat34Pool.Layout.M.LOCAL_START;
    for (let i = 0; i < 24; i++) this._metaF32[dstFb + i] = this._metaF32[srcFb + i]!;

    // Copy inverseWorld (GPU mirror)
    const sgi = srcId * Mat34Pool.Layout.GPU_LANES;
    const dgi = id    * Mat34Pool.Layout.GPU_LANES;
    for (let i = 0; i < Mat34Pool.Layout.GPU_LANES; i++) this._gpuF32[dgi + i]! = this._gpuF32[sgi + i]!;

    this._metaI32[dstMb + Mat34Pool.Layout.M.STATUS] = id;
    this._metaI32[dstMb + Mat34Pool.Layout.M.DIRTY]  = this._metaI32[srcMb + Mat34Pool.Layout.M.DIRTY]! | 0;

    this._count++;
    if (writeToGPU) this.writeInverseToGPU(id);
    return id;
  }

  // ===== Public getters =====

  getLocalTRS(id: number, units: "rad" | "deg" = "rad") {
    this.assertAlive(id);
    return this._toTRSFromMeta_(id, /*useWorld*/ false, units);
  }

  getWorldTRS(id: number, units: "rad" | "deg" = "rad") {
    this.assertAlive(id);
    return this._toTRSFromMeta_(id, /*useWorld*/ true, units);
  }

  // ===== Local mutations (mark DIRTY) =====

  setTranslation(id: number, p: Vector3, _writeToGPU = false): this {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.META_LANES;
    this._metaF32[b + Mat34Pool.Layout.M.L.TX] = p.x;
    this._metaF32[b + Mat34Pool.Layout.M.L.TY] = p.y;
    this._metaF32[b + Mat34Pool.Layout.M.L.TZ] = p.z;
    this.markDirty(id);
    return this;
  }

  addTranslation(id: number, dp: Vector3, _writeToGPU = false): this {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.META_LANES;
    this._metaF32[b + Mat34Pool.Layout.M.L.TX]! += dp.x;
    this._metaF32[b + Mat34Pool.Layout.M.L.TY]! += dp.y;
    this._metaF32[b + Mat34Pool.Layout.M.L.TZ]! += dp.z;
    this.markDirty(id);
    return this;
  }

  setFromTRS(id: number, position: Vector3, e: EulerZYX, _writeToGPU = false): this {
    const l = Mat34Pool.Layout;
    this.assertAlive(id);
    this._writeTRSTo_(id * l.META_LANES + l.M.LOCAL_START, position, e);
    this.markDirty(id);
    return this;
  }

  /** Compose local = local * TRS(dp,de). */
  addTRS(id: number, dp: Vector3, de: EulerZYX, _writeToGPU = false): this {
    this.assertAlive(id);
    const l = Mat34Pool.Layout;
    const lb = id * l.META_LANES + l.M.LOCAL_START;
    const tmp = new Float32Array(12);
    this._writeTRSTo_(/*dest*/ tmp, dp, de); // write delta TRS into tmp (overload supports array)
    this._mul3x4_To_(/*a*/ lb, /*b*/ tmp, /*out*/ lb);
    this.markDirty(id);
    return this;
  }

  // ===== Propagation (compute world & inverseWorld) =====

  /**
   * Recompute world (parent.world * local or just local if parentId == -1),
   * then compute inverse(world) and (optionally) upload to GPU. Clears DIRTY.
   */
  updateWorld(id: number, parentId: number, writeToGPU = true): this {
    this.assertAlive(id);
    const lb = id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.LOCAL_START;
    const wb = id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.WORLD_START;

    if (parentId === -1) {
      // world = local
      for (let i = 0; i < 12; i++) this._metaF32[wb + i] = this._metaF32[lb + i]!;
    } else {
      this.assertAlive(parentId);
      const pb = parentId * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.WORLD_START;
      this._mul3x4_To_(pb, lb, wb);
    }

    // Compute inverse(world) into GPU mirror for this id
    this._inverse3x4_From_(wb, /*dest gpu*/ id * Mat34Pool.Layout.GPU_LANES, /*assumeOrthonormal*/ true);

    if (writeToGPU) this.writeInverseToGPU(id);

    this.clearDirty(id);
    return this;
  }

  // ===== Validation =====

  validate(): void {
    if (!this.isAlive(0)) throw new Error("validate: root matrix (0) not alive");
  }

  // ===== Internals =====

  private markDirty(id: number) {
    const mb = id * Mat34Pool.Layout.META_LANES;
    this._metaI32[mb + Mat34Pool.Layout.M.DIRTY] = 1;
  }
  private clearDirty(id: number) {
    const mb = id * Mat34Pool.Layout.META_LANES;
    this._metaI32[mb + Mat34Pool.Layout.M.DIRTY] = 0;
  }
  isDirty(id: number): boolean {
    if (!this.isAlive(id)) return false;
    const mb = id * Mat34Pool.Layout.META_LANES;
    return (this._metaI32[mb + Mat34Pool.Layout.M.DIRTY]! | 0) !== 0;
  }

  private assertAlive(id: number) {
    if (!this.isAlive(id)) throw new Error(`Matrix ${id} is not alive`);
  }
  private isAlive(id: number): boolean {
    if (id < 0 || id >= this._capacity) return false;
    const mb = id * Mat34Pool.Layout.META_LANES;
    return (this._metaI32[mb + Mat34Pool.Layout.M.STATUS]! | 0) >= 0;
  }

  private initEntryAlive(id: number) {
    const mb = id * Mat34Pool.Layout.META_LANES;
    this._metaI32[mb + Mat34Pool.Layout.M.STATUS] = id;
    this._metaI32[mb + Mat34Pool.Layout.M.DIRTY]  = 1;

    this.setLocalIdentity_(id);
    this.setWorldIdentity_(id);
    this.setInverseIdentity_(id);
  }

  private allocSlot(): number {
    if (this._freeHead === -1) this.grow();
    const id = this._freeHead;
    const mb = id * Mat34Pool.Layout.META_LANES;
    const nextEnc = this._metaI32[mb + Mat34Pool.Layout.M.STATUS]! | 0;
    this._freeHead = this.decodeNextFree(nextEnc);
    this._metaI32[mb + Mat34Pool.Layout.M.STATUS] = id;
    this._metaI32[mb + Mat34Pool.Layout.M.DIRTY]  = 1;
    return id;
  }

  private grow(): void {
    const oldCap = this._capacity;
    const newCap = Math.max(2, oldCap << 1);

    // GPU inverse buffer
    const newGpu = new ArrayBuffer(newCap * Mat34Pool.Layout.BYTES_PER_GPU);
    const nF32 = new Float32Array(newGpu);
    nF32.set(this._gpuF32);

    // META buffer
    const newMeta = new ArrayBuffer(newCap * Mat34Pool.Layout.BYTES_PER_META);
    const nI32 = new Int32Array(newMeta);
    const nF32m = new Float32Array(newMeta);
    nI32.set(this._metaI32); // copies both int+float lanes as raw 32-bit
    // Fill new free nodes
    let head = this._freeHead;
    for (let id = newCap - 1; id >= oldCap; id--) {
      const mb = id * Mat34Pool.Layout.META_LANES;
      nI32[mb + Mat34Pool.Layout.M.STATUS] = this.encodeNextFree(head);
      nI32[mb + Mat34Pool.Layout.M.DIRTY]  = 0;
      const fb = mb + Mat34Pool.Layout.M.LOCAL_START;
      for (let i = 0; i < 24; i++) nF32m[fb + i] = 0;
      head = id;
    }

    this._gpuMirrorBuffer = newGpu; this._gpuF32 = nF32;
    this._metaBuffer = newMeta; this._metaI32 = nI32; this._metaF32 = nF32m;
    this._capacity = newCap; this._freeHead = head;

    if (this._device) this.createGPUBuffer(this._device); // rebuild + upload
  }

  private encodeNextFree(nextId: number) { return -2 - (nextId === -1 ? -1 : nextId); }
  private decodeNextFree(enc: number) { return -enc - 2; }

  /** Replace internal buffers after a repack/compact.
 * newGpu  : ArrayBuffer sized to newCapacity * BYTES_PER_GPU (inverseWorld mirror)
 * newMeta : ArrayBuffer sized to newCapacity * BYTES_PER_META (STATUS, DIRTY, LOCAL, WORLD)
 * newCount: number of alive entries after repack
 * newFreeHead: head of free-list after repack (encoded in STATUS for free nodes)
 * writeToGPU: if true, upload all inverseWorld to GPU (and recreate GPU buffer if capacity grew)
 */
  replaceBuffers(
    newGpu: ArrayBuffer,
    newMeta: ArrayBuffer,
    newCount: number,
    newFreeHead: number,
    writeToGPU = true
  ): void {
    // Derive capacities from incoming buffers
    const lanesGPU = Mat34Pool.Layout.BYTES_PER_GPU;
    const lanesMETA = Mat34Pool.Layout.BYTES_PER_META;

    if (newGpu.byteLength % lanesGPU !== 0) {
      throw new Error(`replaceBuffers: newGpu byteLength ${newGpu.byteLength} is not a multiple of BYTES_PER_GPU ${lanesGPU}`);
    }
    if (newMeta.byteLength % lanesMETA !== 0) {
      throw new Error(`replaceBuffers: newMeta byteLength ${newMeta.byteLength} is not a multiple of BYTES_PER_META ${lanesMETA}`);
    }

    const newCapacityGPU  = newGpu.byteLength  / lanesGPU;
    const newCapacityMETA = newMeta.byteLength / lanesMETA;
    if (newCapacityGPU !== newCapacityMETA) {
      throw new Error(`replaceBuffers: capacity mismatch (GPU=${newCapacityGPU}, META=${newCapacityMETA})`);
    }
    const newCap = newCapacityGPU | 0;

    // Swap buffers & views
    this._gpuMirrorBuffer = newGpu;
    this._gpuF32 = new Float32Array(newGpu);

    this._metaBuffer = newMeta;
    this._metaI32 = new Int32Array(newMeta);
    this._metaF32 = new Float32Array(newMeta);

    // Bookkeeping
    this._capacity = newCap;
    this._count = newCount | 0;
    this._freeHead = newFreeHead | 0;

    // If we have a device, ensure GPU buffer fits; recreate if capacity grew
    if (this._device) {
      if (!this._gpuBuffer || writeToGPU === true) {
        // If capacity changed relative to previous, recreate to be safe
        // (WebGPU doesn't expose size, so recreate when capacity changed)
        // We could cache previous capacity; compare and recreate if different:
        // Here we conservatively recreate if buffer is null OR capacity changed.
        try { if (this._gpuBuffer) this._gpuBuffer.destroy(); } catch {}
        const size = Math.max(16, this._capacity * Mat34Pool.Layout.BYTES_PER_GPU);
        this._gpuBuffer = this._device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: false });
        this._version++;
      }
      if (writeToGPU && this._gpuBuffer) {
        this.writeAllToGPU();
      }
    }
  }

  // ===== Math helpers (on META floats) =====

  private _writeTRSTo_(destBase: number | Float32Array, position: Vector3, e: EulerZYX) {
    let arr: Float32Array;
    let base = 0;
    if (typeof destBase === "number") {
      arr = this._metaF32;
      base = destBase | 0;
    } else {
      arr = destBase as Float32Array;
    }

    const px = position.x, py = position.y, pz = position.z;

    const k = e.units === "deg" ? Math.PI / 180 : 1;
    const yawZ   = e.yawZ   * k;
    const pitchY = e.pitchY * k;
    const rollX  = e.rollX  * k;

    const cz = Math.cos(yawZ),   sz = Math.sin(yawZ);
    const cy = Math.cos(pitchY), sy = Math.sin(pitchY);
    const cx = Math.cos(rollX),  sx = Math.sin(rollX);

    const r00 =  cz * cy;
    const r01 =  cz * sy * sx + sz * cx;
    const r02 =  cz * sy * cx - sz * sx;

    const r10 = -sz * cy;
    const r11 = -sz * sy * sx + cz * cx;
    const r12 = -sz * sy * cx - cz * sx;

    const r20 = -sy;
    const r21 =  cy * sx;
    const r22 =  cy * cx;

    arr[base + 0]  = r00; arr[base + 1]  = r01; arr[base + 2]  = r02; arr[base + 3]  = px;
    arr[base + 4]  = r10; arr[base + 5]  = r11; arr[base + 6]  = r12; arr[base + 7]  = py;
    arr[base + 8]  = r20; arr[base + 9]  = r21; arr[base + 10] = r22; arr[base + 11] = pz;
  }


  /** out = a * b (allows aliasing with out==a or out==b when all are base indices in META). */
  private _mul3x4_To_(aBase: number, bBase: number | Float32Array, outBase: number): void {
    const A = this._metaF32;
    const a00=A[aBase+0]!, a01=A[aBase+1]!, a02=A[aBase+2]!, atx=A[aBase+3]!;
    const a10=A[aBase+4]!, a11=A[aBase+5]!, a12=A[aBase+6]!, aty=A[aBase+7]!;
    const a20=A[aBase+8]!, a21=A[aBase+9]!, a22=A[aBase+10]!, atz=A[aBase+11]!;

    // Read B either from META base or a tmp array
    let b00: number, b01: number, b02: number, btx: number,
        b10: number, b11: number, b12: number, bty: number,
        b20: number, b21: number, b22: number, btz: number;

    if (typeof bBase === "number") {
      const B = this._metaF32;
      b00=B[bBase+0]!, b01=B[bBase+1]!, b02=B[bBase+2]!, btx=B[bBase+3]!;
      b10=B[bBase+4]!, b11=B[bBase+5]!, b12=B[bBase+6]!, bty=B[bBase+7]!;
      b20=B[bBase+8]!, b21=B[bBase+9]!, b22=B[bBase+10]!, btz=B[bBase+11]!;
    } else {
      const B = bBase as Float32Array;
      b00=B[0]!, b01=B[1]!, b02=B[2]!, btx=B[3]!;
      b10=B[4]!, b11=B[5]!, b12=B[6]!, bty=B[7]!;
      b20=B[8]!, b21=B[9]!, b22=B[10]!, btz=B[11]!;
    }

    const r00 = a00*b00 + a01*b10 + a02*b20;
    const r01 = a00*b01 + a01*b11 + a02*b21;
    const r02 = a00*b02 + a01*b12 + a02*b22;

    const r10 = a10*b00 + a11*b10 + a12*b20;
    const r11 = a10*b01 + a11*b11 + a12*b21;
    const r12 = a10*b02 + a11*b12 + a12*b22;

    const r20 = a20*b00 + a21*b10 + a22*b20;
    const r21 = a20*b01 + a21*b11 + a22*b21;
    const r22 = a20*b02 + a21*b12 + a22*b22;

    const ntx = a00*btx + a01*bty + a02*btz + atx;
    const nty = a10*btx + a11*bty + a12*btz + aty;
    const ntz = a20*btx + a21*bty + a22*btz + atz;

    const O = this._metaF32;
    O[outBase+0]=r00; O[outBase+1]=r01; O[outBase+2]=r02; O[outBase+3]=ntx;
    O[outBase+4]=r10; O[outBase+5]=r11; O[outBase+6]=r12; O[outBase+7]=nty;
    O[outBase+8]=r20; O[outBase+9]=r21; O[outBase+10]=r22; O[outBase+11]=ntz;
  }

  /** Compute inverse of META 3x4 at base and write into GPU mirror lanes for this id. */
  private _inverse3x4_From_(base: number, gpuOutBase: number, assumeOrthonormal = true): void {
    const R = this._metaF32;
    const r00=R[base+0]!, r01=R[base+1]!, r02=R[base+2]!;
    const r10=R[base+4]!, r11=R[base+5]!, r12=R[base+6]!;
    const r20=R[base+8]!, r21=R[base+9]!, r22=R[base+10]!;
    const tx =R[base+3]!,  ty =R[base+7]!,  tz =R[base+11]!;

    let i00:number,i01:number,i02:number,
        i10:number,i11:number,i12:number,
        i20:number,i21:number,i22:number;
    if (assumeOrthonormal) {
      i00=r00; i01=r10; i02=r20;
      i10=r01; i11=r11; i12=r21;
      i20=r02; i21=r12; i22=r22;
    } else {
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
      const EPS = 1e-8;
      let invDet = 1.0 / det;
      if (!Number.isFinite(invDet) || Math.abs(det) < EPS) {
        i00=r00; i01=r10; i02=r20;
        i10=r01; i11=r11; i12=r21;
        i20=r02; i21=r12; i22=r22;
      } else {
        i00=c00*invDet; i01=c10*invDet; i02=c20*invDet;
        i10=c01*invDet; i11=c11*invDet; i12=c21*invDet;
        i20=c02*invDet; i21=c12*invDet; i22=c22*invDet;
      }
    }

    const itx = -(i00*tx + i01*ty + i02*tz);
    const ity = -(i10*tx + i11*ty + i12*tz);
    const itz = -(i20*tx + i21*ty + i22*tz);

    const O = this._gpuF32;
    const o = gpuOutBase;
    O[o+0]=i00; O[o+1]=i01; O[o+2]=i02; O[o+3]=itx;
    O[o+4]=i10; O[o+5]=i11; O[o+6]=i12; O[o+7]=ity;
    O[o+8]=i20; O[o+9]=i21; O[o+10]=i22; O[o+11]=itz;
  }

  private _toTRSFromMeta_(id: number, useWorld: boolean, units: "rad" | "deg") {
    const b = useWorld 
      ? id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.WORLD_START
      : id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.LOCAL_START;
    const r00=this._metaF32[b+0]!, r01=this._metaF32[b+1]!, r02=this._metaF32[b+2]!;
    const r10=this._metaF32[b+4]!, r11=this._metaF32[b+5]!, r12=this._metaF32[b+6]!;
    const r20=this._metaF32[b+8]!, r21=this._metaF32[b+9]!, r22=this._metaF32[b+10]!;
    const px = this._metaF32[b+3]!, py = this._metaF32[b+7]!, pz = this._metaF32[b+11]!;

    let pitchY = Math.asin(-r20);
    let yawZ: number, rollX: number;
    const EPS = 1e-6;

    if (Math.abs(Math.cos(pitchY)) > EPS) {
      yawZ  = Math.atan2(-r10, r00);
      rollX = Math.atan2(r21, r22);
    } else {
      yawZ  = Math.atan2(r01, r11);
      rollX = 0;
    }

    const position = new Vector3(px, py, pz);
    const euler =
      units === "deg"
        ? { yawZ: yawZ * 180/Math.PI, pitchY: pitchY * 180/Math.PI, rollX: rollX * 180/Math.PI, units: "deg" as const }
        : { yawZ, pitchY, rollX, units: "rad" as const };

    return { position, euler };
  }

  private setLocalIdentity_(id: number) {
    const b = id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.LOCAL_START;
    this._metaF32[b+0]=1; this._metaF32[b+1]=0; this._metaF32[b+2]=0; this._metaF32[b+3]=0;
    this._metaF32[b+4]=0; this._metaF32[b+5]=1; this._metaF32[b+6]=0; this._metaF32[b+7]=0;
    this._metaF32[b+8]=0; this._metaF32[b+9]=0; this._metaF32[b+10]=1; this._metaF32[b+11]=0;
  }
  private setWorldIdentity_(id: number) {
    const b = id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.WORLD_START;
    this._metaF32[b+0]=1; this._metaF32[b+1]=0; this._metaF32[b+2]=0; this._metaF32[b+3]=0;
    this._metaF32[b+4]=0; this._metaF32[b+5]=1; this._metaF32[b+6]=0; this._metaF32[b+7]=0;
    this._metaF32[b+8]=0; this._metaF32[b+9]=0; this._metaF32[b+10]=1; this._metaF32[b+11]=0;
  }
  private setInverseIdentity_(id: number) {
    const o = id * Mat34Pool.Layout.GPU_LANES;
    this._gpuF32[o+0]=1; this._gpuF32[o+1]=0; this._gpuF32[o+2]=0; this._gpuF32[o+3]=0;
    this._gpuF32[o+4]=0; this._gpuF32[o+5]=1; this._gpuF32[o+6]=0; this._gpuF32[o+7]=0;
    this._gpuF32[o+8]=0; this._gpuF32[o+9]=0; this._gpuF32[o+10]=1; this._gpuF32[o+11]=0;
  }
  private zeroLocal_(id: number) {
    const b = id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.LOCAL_START;
    for (let i = 0; i < 12; i++) this._metaF32[b + i] = 0;
  }
  private zeroWorld_(id: number) {
    const b = id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.WORLD_START;
    for (let i = 0; i < 12; i++) this._metaF32[b + i] = 0;
  }
  private zeroInverse_(id: number) {
    const o = id * Mat34Pool.Layout.GPU_LANES;
    for (let i = 0; i < 12; i++) this._gpuF32[o + i] = 0;
  }
}

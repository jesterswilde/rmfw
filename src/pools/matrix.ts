// Layout (row-major 3x4):
// [ r00 r01 r02 tx
//   r10 r11 r12 ty
//   r20 r21 r22 tz ]
// GPU: 12 f32 lanes per entry.
// Meta: STATUS i32 per entry (>=0 alive id, <0 free link)

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
    M: { STATUS: 0 },
    META_LANES: 1,
    BYTES_PER_META: 1 * 4,
  } as const;

  private static readonly SENTINEL = -1;

  // CPU-side GPU mirror
  private _gpuMirrorBuffer: ArrayBuffer;
  private _gpuF32: Float32Array;

  // CPU-only meta
  private _metaBuffer: ArrayBuffer;
  private _metaI32: Int32Array;

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

    this._count = 0;
    this._freeHead = Mat34Pool.SENTINEL;

    for (let id = this._capacity - 1; id >= 1; id--) {
      const gi = id * Mat34Pool.Layout.GPU_LANES;
      for (let i = 0; i < Mat34Pool.Layout.GPU_LANES; i++) 
        this._gpuF32[gi + i] = 0;
      this._metaI32[id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.STATUS] =
        this.encodeNextFree(this._freeHead);
      this._freeHead = id;
    }

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
      gpuMirrorBuffer: this._gpuMirrorBuffer,
      gpuF32: this._gpuF32,
      GPU_STRIDE: Mat34Pool.Layout.GPU_LANES,

      metaBuffer: this._metaBuffer,
      metaI32: this._metaI32,
      META_STRIDE: Mat34Pool.Layout.META_LANES,
    };
  }

  getGPUBuffer(){
    return this._gpuBuffer;
  }

  /** Create a GPUBuffer, upload all, store it, and bump version. */
  createGPUBuffer(
    device: GPUDevice,
    usage: GPUBufferUsageFlags = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  ): GPUBuffer {
    this._device = device;
    if (this._gpuBuffer) { try { this._gpuBuffer.destroy(); } catch {} this._gpuBuffer = null; }
    const size = Math.max(16, this._capacity * Mat34Pool.Layout.BYTES_PER_GPU);
    this._gpuBuffer = device.createBuffer({ size, usage, mappedAtCreation: false });
    this.writeAllToGPU();
    this._version++;
    return this._gpuBuffer;
  }

  /** Upload entire mirror buffer. */
  writeAllToGPU(): void {
    if (!this._device || !this._gpuBuffer) 
      return;
    this._device.queue.writeBuffer(this._gpuBuffer, 0, this._gpuMirrorBuffer);
  }

  /** Upload a single transform. */
  private writeMatToGPU(id: number): void {
    if (!this._device || !this._gpuBuffer)
      return;
    const byteOffset = id * Mat34Pool.Layout.BYTES_PER_GPU;
    const bytes = new Uint8Array(this._gpuMirrorBuffer, byteOffset, Mat34Pool.Layout.BYTES_PER_GPU);
    this._device.queue.writeBuffer(this._gpuBuffer, byteOffset, bytes);
  }

  // ===== Allocation / lifetime =====
  create(identity = true, writeToGPU = true): number {
    const id = this.allocSlot();
    if (identity)
      this.setIdentity(id, false);
    else 
      this.zero(id, false);
    this._count++;
    if (writeToGPU)
      this.writeMatToGPU(id);
    return id;
  }

  remove(id: number, writeToGPU = true): void {
    this.assertAlive(id);
    if (id === 0)
      throw new Error("remove: cannot remove root (id 0)");
    const gi = id * Mat34Pool.Layout.GPU_LANES;
    for (let i = 0; i < Mat34Pool.Layout.GPU_LANES; i++) 
      this._gpuF32[gi + i] = 0;
    this._metaI32[id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.STATUS] = this.encodeNextFree(this._freeHead);
    this._freeHead = id;
    this._count--;
    if (writeToGPU) 
      this.writeMatToGPU(id);
  }

  cloneFrom(srcId: number, writeToGPU = true): number {
    this.assertAlive(srcId);
    const id = this.allocSlot();
    const srcI = srcId * Mat34Pool.Layout.GPU_LANES;
    const destI = id * Mat34Pool.Layout.GPU_LANES;
    for (let i = 0; i < Mat34Pool.Layout.GPU_LANES; i++)
      this._gpuF32[destI + i] = this._gpuF32[srcI + i]!;
    this._metaI32[id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.STATUS] = id;
    this._count++;
    if (writeToGPU) 
      this.writeMatToGPU(id);
    return id;
  }

  // ===== Basic setters / getters =====

  setIdentity(id: number, writeToGPU = true): this {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.GPU_LANES;
    this._gpuF32[b+0]=1; this._gpuF32[b+1]=0; this._gpuF32[b+2]=0; this._gpuF32[b+3]=0;
    this._gpuF32[b+4]=0; this._gpuF32[b+5]=1; this._gpuF32[b+6]=0; this._gpuF32[b+7]=0;
    this._gpuF32[b+8]=0; this._gpuF32[b+9]=0; this._gpuF32[b+10]=1; this._gpuF32[b+11]=0;
    if (writeToGPU)
      this.writeMatToGPU(id);
    return this;
  }

  zero(id: number, writeToGPU = true): this {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.GPU_LANES;
    for (let i = 0; i < Mat34Pool.Layout.GPU_LANES; i++) this._gpuF32[b + i] = 0;
    if (writeToGPU)
      this.writeMatToGPU(id);
    return this;
  }

  getTranslation(id: number, out = new Vector3(0,0,0)): Vector3 {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.GPU_LANES;
    out.x = this._gpuF32[b + Mat34Pool.Layout.G.TX]!;
    out.y = this._gpuF32[b + Mat34Pool.Layout.G.TY]!;
    out.z = this._gpuF32[b + Mat34Pool.Layout.G.TZ]!;
    return out;
  }

  setTranslation(id: number, p: Vector3, writeToGPU = true): this {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.GPU_LANES;
    this._gpuF32[b + Mat34Pool.Layout.G.TX] = p.x;
    this._gpuF32[b + Mat34Pool.Layout.G.TY] = p.y;
    this._gpuF32[b + Mat34Pool.Layout.G.TZ] = p.z;
    if (writeToGPU) 
      this.writeMatToGPU(id);
    return this;
  }

  addTranslation(id: number, dp: Vector3, writeToGPU = true): this {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.GPU_LANES;
    this._gpuF32[b + Mat34Pool.Layout.G.TX]! += dp.x;
    this._gpuF32[b + Mat34Pool.Layout.G.TY]! += dp.y;
    this._gpuF32[b + Mat34Pool.Layout.G.TZ]! += dp.z;
    if (writeToGPU) 
      this.writeMatToGPU(id);
    return this;
  }

  setFromTRS(id: number, position: Vector3, e: EulerZYX, writeToGPU = true): this {
    this.assertAlive(id);
    const yawZ   = e.units === "deg" ? deg2rad(e.yawZ)   : e.yawZ;
    const pitchY = e.units === "deg" ? deg2rad(e.pitchY) : e.pitchY;
    const rollX  = e.units === "deg" ? deg2rad(e.rollX)  : e.rollX;

    const cz = Math.cos(yawZ), sz = Math.sin(yawZ);
    const cy = Math.cos(pitchY), sy = Math.sin(pitchY);
    const cx = Math.cos(rollX),  sx = Math.sin(rollX);

    const r00 =  cz*cy;           const r01 =  cz*sy*sx + sz*cx; const r02 =  cz*sy*cx - sz*sx;
    const r10 = -sz*cy;           const r11 = -sz*sy*sx + cz*cx; const r12 = -sz*sy*cx - cz*sx;
    const r20 = -sy;              const r21 =  cy*sx;            const r22 =  cy*cx;

    const b = id * Mat34Pool.Layout.GPU_LANES;
    this._gpuF32[b+0]=r00; this._gpuF32[b+1]=r01; this._gpuF32[b+2]=r02; this._gpuF32[b+3]=position.x;
    this._gpuF32[b+4]=r10; this._gpuF32[b+5]=r11; this._gpuF32[b+6]=r12; this._gpuF32[b+7]=position.y;
    this._gpuF32[b+8]=r20; this._gpuF32[b+9]=r21; this._gpuF32[b+10]=r22; this._gpuF32[b+11]=position.z;

    if (writeToGPU) 
      this.writeMatToGPU(id);
    return this;
  }
  setInverseFromTRS( id: number, position: Vector3, e: EulerZYX, writeToGPU = true): this {
    this.assertAlive(id);

    const yawZ   = e.units === "deg" ? deg2rad(e.yawZ)   : e.yawZ;
    const pitchY = e.units === "deg" ? deg2rad(e.pitchY) : e.pitchY;
    const rollX  = e.units === "deg" ? deg2rad(e.rollX)  : e.rollX;

    const cz = Math.cos(yawZ),  sz = Math.sin(yawZ);
    const cy = Math.cos(pitchY), sy = Math.sin(pitchY);
    const cx = Math.cos(rollX),  sx = Math.sin(rollX);

    // Forward rotation
    const r00 =  cz*cy;           const r01 =  cz*sy*sx + sz*cx; const r02 =  cz*sy*cx - sz*sx;
    const r10 = -sz*cy;           const r11 = -sz*sy*sx + cz*cx; const r12 = -sz*sy*cx - cz*sx;
    const r20 = -sy;              const r21 =  cy*sx;            const r22 =  cy*cx;

    // Inverse rotation is transpose (orthonormal)
    const i00 = r00, i01 = r10, i02 = r20;
    const i10 = r01, i11 = r11, i12 = r21;
    const i20 = r02, i21 = r12, i22 = r22;

    // Inverse translation = -R^T * t
    const px = position.x, py = position.y, pz = position.z;
    const itx = -(i00*px + i01*py + i02*pz);
    const ity = -(i10*px + i11*py + i12*pz);
    const itz = -(i20*px + i21*py + i22*pz);

    // Write to buffer in row-major 3x4 layout
    const b = id * Mat34Pool.Layout.GPU_LANES;
    this._gpuF32[b+0]=i00; this._gpuF32[b+1]=i01; this._gpuF32[b+2]=i02; this._gpuF32[b+3]=itx;
    this._gpuF32[b+4]=i10; this._gpuF32[b+5]=i11; this._gpuF32[b+6]=i12; this._gpuF32[b+7]=ity;
    this._gpuF32[b+8]=i20; this._gpuF32[b+9]=i21; this._gpuF32[b+10]=i22; this._gpuF32[b+11]=itz;

    if (writeToGPU)
      this.writeMatToGPU(id);
    return this;
  }


  toTRS(id: number, units: "rad" | "deg" = "rad") {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.GPU_LANES;
    const position = new Vector3(this._gpuF32[b+3]!, this._gpuF32[b+7]!, this._gpuF32[b+11]!);

    const r00 = this._gpuF32[b+0]!, r01 = this._gpuF32[b+1]!, r02 = this._gpuF32[b+2]!;
    const r10 = this._gpuF32[b+4]!, r11 = this._gpuF32[b+5]!, r12 = this._gpuF32[b+6]!;
    const r20 = this._gpuF32[b+8]!, r21 = this._gpuF32[b+9]!, r22 = this._gpuF32[b+10]!;

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

    const euler =
      units === "deg"
        ? { yawZ: yawZ * 180/Math.PI, pitchY: pitchY * 180/Math.PI, rollX: rollX * 180/Math.PI, units: "deg" as const }
        : { yawZ, pitchY, rollX, units: "rad" as const };

    return { position, euler };
  }

  // ===== Products (A = A * B) =====

  multiply(idA: number, idB: number, writeToGPU = true): this {
    this.assertAlive(idA); this.assertAlive(idB);
    const a = idA * Mat34Pool.Layout.GPU_LANES;
    const b = idB * Mat34Pool.Layout.GPU_LANES;

    const a00=this._gpuF32[a+0]!, a01=this._gpuF32[a+1]!, a02=this._gpuF32[a+2]!, atx=this._gpuF32[a+3]!;
    const a10=this._gpuF32[a+4]!, a11=this._gpuF32[a+5]!, a12=this._gpuF32[a+6]!, aty=this._gpuF32[a+7]!;
    const a20=this._gpuF32[a+8]!, a21=this._gpuF32[a+9]!, a22=this._gpuF32[a+10]!, atz=this._gpuF32[a+11]!;

    const b00=this._gpuF32[b+0]!, b01=this._gpuF32[b+1]!, b02=this._gpuF32[b+2]!, btx=this._gpuF32[b+3]!;
    const b10=this._gpuF32[b+4]!, b11=this._gpuF32[b+5]!, b12=this._gpuF32[b+6]!, bty=this._gpuF32[b+7]!;
    const b20=this._gpuF32[b+8]!, b21=this._gpuF32[b+9]!, b22=this._gpuF32[b+10]!, btz=this._gpuF32[b+11]!;

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

    this._gpuF32[a+0]=r00; this._gpuF32[a+1]=r01; this._gpuF32[a+2]=r02; this._gpuF32[a+3]=ntx;
    this._gpuF32[a+4]=r10; this._gpuF32[a+5]=r11; this._gpuF32[a+6]=r12; this._gpuF32[a+7]=nty;
    this._gpuF32[a+8]=r20; this._gpuF32[a+9]=r21; this._gpuF32[a+10]=r22; this._gpuF32[a+11]=ntz;

    if (writeToGPU)
      this.writeMatToGPU(idA);
    return this;
  }

  /** this[id] = left * this[id] */
  preMultiply(id: number, leftId: number, writeToGPU = true): this {
    return this.multiplyTo(leftId, id, id, writeToGPU);
  }

  /** out = a * b (allows out==a or out==b) */
  multiplyTo(aId: number, bId: number, outId: number, writeToGPU = true): this {
    this.assertAlive(aId); this.assertAlive(bId); this.assertAlive(outId);
    const a = aId * Mat34Pool.Layout.GPU_LANES;
    const b = bId * Mat34Pool.Layout.GPU_LANES;
    const o = outId * Mat34Pool.Layout.GPU_LANES;

    const a00=this._gpuF32[a+0]!, a01=this._gpuF32[a+1]!, a02=this._gpuF32[a+2]!, atx=this._gpuF32[a+3]!;
    const a10=this._gpuF32[a+4]!, a11=this._gpuF32[a+5]!, a12=this._gpuF32[a+6]!, aty=this._gpuF32[a+7]!;
    const a20=this._gpuF32[a+8]!, a21=this._gpuF32[a+9]!, a22=this._gpuF32[a+10]!, atz=this._gpuF32[a+11]!;

    const b00=this._gpuF32[b+0]!, b01=this._gpuF32[b+1]!, b02=this._gpuF32[b+2]!, btx=this._gpuF32[b+3]!;
    const b10=this._gpuF32[b+4]!, b11=this._gpuF32[b+5]!, b12=this._gpuF32[b+6]!, bty=this._gpuF32[b+7]!;
    const b20=this._gpuF32[b+8]!, b21=this._gpuF32[b+9]!, b22=this._gpuF32[b+10]!, btz=this._gpuF32[b+11]!;

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

    this._gpuF32[o+0]=r00; this._gpuF32[o+1]=r01; this._gpuF32[o+2]=r02; this._gpuF32[o+3]=ntx;
    this._gpuF32[o+4]=r10; this._gpuF32[o+5]=r11; this._gpuF32[o+6]=r12; this._gpuF32[o+7]=nty;
    this._gpuF32[o+8]=r20; this._gpuF32[o+9]=r21; this._gpuF32[o+10]=r22; this._gpuF32[o+11]=ntz;

    if (writeToGPU)
      this.writeMatToGPU(outId);
    return this;
  }

  // ===== Transform helpers =====

  transformPoint(id: number, p: Vector3): Vector3 {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.GPU_LANES;
    const x = p.x, y = p.y, z = p.z;
    const nx = this._gpuF32[b+0]! * x + this._gpuF32[b+1]! * y + this._gpuF32[b+2]! * z + this._gpuF32[b+3]!;
    const ny = this._gpuF32[b+4]! * x + this._gpuF32[b+5]! * y + this._gpuF32[b+6]! * z + this._gpuF32[b+7]!;
    const nz = this._gpuF32[b+8]! * x + this._gpuF32[b+9]! * y + this._gpuF32[b+10]! * z + this._gpuF32[b+11]!;
    return new Vector3(nx, ny, nz);
  }

  transformDirection(id: number, v: Vector3): Vector3 {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.GPU_LANES;
    const x = v.x, y = v.y, z = v.z;
    const nx = this._gpuF32[b+0]! * x + this._gpuF32[b+1]! * y + this._gpuF32[b+2]! * z;
    const ny = this._gpuF32[b+4]! * x + this._gpuF32[b+5]! * y + this._gpuF32[b+6]! * z;
    const nz = this._gpuF32[b+8]! * x + this._gpuF32[b+9]! * y + this._gpuF32[b+10]! * z;
    return new Vector3(nx, ny, nz);
  }

  // ===== Inverse (optional orthonormal fast path) =====

  toInverse3x4(id: number, out?: Float32Array, assumeOrthonormal = false): Float32Array {
    this.assertAlive(id);
    const b = id * Mat34Pool.Layout.GPU_LANES;
    const o = out ?? new Float32Array(12);

    const r00=this._gpuF32[b+0]!, r01=this._gpuF32[b+1]!, r02=this._gpuF32[b+2]!;
    const r10=this._gpuF32[b+4]!, r11=this._gpuF32[b+5]!, r12=this._gpuF32[b+6]!;
    const r20=this._gpuF32[b+8]!, r21=this._gpuF32[b+9]!, r22=this._gpuF32[b+10]!;
    const tx =this._gpuF32[b+3]!,  ty =this._gpuF32[b+7]!,  tz =this._gpuF32[b+11]!;

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

    o[0]=i00; o[1]=i01; o[2]=i02; o[3]=itx;
    o[4]=i10; o[5]=i11; o[6]=i12; o[7]=ity;
    o[8]=i20; o[9]=i21; o[10]=i22; o[11]=itz;
    return o;
  }

  // ===== Compaction / growth =====

  /** Replace internal buffers with new ones (used by repack). */
  replaceBuffers(
    newGpu: ArrayBuffer,
    newMeta: ArrayBuffer,
    newCount: number,
    newFreeHead: number,
    writeToGPU = true
  ): void {
    this._gpuMirrorBuffer = newGpu;
    this._gpuF32 = new Float32Array(newGpu);
    this._metaBuffer = newMeta;
    this._metaI32 = new Int32Array(newMeta);
    this._count = newCount;
    this._freeHead = newFreeHead;
    if (writeToGPU && this._device && this._gpuBuffer) this.writeAllToGPU();
  }

  validate(): void {
    if (!this.isAlive(0)) throw new Error("validate: root matrix (0) not alive");
  }

  // ===== Internals =====

  private assertAlive(id: number) {
    if (!this.isAlive(id)) throw new Error(`Matrix ${id} is not alive`);
  }

  private isAlive(id: number): boolean {
    if (id < 0 || id >= this._capacity)
      return false;
    return (this._metaI32[id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.STATUS]! | 0) >= 0;
  }

  private initEntryAlive(id: number) {
    this.setIdentity(id, false);
    this._metaI32[id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.STATUS] = id;
  }

  private allocSlot(): number {
    if (this._freeHead === -1)
      this.grow();
    const id = this._freeHead;
    const next = this.decodeNextFree(this._metaI32[id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.STATUS]! | 0);
    this._freeHead = next;
    this._metaI32[id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.STATUS] = id;
    return id;
  }

  private grow(): void {
    const oldCap = this._capacity;
    const newCap = Math.max(2, oldCap << 1);

    const newGpu = new ArrayBuffer(newCap * Mat34Pool.Layout.BYTES_PER_GPU);
    const nF32 = new Float32Array(newGpu);
    nF32.set(this._gpuF32);

    const newMeta = new ArrayBuffer(newCap * Mat34Pool.Layout.BYTES_PER_META);
    const nI32 = new Int32Array(newMeta);
    nI32.set(this._metaI32);

    let head = this._freeHead;
    for (let id = newCap - 1; id >= oldCap; id--) {
      const gb = id * Mat34Pool.Layout.GPU_LANES;
      for (let i = 0; i < Mat34Pool.Layout.GPU_LANES; i++) nF32[gb + i] = 0;
      nI32[id * Mat34Pool.Layout.META_LANES + Mat34Pool.Layout.M.STATUS] = this.encodeNextFree(head);
      head = id;
    }

    this._gpuMirrorBuffer = newGpu; this._gpuF32 = nF32;
    this._metaBuffer = newMeta;     this._metaI32 = nI32;
    this._capacity = newCap; this._freeHead = head;

    if (this._device) this.createGPUBuffer(this._device); // bumps version
  }

  private encodeNextFree(nextId: number) { return -2 - (nextId === -1 ? -1 : nextId); }
  private decodeNextFree(enc: number) { return -enc - 2; }
}

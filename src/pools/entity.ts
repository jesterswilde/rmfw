import {
  ShapeType,
  type Shapes,
  type Box as BoxEnt,
  type Sphere as SphereEnt,
  type ReduceUnion as ReduceUnionEnt,
  type SimpleUnion as SimpleUnionEnt,
  type SimpleSubtract as SimpleSubtractEnt,
  type SimpleIntersection as SimpleIntersectionEnt,
  type Camera as CameraEnt,
  type GateBox,
} from "../entityDef.js";
import type { Vector3 } from "../utils/math.js";

export class ShapePool {
  static readonly Layout = {
    G: {
      H_TYPE: 0, H_XFORM: 1, H_MAT: 2, H_FLAGS: 3,
      V0X: 4, V0Y: 5, V0Z: 6, V0W: 7,
      V1X: 8, V1Y: 9, V1Z: 10, V1W: 11
    },
    GPU_LANES: 12,
    BYTES_PER_GPU_ENTRY: 12 * 4,
    M: { STATUS: 0 },
    META_LANES: 1,
    BYTES_PER_META_ENTRY: 1 * 4,
  } as const;


  private static readonly FLAG_HAS_GATE = 1 << 0;
  private static readonly SENTINEL = -1;

  private _gpuMirrorBuffer: ArrayBuffer;
  private _gpuF32: Float32Array;
  private _gpuI32: Int32Array;

  private _metaBuffer: ArrayBuffer;
  private _metaI32: Int32Array;

  private _capacity: number;
  private _count: number;
  private _freeHead: number;
  private _version = 0;

  private _device: GPUDevice | null = null;
  private _gpuBuffer: GPUBuffer | null = null;

  constructor(initialCapacity = 1024) {
    if (initialCapacity < 1) initialCapacity = 1;
    this._capacity = initialCapacity;

    this._gpuMirrorBuffer = new ArrayBuffer(
      this._capacity * ShapePool.Layout.BYTES_PER_GPU_ENTRY
    );
    this._gpuF32 = new Float32Array(this._gpuMirrorBuffer);
    this._gpuI32 = new Int32Array(this._gpuMirrorBuffer);

    this._metaBuffer = new ArrayBuffer(
      this._capacity * ShapePool.Layout.BYTES_PER_META_ENTRY
    );
    this._metaI32 = new Int32Array(this._metaBuffer);

    this._count = 0;
    this._freeHead = ShapePool.SENTINEL;

    for (let id = this._capacity - 1; id >= 1; id--) {
      this.zeroGPU12(id * ShapePool.Layout.GPU_LANES);
      this._metaI32[id * ShapePool.Layout.META_LANES + ShapePool.Layout.M.STATUS] =
        this.encodeNextFree(this._freeHead);
      this._freeHead = id;
    }
    this.initNullEntityAlive(0);
    this._count = 1;
  }

  get size() {
    return this._count;
  }
  get capacity() {
    return this._capacity;
  }
  get nullEntityId() {
    return 0;
  }
  get version() {
    return this._version;
  }

  /** Gets buffer views and associated sizes. */
  getBufferViews() {
    return {
      gpuMirrorBuffer: this._gpuMirrorBuffer,
      gpuF32: this._gpuF32,
      gpuI32: this._gpuI32,
      metaBuffer: this._metaBuffer,
      metaI32: this._metaI32,
      GPU_STRIDE: ShapePool.Layout.GPU_LANES,
      META_STRIDE: ShapePool.Layout.META_LANES,
    };
  }

  /** Create a GPUBuffer, upload all entities, store it, and bump version. */
  createGPUBuffer(
    device: GPUDevice,
    usage: GPUBufferUsageFlags = GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_DST
  ): GPUBuffer {
    this._device = device;

    if (this._gpuBuffer) {
      try {
        this._gpuBuffer.destroy();
      } catch {}
      this._gpuBuffer = null;
    }

    const size = Math.max(16, this._capacity * ShapePool.Layout.BYTES_PER_GPU_ENTRY);
    this._gpuBuffer = device.createBuffer({
      size,
      usage,
      mappedAtCreation: false,
    });
    this.writeAllToGPU();
    this._version++; // only here
    return this._gpuBuffer;
  }

  getGPUBuffer(){
    return this._gpuBuffer;
  }

  /** Upload entire CPU mirror to GPU. */
  writeAllToGPU(): void {
    if (!this._device || !this._gpuBuffer)
      return;
    this._device.queue.writeBuffer(this._gpuBuffer, 0, this._gpuMirrorBuffer);
  }

  /** Upload a single entity. */
  private writeEntityToGPU(id: number): void {
    if (!this._device || !this._gpuBuffer)
      return;
    const byteOffset = id * ShapePool.Layout.BYTES_PER_GPU_ENTRY;
    const byteSize = ShapePool.Layout.BYTES_PER_GPU_ENTRY;
    const bytes = new Uint8Array(this._gpuMirrorBuffer, byteOffset, byteSize);
    this._device.queue.writeBuffer(this._gpuBuffer, byteOffset, bytes);
  }

  /** Create and pack entity. */
  create(e: Shapes, writeToGPU = true): number {
    const id = this.allocSlot();
    this.packInto(id, e);
    this._count++;
    if (writeToGPU) this.writeEntityToGPU(id);
    return id;
  }

  /** Overwrite existing id. */
  update(id: number, e: Shapes, writeToGPU = true): void {
    this.assertAlive(id);
    this.packInto(id, e);
    if (writeToGPU) this.writeEntityToGPU(id);
  }

  /** Decode entity. NOTE: IDs are not stable*/
  get(id: number): Shapes {
    this.assertAlive(id);
    return this.unpackFrom(id);
  }

  /** Remove and free. */
  remove(id: number, writeToGPU = true): void {
    this.assertAlive(id);
    if (id === 0) throw new Error("remove: cannot remove NULL entity (id 0)");

    this.zeroGPU12(id * ShapePool.Layout.GPU_LANES);
    this._metaI32[id * ShapePool.Layout.META_LANES + ShapePool.Layout.M.STATUS] =
      this.encodeNextFree(this._freeHead);
    this._freeHead = id;
    this._count--;

    if (writeToGPU) this.writeEntityToGPU(id);
  }

  /** Basic consistency checks. */
  validate(): void {
    if (!this.isAlive(0))
      throw new Error("validate: null entity (0) must be alive");
    if ((this._gpuI32[ShapePool.Layout.G.H_TYPE]! | 0) !== -1)
      throw new Error("validate: entity 0 must be NULL (type = -1)");
    for (let id = 1; id < this._capacity; id++) {
      if (!this.isAlive(id)) continue;
      const t =
        this._gpuI32[id * ShapePool.Layout.GPU_LANES + ShapePool.Layout.G.H_TYPE]! | 0;
      if (
        t !== ShapeType.Sphere &&
        t !== ShapeType.Box &&
        t !== ShapeType.ReduceUnion &&
        t !== ShapeType.SimpleUnion &&
        t !== ShapeType.SimpleSubtract &&
        t !== ShapeType.SimpleIntersection &&
        t !== (ShapeType as any).Camera &&
        t !== (ShapeType as any).GateBox
      ) {
        throw new Error(`validate: entity ${id} has unknown type ${t}`);
      }
    }
  }

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
    this._gpuI32 = new Int32Array(newGpu);
    this._metaBuffer = newMeta;
    this._metaI32 = new Int32Array(newMeta);
    this._count = newCount;
    this._freeHead = newFreeHead;
    if (writeToGPU && this._device && this._gpuBuffer) this.writeAllToGPU();
  }

  // internals

  private initNullEntityAlive(id: number) {
    const b = id * ShapePool.Layout.GPU_LANES;
    this._gpuI32[b + ShapePool.Layout.G.H_TYPE] = -1;
    this._gpuI32[b + ShapePool.Layout.G.H_XFORM] = -1;
    this._gpuI32[b + ShapePool.Layout.G.H_MAT] = 0;
    this._gpuI32[b + ShapePool.Layout.G.H_FLAGS] = 0;
    for (let i = 0; i < 8; i++) this._gpuF32[b + 4 + i] = 0;
    this._metaI32[id * ShapePool.Layout.META_LANES + ShapePool.Layout.M.STATUS] = id;
  }

  private zeroGPU12(base: number) {
    for (let i = 0; i < ShapePool.Layout.GPU_LANES; i++) this._gpuF32[base + i] = 0;
  }
  private allocSlot(): number {
    if (this._freeHead === ShapePool.SENTINEL) this.grow();
    const id = this._freeHead;
    const mb = id * ShapePool.Layout.META_LANES;
    const next = this.decodeNextFree(this._metaI32[mb + ShapePool.Layout.M.STATUS]!);
    this._freeHead = next;
    this._metaI32[mb + ShapePool.Layout.M.STATUS] = id;
    return id;
  }

  /** Resize capacity; if a GPU buffer exists, recreate it (which bumps version). */
  private grow(): void {
    const oldCap = this._capacity;
    const newCap = Math.max(2, oldCap << 1);

    const newGpu = new ArrayBuffer(newCap * ShapePool.Layout.BYTES_PER_GPU_ENTRY);
    const ngF32 = new Float32Array(newGpu);
    const ngI32 = new Int32Array(newGpu);
    ngF32.set(this._gpuF32);

    const newMeta = new ArrayBuffer(newCap * ShapePool.Layout.BYTES_PER_META_ENTRY);
    const nmI32 = new Int32Array(newMeta);
    nmI32.set(this._metaI32);

    let head = this._freeHead;
    for (let id = newCap - 1; id >= oldCap; id--) {
      const b = id * ShapePool.Layout.GPU_LANES;
      for (let i = 0; i < ShapePool.Layout.GPU_LANES; i++) ngF32[b + i] = 0;
      nmI32[id * ShapePool.Layout.META_LANES + ShapePool.Layout.M.STATUS] =
        this.encodeNextFree(head);
      head = id;
    }

    this._gpuMirrorBuffer = newGpu;
    this._gpuF32 = ngF32;
    this._gpuI32 = ngI32;
    this._metaBuffer = newMeta;
    this._metaI32 = nmI32;

    this._capacity = newCap;
    this._freeHead = head;

    if (this._device) this.createGPUBuffer(this._device); // (re)creates and bumps version
  }

  private isAlive(id: number): boolean {
    if (id < 0 || id >= this._capacity)
      return false;
    return (
      (this._metaI32[id * ShapePool.Layout.META_LANES + ShapePool.Layout.M.STATUS]! | 0) >= 0
    );
  }
  private assertAlive(id: number) {
    if (!this.isAlive(id)) 
      throw new Error(`Entity ${id} is not alive`);
  }
  private encodeNextFree(nextId: number) {
    return -2 - (nextId === -1 ? -1 : nextId);
  }
  private decodeNextFree(enc: number) {
    return -enc - 2;
  }

  // pack/unpack

  private packInto(id: number, e: Shapes): void {
    const b = id * ShapePool.Layout.GPU_LANES;
    for (let i = 4; i <= 11; i++)
      this._gpuF32[b + i] = 0;

    switch (e.type) {
      case ShapeType.Camera: {
        const cam = e as CameraEnt;
        this._gpuI32[b + ShapePool.Layout.G.H_TYPE] = ShapeType.Camera;
        this._gpuI32[b + ShapePool.Layout.G.H_XFORM] = cam.xformID | 0;
        this._gpuI32[b + ShapePool.Layout.G.H_MAT] = -1;
        this._gpuI32[b + ShapePool.Layout.G.H_FLAGS] = 0;
        break;
      }
      case ShapeType.Sphere: {
        const s = e as SphereEnt;
        this._gpuI32[b + ShapePool.Layout.G.H_TYPE] = ShapeType.Sphere;
        this._gpuI32[b + ShapePool.Layout.G.H_XFORM] = s.xformID | 0;
        this._gpuI32[b + ShapePool.Layout.G.H_MAT] = s.material ?? -1;
        this._gpuI32[b + ShapePool.Layout.G.H_FLAGS] = 0;
        this._gpuF32[b + ShapePool.Layout.G.V0X] = s.radius;
        break;
      }
      case ShapeType.Box: {
        const bx = e as BoxEnt;
        this._gpuI32[b + ShapePool.Layout.G.H_TYPE] = ShapeType.Box;
        this._gpuI32[b + ShapePool.Layout.G.H_XFORM] = bx.xformID | 0;
        this._gpuI32[b + ShapePool.Layout.G.H_MAT] = (bx.material ?? 0) | 0;
        this._gpuI32[b + ShapePool.Layout.G.H_FLAGS] = 0;
        this._gpuF32[b + ShapePool.Layout.G.V0X] = bx.bounds.x;
        this._gpuF32[b + ShapePool.Layout.G.V0Y] = bx.bounds.y;
        this._gpuF32[b + ShapePool.Layout.G.V0Z] = bx.bounds.z;
        break;
      }
      case ShapeType.ReduceUnion: {
        const ru = e as ReduceUnionEnt;
        this._gpuI32[b + ShapePool.Layout.G.H_TYPE] = ShapeType.ReduceUnion;
        this._gpuI32[b + ShapePool.Layout.G.H_XFORM] = -1;
        this._gpuI32[b + ShapePool.Layout.G.H_MAT] = ru.children;
        this._gpuI32[b + ShapePool.Layout.G.H_FLAGS] = 0;
        break;
      }
      case ShapeType.SimpleUnion:
      case ShapeType.SimpleSubtract:
      case ShapeType.SimpleIntersection: {
        const t = e.type;
        this._gpuI32[b + ShapePool.Layout.G.H_TYPE] = t;
        this._gpuI32[b + ShapePool.Layout.G.H_XFORM] = -1;
        this._gpuI32[b + ShapePool.Layout.G.H_MAT] = 0;
        this._gpuI32[b + ShapePool.Layout.G.H_FLAGS] = 0;
        break;
      }
      case ShapeType.GateBox: {
        const gx = e as GateBox;
        this._gpuI32[b + ShapePool.Layout.G.H_TYPE] = ShapeType.GateBox;
        this._gpuI32[b + ShapePool.Layout.G.H_XFORM] = gx.xformID | 0;
        this._gpuI32[b + ShapePool.Layout.G.H_MAT] = 0;
        this._gpuI32[b + ShapePool.Layout.G.H_FLAGS] = ShapePool.FLAG_HAS_GATE;
        this._gpuF32[b + ShapePool.Layout.G.V0X] = gx.bounds.x;
        this._gpuF32[b + ShapePool.Layout.G.V0Y] = gx.bounds.y;
        this._gpuF32[b + ShapePool.Layout.G.V0Z] = gx.bounds.z;
        break;
      }
      default:
        throw new Error(`packInto: unsupported entity type ${(e as any).type}`);
    }

    this._metaI32[id * ShapePool.Layout.META_LANES + ShapePool.Layout.M.STATUS] = id;
  }

  private unpackFrom(id: number): Shapes {
    const b = id * ShapePool.Layout.GPU_LANES;
    const type = this._gpuI32[b + ShapePool.Layout.G.H_TYPE]! | 0;

    switch (type) {
      case ShapeType.Sphere: {
        const xformID = this._gpuI32[b + ShapePool.Layout.G.H_XFORM]! | 0;
        const material = this._gpuI32[b + ShapePool.Layout.G.H_MAT]! | 0;
        const radius = this._gpuF32[b + ShapePool.Layout.G.V0X]!;
        return { type: ShapeType.Sphere, xformID, material, radius };
      }
      case ShapeType.Box: {
        const xformID = this._gpuI32[b + ShapePool.Layout.G.H_XFORM]! | 0;
        const material = this._gpuI32[b + ShapePool.Layout.G.H_MAT]! | 0;
        const bounds = {
          x: this._gpuF32[b + ShapePool.Layout.G.V0X],
          y: this._gpuF32[b + ShapePool.Layout.G.V0Y],
          z: this._gpuF32[b + ShapePool.Layout.G.V0Z],
        } as Vector3;
        return { type: ShapeType.Box, material, xformID, bounds };
      }
      case ShapeType.ReduceUnion: {
        const children = this._gpuI32[b + ShapePool.Layout.G.H_MAT]! | 0;
        return { type: ShapeType.ReduceUnion, children };
      }
      case ShapeType.SimpleUnion:
        return { type: ShapeType.SimpleUnion } as SimpleUnionEnt;
      case ShapeType.SimpleSubtract:
        return { type: ShapeType.SimpleSubtract } as SimpleSubtractEnt;
      case ShapeType.SimpleIntersection:
        return { type: ShapeType.SimpleIntersection } as SimpleIntersectionEnt;
      case ShapeType.Camera: {
        const xformID = this._gpuI32[b + ShapePool.Layout.G.H_XFORM]! | 0;
        return { type: ShapeType.Camera, xformID } as CameraEnt;
      }
      case ShapeType.GateBox: {
        const xformID = this._gpuI32[b + ShapePool.Layout.G.H_XFORM]! | 0;
        const bounds = {
          x: this._gpuF32[b + ShapePool.Layout.G.V0X],
          y: this._gpuF32[b + ShapePool.Layout.G.V0Y],
          z: this._gpuF32[b + ShapePool.Layout.G.V0Z],
        } as Vector3;
        return { type: ShapeType.GateBox, xformID, bounds } as GateBox;
      }
      case -1:
        return { type: ShapeType.SimpleUnion } as SimpleUnionEnt;
      default:
        throw new Error(`unpackFrom: unknown entity type ${type} at ${id}`);
    }
  }
}

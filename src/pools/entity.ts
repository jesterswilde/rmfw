import {
  EntityType,
  type Entity,
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

export class EntityPool {
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
      this._capacity * EntityPool.Layout.BYTES_PER_GPU_ENTRY
    );
    this._gpuF32 = new Float32Array(this._gpuMirrorBuffer);
    this._gpuI32 = new Int32Array(this._gpuMirrorBuffer);

    this._metaBuffer = new ArrayBuffer(
      this._capacity * EntityPool.Layout.BYTES_PER_META_ENTRY
    );
    this._metaI32 = new Int32Array(this._metaBuffer);

    this._count = 0;
    this._freeHead = EntityPool.SENTINEL;

    for (let id = this._capacity - 1; id >= 1; id--) {
      this.zeroGPU12(id * EntityPool.Layout.GPU_LANES);
      this._metaI32[id * EntityPool.Layout.META_LANES + EntityPool.Layout.M.STATUS] =
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
      GPU_STRIDE: EntityPool.Layout.GPU_LANES,
      META_STRIDE: EntityPool.Layout.META_LANES,
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

    const size = Math.max(16, this._capacity * EntityPool.Layout.BYTES_PER_GPU_ENTRY);
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
    const byteOffset = id * EntityPool.Layout.BYTES_PER_GPU_ENTRY;
    const byteSize = EntityPool.Layout.BYTES_PER_GPU_ENTRY;
    const bytes = new Uint8Array(this._gpuMirrorBuffer, byteOffset, byteSize);
    this._device.queue.writeBuffer(this._gpuBuffer, byteOffset, bytes);
  }

  /** Create and pack entity. */
  create(e: Entity, writeToGPU = true): number {
    const id = this.allocSlot();
    this.packInto(id, e);
    this._count++;
    if (writeToGPU) this.writeEntityToGPU(id);
    return id;
  }

  /** Overwrite existing id. */
  update(id: number, e: Entity, writeToGPU = true): void {
    this.assertAlive(id);
    this.packInto(id, e);
    if (writeToGPU) this.writeEntityToGPU(id);
  }

  /** Decode entity. NOTE: IDs are not stable*/
  get(id: number): Entity {
    this.assertAlive(id);
    return this.unpackFrom(id);
  }

  /** Remove and free. */
  remove(id: number, writeToGPU = true): void {
    this.assertAlive(id);
    if (id === 0) throw new Error("remove: cannot remove NULL entity (id 0)");

    this.zeroGPU12(id * EntityPool.Layout.GPU_LANES);
    this._metaI32[id * EntityPool.Layout.META_LANES + EntityPool.Layout.M.STATUS] =
      this.encodeNextFree(this._freeHead);
    this._freeHead = id;
    this._count--;

    if (writeToGPU) this.writeEntityToGPU(id);
  }

  /** Basic consistency checks. */
  validate(): void {
    if (!this.isAlive(0))
      throw new Error("validate: null entity (0) must be alive");
    if ((this._gpuI32[EntityPool.Layout.G.H_TYPE]! | 0) !== -1)
      throw new Error("validate: entity 0 must be NULL (type = -1)");
    for (let id = 1; id < this._capacity; id++) {
      if (!this.isAlive(id)) continue;
      const t =
        this._gpuI32[id * EntityPool.Layout.GPU_LANES + EntityPool.Layout.G.H_TYPE]! | 0;
      if (
        t !== EntityType.Sphere &&
        t !== EntityType.Box &&
        t !== EntityType.ReduceUnion &&
        t !== EntityType.SimpleUnion &&
        t !== EntityType.SimpleSubtract &&
        t !== EntityType.SimpleIntersection &&
        t !== (EntityType as any).Camera &&
        t !== (EntityType as any).GateBox
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
    const b = id * EntityPool.Layout.GPU_LANES;
    this._gpuI32[b + EntityPool.Layout.G.H_TYPE] = -1;
    this._gpuI32[b + EntityPool.Layout.G.H_XFORM] = -1;
    this._gpuI32[b + EntityPool.Layout.G.H_MAT] = 0;
    this._gpuI32[b + EntityPool.Layout.G.H_FLAGS] = 0;
    for (let i = 0; i < 8; i++) this._gpuF32[b + 4 + i] = 0;
    this._metaI32[id * EntityPool.Layout.META_LANES + EntityPool.Layout.M.STATUS] = id;
  }

  private zeroGPU12(base: number) {
    for (let i = 0; i < EntityPool.Layout.GPU_LANES; i++) this._gpuF32[base + i] = 0;
  }
  private allocSlot(): number {
    if (this._freeHead === EntityPool.SENTINEL) this.grow();
    const id = this._freeHead;
    const mb = id * EntityPool.Layout.META_LANES;
    const next = this.decodeNextFree(this._metaI32[mb + EntityPool.Layout.M.STATUS]!);
    this._freeHead = next;
    this._metaI32[mb + EntityPool.Layout.M.STATUS] = id;
    return id;
  }

  /** Resize capacity; if a GPU buffer exists, recreate it (which bumps version). */
  private grow(): void {
    const oldCap = this._capacity;
    const newCap = Math.max(2, oldCap << 1);

    const newGpu = new ArrayBuffer(newCap * EntityPool.Layout.BYTES_PER_GPU_ENTRY);
    const ngF32 = new Float32Array(newGpu);
    const ngI32 = new Int32Array(newGpu);
    ngF32.set(this._gpuF32);

    const newMeta = new ArrayBuffer(newCap * EntityPool.Layout.BYTES_PER_META_ENTRY);
    const nmI32 = new Int32Array(newMeta);
    nmI32.set(this._metaI32);

    let head = this._freeHead;
    for (let id = newCap - 1; id >= oldCap; id--) {
      const b = id * EntityPool.Layout.GPU_LANES;
      for (let i = 0; i < EntityPool.Layout.GPU_LANES; i++) ngF32[b + i] = 0;
      nmI32[id * EntityPool.Layout.META_LANES + EntityPool.Layout.M.STATUS] =
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
      (this._metaI32[id * EntityPool.Layout.META_LANES + EntityPool.Layout.M.STATUS]! | 0) >= 0
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

  private packInto(id: number, e: Entity): void {
    const b = id * EntityPool.Layout.GPU_LANES;
    for (let i = 4; i <= 11; i++)
      this._gpuF32[b + i] = 0;

    switch (e.type) {
      case EntityType.Camera: {
        const cam = e as CameraEnt;
        this._gpuI32[b + EntityPool.Layout.G.H_TYPE] = EntityType.Camera;
        this._gpuI32[b + EntityPool.Layout.G.H_XFORM] = cam.xformID | 0;
        this._gpuI32[b + EntityPool.Layout.G.H_MAT] = -1;
        this._gpuI32[b + EntityPool.Layout.G.H_FLAGS] = 0;
        break;
      }
      case EntityType.Sphere: {
        const s = e as SphereEnt;
        this._gpuI32[b + EntityPool.Layout.G.H_TYPE] = EntityType.Sphere;
        this._gpuI32[b + EntityPool.Layout.G.H_XFORM] = s.xformID | 0;
        this._gpuI32[b + EntityPool.Layout.G.H_MAT] = s.material ?? -1;
        this._gpuI32[b + EntityPool.Layout.G.H_FLAGS] = 0;
        this._gpuF32[b + EntityPool.Layout.G.V0X] = s.radius;
        break;
      }
      case EntityType.Box: {
        const bx = e as BoxEnt;
        this._gpuI32[b + EntityPool.Layout.G.H_TYPE] = EntityType.Box;
        this._gpuI32[b + EntityPool.Layout.G.H_XFORM] = bx.xformID | 0;
        this._gpuI32[b + EntityPool.Layout.G.H_MAT] = (bx.material ?? 0) | 0;
        this._gpuI32[b + EntityPool.Layout.G.H_FLAGS] = 0;
        this._gpuF32[b + EntityPool.Layout.G.V0X] = bx.bounds.x;
        this._gpuF32[b + EntityPool.Layout.G.V0Y] = bx.bounds.y;
        this._gpuF32[b + EntityPool.Layout.G.V0Z] = bx.bounds.z;
        break;
      }
      case EntityType.ReduceUnion: {
        const ru = e as ReduceUnionEnt;
        this._gpuI32[b + EntityPool.Layout.G.H_TYPE] = EntityType.ReduceUnion;
        this._gpuI32[b + EntityPool.Layout.G.H_XFORM] = -1;
        this._gpuI32[b + EntityPool.Layout.G.H_MAT] = ru.children;
        this._gpuI32[b + EntityPool.Layout.G.H_FLAGS] = 0;
        break;
      }
      case EntityType.SimpleUnion:
      case EntityType.SimpleSubtract:
      case EntityType.SimpleIntersection: {
        const t = e.type;
        this._gpuI32[b + EntityPool.Layout.G.H_TYPE] = t;
        this._gpuI32[b + EntityPool.Layout.G.H_XFORM] = -1;
        this._gpuI32[b + EntityPool.Layout.G.H_MAT] = 0;
        this._gpuI32[b + EntityPool.Layout.G.H_FLAGS] = 0;
        break;
      }
      case EntityType.GateBox: {
        const gx = e as GateBox;
        this._gpuI32[b + EntityPool.Layout.G.H_TYPE] = EntityType.GateBox;
        this._gpuI32[b + EntityPool.Layout.G.H_XFORM] = gx.xformID | 0;
        this._gpuI32[b + EntityPool.Layout.G.H_MAT] = 0;
        this._gpuI32[b + EntityPool.Layout.G.H_FLAGS] = EntityPool.FLAG_HAS_GATE;
        this._gpuF32[b + EntityPool.Layout.G.V0X] = gx.bounds.x;
        this._gpuF32[b + EntityPool.Layout.G.V0Y] = gx.bounds.y;
        this._gpuF32[b + EntityPool.Layout.G.V0Z] = gx.bounds.z;
        break;
      }
      default:
        throw new Error(`packInto: unsupported entity type ${(e as any).type}`);
    }

    this._metaI32[id * EntityPool.Layout.META_LANES + EntityPool.Layout.M.STATUS] = id;
  }

  private unpackFrom(id: number): Entity {
    const b = id * EntityPool.Layout.GPU_LANES;
    const type = this._gpuI32[b + EntityPool.Layout.G.H_TYPE]! | 0;

    switch (type) {
      case EntityType.Sphere: {
        const xformID = this._gpuI32[b + EntityPool.Layout.G.H_XFORM]! | 0;
        const material = this._gpuI32[b + EntityPool.Layout.G.H_MAT]! | 0;
        const radius = this._gpuF32[b + EntityPool.Layout.G.V0X]!;
        return { type: EntityType.Sphere, xformID, material, radius };
      }
      case EntityType.Box: {
        const xformID = this._gpuI32[b + EntityPool.Layout.G.H_XFORM]! | 0;
        const material = this._gpuI32[b + EntityPool.Layout.G.H_MAT]! | 0;
        const bounds = {
          x: this._gpuF32[b + EntityPool.Layout.G.V0X],
          y: this._gpuF32[b + EntityPool.Layout.G.V0Y],
          z: this._gpuF32[b + EntityPool.Layout.G.V0Z],
        } as Vector3;
        return { type: EntityType.Box, material, xformID, bounds };
      }
      case EntityType.ReduceUnion: {
        const children = this._gpuI32[b + EntityPool.Layout.G.H_MAT]! | 0;
        return { type: EntityType.ReduceUnion, children };
      }
      case EntityType.SimpleUnion:
        return { type: EntityType.SimpleUnion } as SimpleUnionEnt;
      case EntityType.SimpleSubtract:
        return { type: EntityType.SimpleSubtract } as SimpleSubtractEnt;
      case EntityType.SimpleIntersection:
        return { type: EntityType.SimpleIntersection } as SimpleIntersectionEnt;
      case EntityType.Camera: {
        const xformID = this._gpuI32[b + EntityPool.Layout.G.H_XFORM]! | 0;
        return { type: EntityType.Camera, xformID } as CameraEnt;
      }
      case EntityType.GateBox: {
        const xformID = this._gpuI32[b + EntityPool.Layout.G.H_XFORM]! | 0;
        const bounds = {
          x: this._gpuF32[b + EntityPool.Layout.G.V0X],
          y: this._gpuF32[b + EntityPool.Layout.G.V0Y],
          z: this._gpuF32[b + EntityPool.Layout.G.V0Z],
        } as Vector3;
        return { type: EntityType.GateBox, xformID, bounds } as GateBox;
      }
      case -1:
        return { type: EntityType.SimpleUnion } as SimpleUnionEnt;
      default:
        throw new Error(`unpackFrom: unknown entity type ${type} at ${id}`);
    }
  }
}

// Node layout (GPU mirror):
//   0: entityIndex (i32)
//   1: childIndex   (i32)
//   2: siblingIndex (i32)
//   3: flags        (u32)
//
// Meta layout (CPU-only):
//   0: parentIndex  (i32)  -1 if none
//   1: STATUS       (i32)  >=0 alive; <0 means FREE (free-list link = -2 - nextId)

export class NodeTree {
  static readonly Layout = {
    G: {
      ENTITY_INDEX: 0, CHILD: 1, SIB: 2, FLAGS: 3
    },
    GPU_LANES: 4,
    BYTES_PER_GPU_NODE: 4 * 4,
    M: {
      PARENT: 0, STATUS: 1, XFORM_INDEX: 2
    },
    META_LANES: 3,
    BYTES_PER_META_NODE: 3 * 4,
  } as const;

  private static readonly SENTINEL = -1;

  // CPU-side GPU mirror
  private _gpuMirrorBuffer: ArrayBuffer;
  private _gpuI32: Int32Array;
  private _gpuU32: Uint32Array;

  // CPU-only meta
  private _metaBuffer: ArrayBuffer;
  private _metaI32: Int32Array;

  private _capacity: number;
  private _count: number;
  private _freeHead: number;

  private _device: GPUDevice | null = null;
  private _gpuBuffer: GPUBuffer | null = null;
  private _version = 0;

  constructor(initialCapacity = 1024) {
    if (initialCapacity < 1) initialCapacity = 1;
    this._capacity = initialCapacity;

    this._gpuMirrorBuffer = new ArrayBuffer(this._capacity * NodeTree.Layout.BYTES_PER_GPU_NODE);
    this._gpuI32 = new Int32Array(this._gpuMirrorBuffer);
    this._gpuU32 = new Uint32Array(this._gpuMirrorBuffer);

    this._metaBuffer = new ArrayBuffer(this._capacity * NodeTree.Layout.BYTES_PER_META_NODE);
    this._metaI32 = new Int32Array(this._metaBuffer);

    this._count = 0;
    this._freeHead = NodeTree.SENTINEL;

    for (let id = this._capacity - 1; id >= 1; id--) {
      const gI = id * NodeTree.Layout.GPU_LANES;
      this._gpuI32[gI + NodeTree.Layout.G.ENTITY_INDEX] = 0;
      this._gpuI32[gI + NodeTree.Layout.G.CHILD] = -1;
      this._gpuI32[gI + NodeTree.Layout.G.SIB]   = -1;
      this._gpuU32[gI + NodeTree.Layout.G.FLAGS] = 0;

      const mI = id * NodeTree.Layout.META_LANES;
      this._metaI32[mI + NodeTree.Layout.M.PARENT] = -1;
      this._metaI32[mI + NodeTree.Layout.M.STATUS] = this.encodeNextFree(this._freeHead);
      this._freeHead = id;
    }

    this.initNodeAlive(0, 0, -1, -1, -1, 0, -1);
    this._count = 1;
  }

  get size() { return this._count; }
  get capacity() { return this._capacity; }
  get root() { return 0; }
  get version() { return this._version; }

  getBufferViews() {
    return {
      gpuMirrorBuffer: this._gpuMirrorBuffer,
      gpuI32: this._gpuI32,
      gpuU32: this._gpuU32,
      GPU_STRIDE: NodeTree.Layout.GPU_LANES,
      metaBuffer: this._metaBuffer,
      metaI32: this._metaI32,
      META_STRIDE: NodeTree.Layout.META_LANES,
    };
  }

  /** Create a GPUBuffer, upload all nodes, store it, and bump version. */
  createGPUBuffer(
    device: GPUDevice,
    usage: GPUBufferUsageFlags = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  ): GPUBuffer {
    this._device = device;
    if (this._gpuBuffer) { 
        try { this._gpuBuffer.destroy(); } 
        catch {} this._gpuBuffer = null; }
    const size = Math.max(16, this._capacity * NodeTree.Layout.BYTES_PER_GPU_NODE);
    this._gpuBuffer = device.createBuffer({ size, usage, mappedAtCreation: false });
    this.writeAllToGPU();
    this._version++;
    return this._gpuBuffer;
  }
  
  getGPUBuffer(){
    return this._gpuBuffer
  }

  /** Upload entire node buffer. */
  writeAllToGPU(): void {
    if (!this._device || !this._gpuBuffer) 
      return;
    this._device.queue.writeBuffer(this._gpuBuffer, 0, this._gpuMirrorBuffer);
  }

  /** Upload a single node. */
  private writeNodeToGPU(id: number): void {
    if (!this._device || !this._gpuBuffer) 
      return;
    const byteOffset = id * NodeTree.Layout.BYTES_PER_GPU_NODE;
    const bytes = new Uint8Array(this._gpuMirrorBuffer, byteOffset, NodeTree.Layout.BYTES_PER_GPU_NODE);
    this._device.queue.writeBuffer(this._gpuBuffer, byteOffset, bytes);
  }

  // ----- public API -----

  addChild(parentId: number, flags = 0, index = 0, xformId = -1, writeToGPU = true): number {
    this.assertAlive(parentId);

    const preferred = parentId + 1;
    const id = this.allocNear(preferred, 128);

    const pChild = this._gpuI32[parentId * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.CHILD]! | 0;

    this.initNodeAlive(id, index, parentId, -1, pChild, flags, xformId);
    this._gpuI32[parentId * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.CHILD] = id;

    this._count++;

    if (writeToGPU) {
      this.writeNodeToGPU(id);
      this.writeNodeToGPU(parentId);
    }
    return id;
  }

  setFlags(id: number, flags: number, writeToGPU = true) {
    this.assertAlive(id);
    this._gpuU32[id * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.FLAGS] = flags >>> 0;
    if (writeToGPU) this.writeNodeToGPU(id);
  }

  getFlags(id: number) {
    this.assertAlive(id);
    return this._gpuU32[id * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.FLAGS]! >>> 0;
  }

  setEntityIndex(id: number, index: number, writeToGPU = true) {
    this.assertAlive(id);
    this._gpuI32[id * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.ENTITY_INDEX] = index | 0;
    if (writeToGPU) this.writeNodeToGPU(id);
  }

  getEntityIndex(id: number) {
    this.assertAlive(id);
    return this._gpuI32[id * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.ENTITY_INDEX]! | 0;
  }

  setXformIndex(id: number, xformID: number){
    this.assertAlive(id);
    this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.XFORM_INDEX] = xformID;
  }

  getXformIndex(id: number){
    this.assertAlive(id);
    return this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.XFORM_INDEX]!;
  }

  deleteSubtree(id: number, writeToGPU = true) {
    this.assertAlive(id);

    if (id === 0) {
      const toFree: number[] = [];
      for (let c = this._gpuI32[NodeTree.Layout.G.CHILD]! | 0;
           c !== -1;
           c = this._gpuI32[c * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.SIB]! | 0) {
        this.collectSubtreeIds(c, toFree);
      }
      this._gpuI32[NodeTree.Layout.G.CHILD] = -1;
      if (writeToGPU) this.writeNodeToGPU(0);
      for (const nid of toFree) this.freeSlot(nid, writeToGPU);
      this._count = 1;
      return;
    }

    const p = this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.PARENT]! | 0;
    const pChild = this._gpuI32[p * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.CHILD]! | 0;

    if (pChild === id) {
      const next = this._gpuI32[id * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.SIB]! | 0;
      this._gpuI32[p * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.CHILD] = next;
      if (writeToGPU) this.writeNodeToGPU(p);
    } else {
      let s = pChild;
      while (s !== -1 &&
             (this._gpuI32[s * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.SIB]! | 0) !== id) {
        s = this._gpuI32[s * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.SIB]! | 0;
      }
      if (s === -1) throw new Error(`deleteSubtree: node ${id} not found`);
      const next = this._gpuI32[id * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.SIB]! | 0;
      this._gpuI32[s * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.SIB] = next;
      if (writeToGPU) this.writeNodeToGPU(s);
    }

    const toFree: number[] = [];
    this.collectSubtreeIds(id, toFree);
    for (const nid of toFree) this.freeSlot(nid, writeToGPU);
    this._count -= toFree.length;
  }

  snapshot(id: number) {
    this.assertAlive(id);
    const gb = id * NodeTree.Layout.GPU_LANES;
    const mb = id * NodeTree.Layout.META_LANES;
    return {
      id,
      entity: this._gpuI32[gb + NodeTree.Layout.G.ENTITY_INDEX]! | 0,
      parent:  this._metaI32[mb + NodeTree.Layout.M.PARENT]! | 0,
      child:   this._gpuI32[gb + NodeTree.Layout.G.CHILD]! | 0,
      sibling: this._gpuI32[gb + NodeTree.Layout.G.SIB]! | 0,
      flags:   this._gpuU32[gb + NodeTree.Layout.G.FLAGS]! >>> 0,
      status:  this._metaI32[mb + NodeTree.Layout.M.STATUS]! | 0,
    };
  }

  *children(id: number): Iterable<number> {
    this.assertAlive(id);
    for (let c = this._gpuI32[id * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.CHILD]! | 0;
         c !== -1;
         c = this._gpuI32[c * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.SIB]! | 0) {
      yield c;
    }
  }

  validate() {
    if (!this.nodeAlive(0)) throw new Error("validate: root not alive");
    if ((this._metaI32[0 * NodeTree.Layout.META_LANES + NodeTree.Layout.M.PARENT]! | 0) !== -1)
      throw new Error("validate: root has parent");

    for (let p = 0; p < this._capacity; p++) {
      if (!this.nodeAlive(p)) continue;
      const seen = new Set<number>();
      let c = this._gpuI32[p * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.CHILD]! | 0;
      while (c !== -1) {
        if (!this.nodeAlive(c)) throw new Error(`validate: dead child ${c} under parent ${p}`);
        const back = this._metaI32[c * NodeTree.Layout.META_LANES + NodeTree.Layout.M.PARENT]! | 0;
        if (back !== p) throw new Error(`validate: bad parent link child ${c} -> ${back}, expected ${p}`);
        if (seen.has(c)) throw new Error(`validate: sibling cycle at child ${c} of parent ${p}`);
        seen.add(c);
        c = this._gpuI32[c * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.SIB]! | 0;
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
    this._gpuI32 = new Int32Array(newGpu);
    this._gpuU32 = new Uint32Array(newGpu);
    this._metaBuffer = newMeta;
    this._metaI32 = new Int32Array(newMeta);
    this._count = newCount;
    this._freeHead = newFreeHead;
    this._version++;
    if (writeToGPU && this._device && this._gpuBuffer) this.writeAllToGPU();
  }

  // ----- internals -----

  private initNodeAlive(id: number, index: number, parent: number, child: number, sibling: number, flags: number, xform: number) {
    const gb = id * NodeTree.Layout.GPU_LANES;
    this._gpuI32[gb + NodeTree.Layout.G.ENTITY_INDEX] = index | 0;
    this._gpuI32[gb + NodeTree.Layout.G.CHILD] = child | 0;
    this._gpuI32[gb + NodeTree.Layout.G.SIB]   = sibling | 0;
    this._gpuU32[gb + NodeTree.Layout.G.FLAGS] = flags >>> 0;

    const mb = id * NodeTree.Layout.META_LANES;
    this._metaI32[mb + NodeTree.Layout.M.PARENT] = parent | 0;
    this._metaI32[mb + NodeTree.Layout.M.STATUS] = id;
    this._metaI32[mb + NodeTree.Layout.M.XFORM_INDEX] =  xform;
  }

  private nodeAlive(id: number): boolean {
    if (id < 0 || id >= this._capacity)
       return false;
    return (this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATUS]! | 0) >= 0;
  }
  private assertAlive(id: number) {
    if (!this.nodeAlive(id)) throw new Error(`Node ${id} is not alive`);
  }

  private allocSlot(): number {
    if (this._freeHead === -1) this.grow();
    const id = this._freeHead;
    const next = this.decodeNextFree(this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATUS]! | 0);
    this._freeHead = next;
    return id;
  }

  private freeSlot(id: number, writeToGPU: boolean) {
    const gb = id * NodeTree.Layout.GPU_LANES;
    this._gpuI32[gb + NodeTree.Layout.G.ENTITY_INDEX] = 0;
    this._gpuI32[gb + NodeTree.Layout.G.CHILD] = -1;
    this._gpuI32[gb + NodeTree.Layout.G.SIB]   = -1;
    this._gpuU32[gb + NodeTree.Layout.G.FLAGS] = 0;

    const mb = id * NodeTree.Layout.META_LANES;
    this._metaI32[mb + NodeTree.Layout.M.PARENT] = -1;
    this._metaI32[mb + NodeTree.Layout.M.STATUS] = this.encodeNextFree(this._freeHead);
    this._metaI32[mb + NodeTree.Layout.M.XFORM_INDEX] = -1;
    this._freeHead = id;

    if (writeToGPU) this.writeNodeToGPU(id);
  }

  private decodeNextFree(enc: number) { return -enc - 2; }
  private encodeNextFree(nextId: number) { return -2 - (nextId === -1 ? -1 : nextId); }

  private isFree(id: number) {
    if (id <= 0 || id >= this._capacity)
       return false;
    return (this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATUS]! | 0) < 0;
  }

  private tryStealFree(id: number): number {
    if (!this.isFree(id))
       return -1;
    if (this._freeHead === id) {
      this._freeHead = this.decodeNextFree(this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATUS]! | 0);
      return id;
    }
    let prev = this._freeHead;
    while (prev !== -1) {
      const next = this.decodeNextFree(this._metaI32[prev * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATUS]! | 0);
      if (next === id) {
        const nextNext = this.decodeNextFree(this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATUS]! | 0);
        this._metaI32[prev * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATUS] = this.encodeNextFree(nextNext);
        return id;
      }
      prev = next;
    }
    return -1;
  }

  private allocNear(preferId: number, window = 64): number {
    if (preferId > 0 && preferId < this._capacity) {
      const s = this.tryStealFree(preferId);
      if (s !== -1)
         return s;
    }
    const start = Math.max(preferId + 1, 1);
    const upper = Math.min(this._capacity - 1, start + window);
    for (let id = start; id <= upper; id++) {
      const s = this.tryStealFree(id);
      if (s !== -1)
        return s;
    }
    return this.allocSlot();
  }

  private collectSubtreeIds(id: number, out: number[]) {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      out.push(cur);
      for (let c = this._gpuI32[cur * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.CHILD]! | 0;
           c !== -1;
           c = this._gpuI32[c * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.SIB]! | 0) {
        stack.push(c);
      }
    }
  }

  /** Grow capacity; recreate GPU buffer if present (bumps version via createGPUBuffer). */
  private grow() {
    const oldCap = this._capacity;
    const newCap = Math.max(2, oldCap << 1);

    const newGpu = new ArrayBuffer(newCap * NodeTree.Layout.BYTES_PER_GPU_NODE);
    const nGI32 = new Int32Array(newGpu);
    const nGU32 = new Uint32Array(newGpu);
    nGI32.set(this._gpuI32);
    nGU32.set(this._gpuU32);

    const newMeta = new ArrayBuffer(newCap * NodeTree.Layout.BYTES_PER_META_NODE);
    const nMI32 = new Int32Array(newMeta);
    nMI32.set(this._metaI32);

    let head = this._freeHead;
    for (let id = newCap - 1; id >= oldCap; id--) {
      const gb = id * NodeTree.Layout.GPU_LANES;
      nGI32[gb + NodeTree.Layout.G.ENTITY_INDEX] = 0;
      nGI32[gb + NodeTree.Layout.G.CHILD] = -1;
      nGI32[gb + NodeTree.Layout.G.SIB]   = -1;
      nGU32[gb + NodeTree.Layout.G.FLAGS] = 0;

      const mb = id * NodeTree.Layout.META_LANES;
      nMI32[mb + NodeTree.Layout.M.PARENT] = -1;
      nMI32[mb + NodeTree.Layout.M.STATUS] = this.encodeNextFree(head);
      nMI32[mb + NodeTree.Layout.M.XFORM_INDEX] = -1;
      head = id;
    }

    this._gpuMirrorBuffer = newGpu;
    this._gpuI32 = nGI32;
    this._gpuU32 = nGU32;
    this._metaBuffer = newMeta;
    this._metaI32 = nMI32;

    this._capacity = newCap;
    this._freeHead = head;

    if (this._device)
      this.createGPUBuffer(this._device);
  }
}

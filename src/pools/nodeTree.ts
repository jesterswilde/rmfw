// NodeTree.ts
// Stable static IDs stored per-node (meta buffer) + a single id->index table
// that doubles as a FIFO free-list via encoded next pointers when an ID is free.

export class NodeTree {
  static readonly Layout = {
    G: {
      ENTITY_INDEX: 0, CHILD: 1, SIB: 2, FLAGS: 3
    },
    GPU_LANES: 4,
    BYTES_PER_GPU_NODE: 4 * 4,

    // Meta (CPU-only)
    M: {
      PARENT: 0,
      STATUS: 1,        // >=0 alive; <0 means FREE (free-list link = -2 - nextId)
      XFORM_INDEX: 2,
      STATIC_ID: 3,
    },
    META_LANES: 4,
    BYTES_PER_META_NODE: 4 * 4,
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

  // Stable ID machinery (single array does both: mapping and free list)
  // If >=0: id is owned and maps to that internal index
  // If <0:  id is free and stores encoded "next" pointer (linked list)
  private _idToIndex: Int32Array;   // STATIC_ID -> internal index or encoded next
  private _idFreeHead: number;      // head STATIC_ID of FIFO free list, or -1
  private _idFreeTail: number;      // tail STATIC_ID of FIFO free list, or -1

  private _device: GPUDevice | null = null;
  private _gpuBuffer: GPUBuffer | null = null;
  private _version = 0;

  constructor(initialCapacity = 1024) {
    if (initialCapacity < 1) initialCapacity = 1;
    this._capacity = initialCapacity;

    // GPU-side mirror
    this._gpuMirrorBuffer = new ArrayBuffer(this._capacity * NodeTree.Layout.BYTES_PER_GPU_NODE);
    this._gpuI32 = new Int32Array(this._gpuMirrorBuffer);
    this._gpuU32 = new Uint32Array(this._gpuMirrorBuffer);

    // Meta
    this._metaBuffer = new ArrayBuffer(this._capacity * NodeTree.Layout.BYTES_PER_META_NODE);
    this._metaI32 = new Int32Array(this._metaBuffer);

    this._count = 0;
    this._freeHead = NodeTree.SENTINEL;

    // Initialize non-root indices as free stack (unchanged behavior)
    for (let id = this._capacity - 1; id >= 1; id--) {
      const gI = id * NodeTree.Layout.GPU_LANES;
      this._gpuI32[gI + NodeTree.Layout.G.ENTITY_INDEX] = 0;
      this._gpuI32[gI + NodeTree.Layout.G.CHILD] = -1;
      this._gpuI32[gI + NodeTree.Layout.G.SIB]   = -1;
      this._gpuU32[gI + NodeTree.Layout.G.FLAGS] = 0;

      const mI = id * NodeTree.Layout.META_LANES;
      this._metaI32[mI + NodeTree.Layout.M.PARENT] = -1;
      this._metaI32[mI + NodeTree.Layout.M.STATUS] = this.encodeNextFree(this._freeHead);
      this._metaI32[mI + NodeTree.Layout.M.XFORM_INDEX] = -1;
      this._metaI32[mI + NodeTree.Layout.M.STATIC_ID]   = -1;
      this._freeHead = id;
    }

    // Root node (index 0) comes alive immediately with STATIC_ID 0
    this.initNodeAlive(0, 0, -1, -1, -1, 0, -1, 0);
    this._count = 1;

    // ----- Stable IDs: single array used both for map and free-list -----
    this._idToIndex = new Int32Array(this._capacity);

    // Reserve STATIC_ID 0 for the root
    this._idToIndex[0] = 0;

    // Seed FIFO free list with IDs [1..capacity-1]
    if (this._capacity > 1) {
      this._idFreeHead = 1;
      this._idFreeTail = this._capacity - 1;
      for (let sid = 1; sid < this._capacity; sid++) {
        const next = (sid + 1 < this._capacity) ? (sid + 1) : -1;
        this._idToIndex[sid] = this.encodeNextFreeExt(next); // mark as free; link to next
      }
    } else {
      this._idFreeHead = -1;
      this._idFreeTail = -1;
    }
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

      // Stable ID debug/inspection
      idToIndex: this._idToIndex,
      idFreeHead: this._idFreeHead,
      idFreeTail: this._idFreeTail,
    };
  }

  /** Create a GPUBuffer, upload all nodes, store it, and bump version. */
  createGPUBuffer(
    device: GPUDevice,
    usage: GPUBufferUsageFlags = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  ): GPUBuffer {
    this._device = device;
    if (this._gpuBuffer) {
      try { this._gpuBuffer.destroy(); } catch {}
      this._gpuBuffer = null;
    }
    const size = Math.max(16, this._capacity * NodeTree.Layout.BYTES_PER_GPU_NODE);
    this._gpuBuffer = device.createBuffer({ size, usage, mappedAtCreation: false });
    this.writeAllToGPU();
    this._version++;
    return this._gpuBuffer;
  }

  getGPUBuffer() { return this._gpuBuffer; }

  /** Upload entire node buffer (GPU-visible lanes only). */
  writeAllToGPU(): void {
    if (!this._device || !this._gpuBuffer) return;
    this._device.queue.writeBuffer(this._gpuBuffer, 0, this._gpuMirrorBuffer);
  }

  /** Upload a single node (GPU-visible lanes only). */
  private writeNodeToGPU(id: number): void {
    if (!this._device || !this._gpuBuffer) return;
    const byteOffset = id * NodeTree.Layout.BYTES_PER_GPU_NODE;
    const bytes = new Uint8Array(this._gpuMirrorBuffer, byteOffset, NodeTree.Layout.BYTES_PER_GPU_NODE);
    this._device.queue.writeBuffer(this._gpuBuffer, byteOffset, bytes);
  }

  // ----- public API -----

  /** Create child under `parentId`. Returns INTERNAL index. */
  addChild(parentId: number, flags = 0, index = 0, xformId = -1, writeToGPU = true): number {
    this.assertAlive(parentId);

    const preferred = parentId + 1;
    const id = this.allocNear(preferred, 128);

    const pChild = this._gpuI32[parentId * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.CHILD]! | 0;

    // Grab a STATIC_ID from the FIFO (dequeue head)
    let sid = this.idDequeueHead();
    if (sid === -1) {
      // Ensure more IDs exist by growing capacity, then try again
      this.grow();
      sid = this.idDequeueHead();
      if (sid === -1) throw new Error("addChild: No static IDs available after grow()");
    }

    this.initNodeAlive(id, index, parentId, -1, pChild, flags, xformId, sid);
    this._gpuI32[parentId * NodeTree.Layout.GPU_LANES + NodeTree.Layout.G.CHILD] = id;

    // Bind mapping: id now owned by this index
    this._idToIndex[sid] = id;

    this._count++;

    if (writeToGPU) {
      this.writeNodeToGPU(id);
      this.writeNodeToGPU(parentId);
    }
    return id;
  }

  /** Returns the stable ID for an internal index, or -1 if none. */
  getStaticIdForIndex(internalIndex: number): number {
    this.assertAlive(internalIndex);
    return this._metaI32[internalIndex * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATIC_ID]! | 0;
  }

  /** Resolve a stable ID to an internal index (or -1 if not alive). */
  resolveIndexFromStaticId(staticId: number): number {
    if (staticId < 0 || staticId >= this._idToIndex.length) return -1;
    const v = this._idToIndex[staticId]! | 0;
    if (v < 0) return -1; // free: negative means it's in the free list
    // sanity: ensure node still owns that staticId
    const sid = this._metaI32[v * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATIC_ID]! | 0;
    return (sid === staticId && this.nodeAlive(v)) ? v : -1;
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

  setXformIndex(id: number, xformID: number) {
    this.assertAlive(id);
    this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.XFORM_INDEX] = xformID | 0;
  }

  getXformIndex(id: number) {
    this.assertAlive(id);
    return this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.XFORM_INDEX]! | 0;
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
      staticId:this._metaI32[mb + NodeTree.Layout.M.STATIC_ID]! | 0,
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

    // Validate ID mapping integrity
    for (let idx = 0; idx < this._capacity; idx++) {
      if (!this.nodeAlive(idx)) continue;
      const sid = this._metaI32[idx * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATIC_ID]! | 0;
      if (sid < 0) throw new Error(`validate: alive node ${idx} has no STATIC_ID`);
      if ((this._idToIndex[sid]! | 0) !== idx) throw new Error(`validate: idToIndex mismatch for sid ${sid}`);
    }
  }

  /** Replace internal buffers with new ones (used by repack). Also rebuild stable IDs. */
  replaceBuffers(
    newGpu: ArrayBuffer,
    newMeta: ArrayBuffer,
    newCount: number,
    newFreeHead: number,
    writeToGPU = true
  ): void {
    // Swap buffers & counters
    this._gpuMirrorBuffer = newGpu;
    this._gpuI32 = new Int32Array(newGpu);
    this._gpuU32 = new Uint32Array(newGpu);
    this._metaBuffer = newMeta;
    this._metaI32 = new Int32Array(newMeta);

    this._count = newCount;
    this._freeHead = newFreeHead;

    // Rebuild stable IDs (map + FIFO) from meta
    this.rebuildStableIdsFromMeta();

    this._version++;
    if (writeToGPU && this._device && this._gpuBuffer) this.writeAllToGPU();
  }

  // ----- internals -----

  private initNodeAlive(id: number, index: number, parent: number, child: number, sibling: number, flags: number, xform: number, staticId: number) {
    const gb = id * NodeTree.Layout.GPU_LANES;
    this._gpuI32[gb + NodeTree.Layout.G.ENTITY_INDEX] = index | 0;
    this._gpuI32[gb + NodeTree.Layout.G.CHILD] = child | 0;
    this._gpuI32[gb + NodeTree.Layout.G.SIB]   = sibling | 0;
    this._gpuU32[gb + NodeTree.Layout.G.FLAGS] = flags >>> 0;

    const mb = id * NodeTree.Layout.META_LANES;
    this._metaI32[mb + NodeTree.Layout.M.PARENT] = parent | 0;
    this._metaI32[mb + NodeTree.Layout.M.STATUS] = id;
    this._metaI32[mb + NodeTree.Layout.M.XFORM_INDEX] =  xform | 0;
    this._metaI32[mb + NodeTree.Layout.M.STATIC_ID]   =  staticId | 0;
  }

  private nodeAlive(id: number): boolean {
    if (id < 0 || id >= this._capacity) return false;
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
    // Release stable ID (enqueue at tail)
    const mb = id * NodeTree.Layout.META_LANES;
    const sid = this._metaI32[mb + NodeTree.Layout.M.STATIC_ID]! | 0;
    if (sid >= 0) {
      this.idEnqueueTail(sid);
      this._metaI32[mb + NodeTree.Layout.M.STATIC_ID] = -1;
    }

    const gb = id * NodeTree.Layout.GPU_LANES;
    this._gpuI32[gb + NodeTree.Layout.G.ENTITY_INDEX] = 0;
    this._gpuI32[gb + NodeTree.Layout.G.CHILD] = -1;
    this._gpuI32[gb + NodeTree.Layout.G.SIB]   = -1;
    this._gpuU32[gb + NodeTree.Layout.G.FLAGS] = 0;

    this._metaI32[mb + NodeTree.Layout.M.PARENT] = -1;
    this._metaI32[mb + NodeTree.Layout.M.STATUS] = this.encodeNextFree(this._freeHead);
    this._metaI32[mb + NodeTree.Layout.M.XFORM_INDEX] = -1;
    this._freeHead = id;

    if (writeToGPU) this.writeNodeToGPU(id);
  }

  private decodeNextFree(enc: number) { return -enc - 2; }
  private encodeNextFree(nextId: number) { return -2 - (nextId === -1 ? -1 : nextId); }

  /** Is a node slot free (internal free stack)? */
  private isFree(id: number) {
    if (id <= 0 || id >= this._capacity) return false;
    return (this._metaI32[id * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATUS]! | 0) < 0;
  }

  private tryStealFree(id: number): number {
    if (!this.isFree(id)) return -1;
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
      if (s !== -1) return s;
    }
    const start = Math.max(preferId + 1, 1);
    const upper = Math.min(this._capacity - 1, start + window);
    for (let id = start; id <= upper; id++) {
      const s = this.tryStealFree(id);
      if (s !== -1) return s;
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

    // GPU buffers
    const newGpu = new ArrayBuffer(newCap * NodeTree.Layout.BYTES_PER_GPU_NODE);
    const nGI32 = new Int32Array(newGpu);
    const nGU32 = new Uint32Array(newGpu);
    nGI32.set(this._gpuI32);
    nGU32.set(this._gpuU32);

    // Meta buffer
    const newMeta = new ArrayBuffer(newCap * NodeTree.Layout.BYTES_PER_META_NODE);
    const nMI32 = new Int32Array(newMeta);
    nMI32.set(this._metaI32);

    // Initialize new node slots as free stack
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
      nMI32[mb + NodeTree.Layout.M.STATIC_ID] = -1;
      head = id;
    }

    // Swap in buffers
    this._gpuMirrorBuffer = newGpu;
    this._gpuI32 = nGI32;
    this._gpuU32 = nGU32;
    this._metaBuffer = newMeta;
    this._metaI32 = nMI32;

    this._capacity = newCap;
    this._freeHead = head;

    // ----- Grow stable ID space: append new IDs to FIFO tail -----
    const oldArr = this._idToIndex;
    this._idToIndex = new Int32Array(newCap);
    this._idToIndex.set(oldArr);

    if (oldCap < newCap) {
      const first = Math.max(1, oldCap);
      if (first < newCap) {
        // Chain new free IDs [first..newCap-1]
        for (let sid = first; sid < newCap; sid++) {
          const next = (sid + 1 < newCap) ? (sid + 1) : -1;
          this._idToIndex[sid] = this.encodeNextFreeExt(next); // mark as free; link
        }
        if (this._idFreeTail === -1) {
          // No free IDs existed before
          this._idFreeHead = first;
          this._idFreeTail = newCap - 1;
        } else {
          // Link old tail -> first, and move tail
          const oldTail = this._idFreeTail;
          this._idToIndex[oldTail] = this.encodeNextFreeExt(first);
          this._idFreeTail = newCap - 1;
        }
      }
    }

    if (this._device)
      this.createGPUBuffer(this._device);
  }

  // ----- Stable ID FIFO (single-array) -----

  private decodeNextFreeExt(enc: number) { return -enc - 2; }
  private encodeNextFreeExt(nextId: number) { return -2 - (nextId === -1 ? -1 : nextId); }

  /** Dequeue from head: returns STATIC_ID or -1 if none. O(1) */
  private idDequeueHead(): number {
    const head = this._idFreeHead;
    if (head === -1) return -1;
    const next = this.decodeNextFreeExt(this._idToIndex[head]! | 0);
    this._idFreeHead = next;
    if (next === -1) this._idFreeTail = -1;
    // The caller will immediately set _idToIndex[head] to an internal index (>=0).
    return head;
  }

  /** Enqueue at tail: put STATIC_ID back into the free list. O(1) */
  private idEnqueueTail(id: number): void {
    // Mark as free with next = -1
    this._idToIndex[id] = this.encodeNextFreeExt(-1);
    if (this._idFreeTail === -1) {
      this._idFreeHead = this._idFreeTail = id;
    } else {
      // Patch old tail->next to this id, then advance tail
      this._idToIndex[this._idFreeTail] = this.encodeNextFreeExt(id);
      this._idFreeTail = id;
    }
  }

  /** Rebuild id->index and the free FIFO from the meta buffer. */
  private rebuildStableIdsFromMeta(): void {
    const cap = this._capacity;
    if (this._idToIndex.length !== cap) this._idToIndex = new Int32Array(cap);

    // Track which IDs are used
    const used = new Uint8Array(cap);

    for (let i = 0; i < cap; i++)
      this._idToIndex[i] = this.encodeNextFreeExt(-1);

    for (let idx = 0; idx < cap; idx++) {
      if (!this.nodeAlive(idx)) continue;
      let sid = this._metaI32[idx * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATIC_ID]! | 0;
      if (sid < 0 || sid >= cap || used[sid]) {
        // assign a new ID later (we’ll pick from the free set)
        sid = -1;
      }
      if (sid >= 0) {
        this._idToIndex[sid] = idx; // owned
        used[sid] = 1;
      } else {
        // Defer; mark node to receive an ID after we build free queue.
      }
    }

    // Build a list of free IDs
    const freeIds: number[] = [];
    for (let sid = 0; sid < cap; sid++) {
      if (!used[sid]) freeIds.push(sid);
    }

    // Second pass: ensure every alive node has a valid ID
    for (let idx = 0; idx < cap; idx++) {
      if (!this.nodeAlive(idx)) continue;
      let sid = this._metaI32[idx * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATIC_ID]! | 0;
      if (sid < 0 || sid >= cap || this._idToIndex[sid]! < 0 /* means currently in free set */) {
        // Need to (re)assign
        if (freeIds.length === 0) throw new Error("rebuildStableIdsFromMeta: no free IDs available");
        const newSid = freeIds.shift()!;
        this._metaI32[idx * NodeTree.Layout.META_LANES + NodeTree.Layout.M.STATIC_ID] = newSid;
        this._idToIndex[newSid] = idx; // owned
        used[newSid] = 1;
      }
    }

    // Build FIFO from remaining free IDs
    this._idFreeHead = -1;
    this._idFreeTail = -1;
    for (const sid of freeIds) {
      // enqueue tail
      this._idToIndex[sid] = this.encodeNextFreeExt(-1);
      if (this._idFreeTail === -1) {
        this._idFreeHead = this._idFreeTail = sid;
      } else {
        this._idToIndex[this._idFreeTail] = this.encodeNextFreeExt(sid);
        this._idFreeTail = sid;
      }
    }
  }
}
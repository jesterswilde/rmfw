// src/ecs/gpu/baseChannel.ts
// Shared BaseChannel + GPU binding types for ECS→GPU channels.

export type DfsOrder = Int32Array;
export type BindLayoutSpec = GPUBindGroupLayoutEntry & { binding: number };

const BYTES_F32 = 4;

export abstract class BaseChannel {
  protected cpu: ArrayBuffer = new ArrayBuffer(0);
  protected f32 = new Float32Array(0);
  protected i32 = new Int32Array(0); // available for integer payloads

  protected rowSizeBytes = 0;
  protected count = 0;

  protected gpuBuffer: GPUBuffer | null = null;

  // dirty ranges tracked in AoS row index space: [start0,end0,start1,end1,...]
  protected dirtyRanges: number[] = [];

  // epoch for the ORDER (not the store) to decide full repack vs incremental
  protected lastOrderEpoch = -1;

  get sizeBytes(): number {
    return this.count * this.rowSizeBytes;
  }
  get buffer(): GPUBuffer | null {
    return this.gpuBuffer;
  }

  /** Default: read-only storage buffer, compute visibility. Channels can override if needed. */
  layoutEntry(
    binding: number,
    visibility: GPUShaderStageFlags = GPUShaderStage.COMPUTE
  ): BindLayoutSpec {
    return { binding, visibility, buffer: { type: "read-only-storage" } };
  }

  /** Ensure CPU AoS has space for `rows` with a given row size. */
  protected ensureCpu(rows: number, rowSizeBytes: number) {
    const needed = rows * rowSizeBytes;
    if (this.cpu.byteLength >= needed && this.rowSizeBytes === rowSizeBytes) {
      this.count = rows;
      return;
    }
    this.rowSizeBytes = rowSizeBytes | 0;
    const cap = Math.max(needed, 256);
    this.cpu = new ArrayBuffer(cap);
    this.f32 = new Float32Array(this.cpu);
    this.i32 = new Int32Array(this.cpu);
    this.count = rows;
  }

  /** Ensure GPU buffer exists and matches size. */
  createOrResize(device: GPUDevice) {
    const needed = Math.max(this.sizeBytes, 4); // WebGPU dislikes 0-sized buffers
    if (this.gpuBuffer && this.gpuBuffer.size === needed) return false;
    if (this.gpuBuffer) this.gpuBuffer.destroy();
    this.gpuBuffer = device.createBuffer({
      size: needed,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
    this.markAllDirty();
    return true;
  }

  /** Mark a single row dirty (coalesces with tail if adjacent). */
  protected markRowDirty(rowIndex: number) {
    if (rowIndex < 0) return;
    if (this.dirtyRanges.length === 0) {
      this.dirtyRanges.push(rowIndex, rowIndex);
      return;
    }
    const lastEndI = this.dirtyRanges.length - 1;
    const lastEnd = this.dirtyRanges[lastEndI]!;
    if (rowIndex === lastEnd + 1) {
      this.dirtyRanges[lastEndI] = rowIndex; // extend tail
    } else {
      this.dirtyRanges.push(rowIndex, rowIndex);
    }
  }

  /** Mark entire buffer dirty. */
  protected markAllDirty() {
    if (this.count > 0) {
      this.dirtyRanges.length = 0;
      this.dirtyRanges.push(0, this.count - 1);
    }
  }

  /** Merge and upload all queued ranges; clears the queue. */
  flush(queue: GPUQueue) {
    if (!this.gpuBuffer || this.dirtyRanges.length === 0) return;

    // merge adjacent/overlapping (we append in sorted order, so linear pass is fine)
    const merged: [number, number][] = [];
    for (let i = 0; i < this.dirtyRanges.length; i += 2) {
      const a = this.dirtyRanges[i]!,
        b = this.dirtyRanges[i + 1]!;
      if (merged.length === 0) {
        merged.push([a, b]);
        continue;
      }
      const last = merged[merged.length - 1]!;
      if (a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }

    // Fast-path: if merged coverage spans entire buffer, emit one full write
    if (
      merged.length === 1 &&
      merged[0]![0] === 0 &&
      merged[0]![1] === this.count - 1
    ) {
      queue.writeBuffer(this.gpuBuffer!, 0, this.cpu, 0, this.sizeBytes);
      this.dirtyRanges.length = 0;
      return;
    }

    for (const [start, end] of merged) {
      const offset = start * this.rowSizeBytes;
      const size = (end - start + 1) * this.rowSizeBytes;
      queue.writeBuffer(this.gpuBuffer!, offset, this.cpu, offset, size);
    }

    this.dirtyRanges.length = 0;
  }

  /** Channel-specific work: returns true if CPU AoS changed (needs flush). */
  abstract sync(world: any, args: any): boolean;
}

export const BYTES_PER_F32 = BYTES_F32;

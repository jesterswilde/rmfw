// tests/utils/webgpu.mock.ts
// Reusable WebGPU shims + minimal mocks for Node/Jest tests.

export type WriteRecord = { offset: number; size: number };

export function installWebGPUShims(): void {
  const g = global as any;

  // Runtime constants (browser normally provides these)
  if (!g.GPUBufferUsage) {
    g.GPUBufferUsage = {
      COPY_DST: 1 << 0,
      STORAGE:  1 << 1,
      UNIFORM:  1 << 2,
    };
  }
  if (!g.GPUShaderStage) {
    g.GPUShaderStage = {
      VERTEX:   1 << 0,
      FRAGMENT: 1 << 1,
      COMPUTE:  1 << 2,
    };
  }
}

/** Minimal queue that records writeBuffer calls. */
export class MockQueue implements GPUQueue {
  // @ts-ignore
  label: string = "";
  public writes: WriteRecord[] = [];

  writeBuffer(
    _buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBuffer | ArrayBufferView,
    dataOffset?: number,
    size?: number
  ): void {
    const bytes = size ?? (data as ArrayBuffer).byteLength;
    this.writes.push({ offset: bufferOffset | 0, size: bytes | 0 });
  }

  // Optional no-op stubs
  // @ts-ignore
  copyExternalImageToTexture(): void {}
  // @ts-ignore
  submit(): void {}
  // @ts-ignore
  onSubmittedWorkDone(): Promise<void> { return Promise.resolve(); }

  reset() { this.writes.length = 0; }
}

/** Create a minimal GPUDevice backed by the provided queue. */
export function makeMockDevice(queue: GPUQueue): GPUDevice {
  const device: GPUDevice = {
    createBuffer: (desc: { size: number; usage: number }) =>
      ({ size: desc.size, usage: desc.usage, destroy() {} } as unknown as GPUBuffer),

    createBindGroupLayout: (_: { entries: GPUBindGroupLayoutEntry[] }) =>
      ({} as GPUBindGroupLayout),

    createBindGroup: (_: { layout: GPUBindGroupLayout; entries: GPUBindGroupEntry[] }) =>
      ({} as GPUBindGroup),

    queue,
  } as GPUDevice;

  return device;
}

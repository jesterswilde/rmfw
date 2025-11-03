// tests/utils/webgpu.mock.ts
// Reusable WebGPU shims + minimal mocks for Node/Jest tests.

export type WriteRecord = { offset: number; size: number };

export function installWebGPUShims(): void {
  const g = global as any;

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
  // Nominal brand to satisfy newer lib.dom.d.ts
  // @ts-ignore
  readonly __brand: "GPUQueue" = "GPUQueue";
  // @ts-ignore
  label: string = "";

  public writes: WriteRecord[] = [];

  // Important: return `undefined` (not void) to match lib.dom
  writeBuffer(...args: any[]): undefined {
    // (buffer: GPUBuffer, bufferOffset: number, data: GPUAllowSharedBufferSource, dataOffset?: number, size?: number)
    const bufferOffset: number = args[1] | 0;
    const data = args[2];
    const sizeArg = args[4];

    let totalBytes = 0;
    if (sizeArg != null) {
      totalBytes = sizeArg | 0;
    } else if (data && typeof data.byteLength === "number") {
      totalBytes = (data as ArrayBufferView | ArrayBuffer).byteLength | 0;
    }

    this.writes.push({ offset: bufferOffset, size: totalBytes });
    return undefined;
  }

  writeTexture(..._args: any[]): undefined {
    return undefined;
  }

  copyExternalImageToTexture(..._args: any[]): undefined {
    return undefined;
  }

  submit(..._args: any[]): undefined {
    return undefined;
  }

  // Important: Promise<undefined> to match lib.dom
  onSubmittedWorkDone(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

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

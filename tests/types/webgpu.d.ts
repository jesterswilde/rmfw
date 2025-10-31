// tests/types/webgpu.d.ts
// Minimal WebGPU type shims for Node/Jest. Runtime values are provided separately.

declare interface GPUBuffer {
  size: number;
  usage: number;
  destroy(): void;
}

declare interface GPUQueue {
  label?: string;
  writeBuffer(
    buffer: GPUBuffer,
    bufferOffset: number,
    data: ArrayBuffer | ArrayBufferView,
    dataOffset?: number,
    size?: number
  ): void;
  submit?: (...args: any[]) => void;
  copyExternalImageToTexture?: (...args: any[]) => void;
  onSubmittedWorkDone?: () => Promise<void>;
}

declare interface GPUBindGroupLayout {}
declare interface GPUBindGroup {}

declare interface GPUBufferBinding {
  buffer: GPUBuffer;
  offset?: number;
  size?: number;
}

declare interface GPUBindGroupEntry {
  binding: number;
  resource: GPUBufferBinding; // buffer-only for tests
}

declare type GPUBufferBindingType = "read-only-storage" | "storage" | "uniform";

declare interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: number;
  buffer?: { type?: GPUBufferBindingType; hasDynamicOffset?: boolean; minBindingSize?: number };
  storageTexture?: any;
}

declare type GPUShaderStageFlags = number;

// ⚠️ Declarations only; values provided at runtime in setup file
declare const GPUShaderStage: { COMPUTE: number; VERTEX?: number; FRAGMENT?: number };

declare interface GPUBufferDescriptor {
  size: number;
  usage: number;
  mappedAtCreation?: boolean;
  label?: string;
}

declare interface GPUDevice {
  createBuffer(desc: GPUBufferDescriptor): GPUBuffer;
  createBindGroupLayout(desc: { entries: GPUBindGroupLayoutEntry[] }): GPUBindGroupLayout;
  createBindGroup(desc: { layout: GPUBindGroupLayout; entries: GPUBindGroupEntry[] }): GPUBindGroup;
  queue: GPUQueue;
}

declare const GPUBufferUsage: { COPY_DST: number; STORAGE: number; UNIFORM?: number };

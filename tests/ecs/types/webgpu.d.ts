// tests/types/webgpu.d.ts
// Minimal WebGPU type shims for Node/Jest. Runtime is faked in tests.

declare interface GPUBuffer { size: number; usage: number; destroy(): void; }
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
declare interface GPUBindGroupEntry { binding: number; resource: { buffer: GPUBuffer }; }
declare interface GPUBindGroupLayoutEntry {
  binding: number;
  visibility: number;
  buffer?: { type?: "read-only-storage" | "storage" | "uniform"; hasDynamicOffset?: boolean; minBindingSize?: number };
  storageTexture?: any;
}
declare type GPUShaderStageFlags = number;
declare const GPUShaderStage: { COMPUTE: number; VERTEX?: number; FRAGMENT?: number };

declare interface GPUDevice {
  createBuffer(desc: { size: number; usage: number }): GPUBuffer;
  createBindGroupLayout(desc: { entries: GPUBindGroupLayoutEntry[] }): GPUBindGroupLayout;
  createBindGroup(desc: { layout: GPUBindGroupLayout; entries: GPUBindGroupEntry[] }): GPUBindGroup;
  queue: GPUQueue;
}
declare const GPUBufferUsage: { COPY_DST: number; STORAGE: number; UNIFORM?: number };

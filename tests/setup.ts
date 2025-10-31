// tests/setup.ts
// Runtime WebGPU shims for Jest (values, not just types).

(globalThis as any).GPUBufferUsage = {
  COPY_DST: 1 << 0,
  STORAGE:  1 << 1,
  UNIFORM:  1 << 2,
};

(globalThis as any).GPUShaderStage = {
  COMPUTE:  1 << 0,
  VERTEX:   1 << 1,
  FRAGMENT: 1 << 2,
};

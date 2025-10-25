import { GPUDeviceManager } from "./device.js";

const codeCache = new Map<string, string>();
const moduleCache = new Map<string, GPUShaderModule>();

export const ShaderCache = {
  async module(path: string): Promise<GPUShaderModule> {
    const dev = (await GPUDeviceManager.get()).device;
    if (moduleCache.has(path)) return moduleCache.get(path)!;

    let code = codeCache.get(path);
    if (!code) {
      const resp = await fetch(path);
      if (!resp.ok) throw new Error(`WGSL fetch failed: ${path}`);
      code = await resp.text();
      codeCache.set(path, code);
    }
    const mod = dev.createShaderModule({ code });
    moduleCache.set(path, mod);
    return mod;
  },
};

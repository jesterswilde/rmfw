import { GPUDeviceManager } from "../gpu/device.js";
import { ShaderCache } from "../gpu/shaders.js";

export class ComputeRenderer {
  private pipeline!: GPUComputePipeline;
  private outLayout!: GPUBindGroupLayout;   // @group(0): storage texture
  private frameLayout!: GPUBindGroupLayout; // @group(1): dynamic UBO
  private sceneLayout!: GPUBindGroupLayout; // @group(2): scene buffers

  constructor(private wgslPath: string) {}

  async init() {
    const { device } = await GPUDeviceManager.get();

    this.outLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba8unorm", viewDimension: "2d" },
        },
      ],
    });

    this.frameLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 160},
        },
      ],
    });

    // sceneLayout is supplied by Scene when building the pipeline
  }

  async buildWithScene(sceneLayout: GPUBindGroupLayout, entryPoint = "render") {
    const { device } = (GPUDeviceManager as any)._inst;
    this.sceneLayout = sceneLayout;

    const pipelineLayout = device.createPipelineLayout({
      // MUST match WGSL group indices: 0=out, 1=frame, 2=scene
      bindGroupLayouts: [this.outLayout, this.frameLayout, this.sceneLayout],
    });
    const module = await ShaderCache.module(this.wgslPath);
    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module, entryPoint },
    });
  }

  getLayouts() {
    return { out: this.outLayout, frame: this.frameLayout, scene: this.sceneLayout };
  }

  get pipelineHandle() { return this.pipeline; }
}

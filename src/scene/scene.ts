// src/gpu/scene.ts
import type { World } from "../ecs/core/index.js";
import type { IView, SceneViews, ViewGPU } from "./interface.js";

import { ComputeRenderer } from "./computeRenderer.js";
import { QuadBlitPass } from "./quadBlit.js";

import { GpuBridge } from "../ecs/gpu/bridge.js";
import { RenderChannel } from "../ecs/gpu/renderChannel.js";
import { TransformsChannel } from "../ecs/gpu/transformsChannel.js";
import type { DfsOrder } from "../ecs/gpu/baseChannel.js";

import {
  ShapeMeta,
  OperationMeta,
  RenderNodeMeta,
  TransformMeta,
} from "../ecs/registry.js";

type TreeRef = { order: DfsOrder; epoch: number };

export class Scene {
  private _device: GPUDevice;

  // Scene bind-group (group=2) now comes from the ECS bridge
  private _sceneBGL!: GPUBindGroupLayout; // @group(2)
  private _sceneBG!: GPUBindGroup;

  private _compute: ComputeRenderer;

  private _time = 0;
  private _numNodes = 0;

  private _views: SceneViews = new Map<number, { view: IView; gpu: ViewGPU }>();

  // Frame UBO (dynamic) — @group(1)
  private _frameUBO!: GPUBuffer;
  private _frameBG!: GPUBindGroup;
  private _uboStride = 256; // aligned to device.limits.minUniformBufferOffsetAlignment
  private _maxViews = 8;

  private _blit!: QuadBlitPass;
  private _blitReady = false;
  private _canvasFormat: GPUTextureFormat = "rgba8unorm";

  // ECS bridge + world + trees
  private _bridge: GpuBridge | null = null;
  private _world: World | null = null;
  private _renderTree: TreeRef | null = null;
  private _xformTree: TreeRef | null = null;

  // shader setup
  private _wgslPath: string;
  private _entryPoint: string;

  // debug
  private readonly DEBUG_CLEAR_MAGENTA = false;

  constructor(device: GPUDevice, wgslPath: string, entryPoint = "render") {
    this._device = device;
    this._wgslPath = wgslPath;
    this._entryPoint = entryPoint;
    // Compute: out(0) + frame(1) are static; scene(2) provided after attachWorld()
    this._compute = new ComputeRenderer(this._wgslPath);

    // Respect adapter alignment (commonly 256)
    const align = Math.max(
      256,
      device.limits.minUniformBufferOffsetAlignment || 256
    );
    this._uboStride = align;

    // Frame UBO & BG (@group(1)) — allocate dynamic buffer with stride slices
    this._frameUBO = device.createBuffer({
      size: this._maxViews * this._uboStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // We can init immediately; building with scene layout waits for attachWorld()
    void this._compute.init().then(() => {
      // frame layout is ready after init()
      this._frameBG = device.createBindGroup({
        layout: this._compute.getLayouts().frame,
        entries: [{ binding: 0, resource: { buffer: this._frameUBO } }],
      });
      // per-view out BGs will be created lazily per view once pipeline exists
      this.rebuildPerViewOutBG(); // no-op until pipeline exists
    });

    // Blit pass is created on first registerView (needs canvas format)
  }

  /**
   * Attach an ECS world and register GPU channels for scene data.
   * Call this once the world has its stores and trees available.
   */
  attachWorld(world: World, trees: { trenderTree: TreeRef; transformHierarchy: TreeRef }) {
    this._world = world;
    this._renderTree = trees.trenderTree;
    this._xformTree = trees.transformHierarchy;

    // Create & register channels
    const bridge = new GpuBridge();
    this._bridge = bridge;

    // Binding 1: transforms (inverse, DFS order of Transform tree)
    bridge.register({
      group: 2,
      binding: 1,
      channel: new TransformsChannel(),
      argsProvider: (w: World) => ({
        order: this._xformTree!.order,
        orderEpoch: this._xformTree!.epoch,
        store: w.storeOf(TransformMeta),
      }),
    });

    // Binding 0: render nodes (needs render DFS, transform DFS, and stores)
    bridge.register({
      group: 2,
      binding: 0,
      channel: new RenderChannel(),
      argsProvider: (w: World) => ({
        order: this._renderTree!.order,
        orderEpoch: this._renderTree!.epoch,
        shapeStore: w.storeOf(ShapeMeta),
        opStore: w.storeOf(OperationMeta),
        renderStore: w.storeOf(RenderNodeMeta),
        transformStore: w.storeOf(TransformMeta),
        transformOrder: this._xformTree!.order,
        transformOrderEpoch: this._xformTree!.epoch,
      }),
    });


    // Build scene group layout from bridge and compile pipeline with it
    this._sceneBGL = this._device.createBindGroupLayout({
      entries: bridge.layoutEntriesFor(2),
    });

    // If compute was initialized, build the pipeline with the scene layout.
    // We may call this multiple times safely; ComputeRenderer will create the pipeline once per scene layout.
    void this._compute.buildWithScene(this._sceneBGL, this._entryPoint).then(() => {
      // After pipeline exists, rebuild any per-view out bind groups
      this.rebuildPerViewOutBG();
      // Create initial scene bind group
      this._sceneBG = this._device.createBindGroup({
        layout: this._sceneBGL,
        entries: bridge.bindGroupEntriesFor(2),
      });
    });
  }

  /**
   * Advance time, sync ECS→GPU via bridge, and refresh scene bind group.
   * Safe to call each frame; requires world to be attached.
   */
  update(dt: number) {
    this._time += dt;
    if (!this._bridge || !this._world)
      return;
    this._bridge.syncAll(this._world, this._device, this._device.queue);

    // Recreate scene bind group (simple + safe)
    this._sceneBG = this._device.createBindGroup({
      layout: this._sceneBGL,
      entries: this._bridge.bindGroupEntriesFor(2),
    });

    // Node count for frame UBO (render DFS length)
    this._numNodes = this._renderTree ? this._renderTree.order.length : 0;
  }

  registerView(view: IView) {
    const canvas = view.getElement();
    const ctx = canvas.getContext("webgpu")!;

    // DPR-aware backing size
    const { width, height } = view.getSize();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));

    // Canvas format
    this._canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({
      device: this._device,
      format: this._canvasFormat,
      alphaMode: "premultiplied",
    });

    // Blit
    if (!this._blitReady) {
      this._blit = new QuadBlitPass(this._device, this._canvasFormat);
      this._blit.init();
      this._blitReady = true;
    }

    const gpu = this.createPerViewGPU(canvas.width, canvas.height);
    gpu.context = ctx;

    // assign 256-aligned dynamic slice
    gpu.uboOffset = this._views.size * this._uboStride;

    this._views.set(view.id, { view, gpu });

    // If compute pipeline ready, build outBG now
    if (this._compute.pipelineHandle && !gpu.outBG) {
      gpu.outBG = this._device.createBindGroup({
        layout: this._compute.getLayouts().out,
        entries: [{ binding: 0, resource: gpu.outView }],
      });
    }
  }

  deregisterView(view: IView) {
    const e = this._views.get(view.id);
    if (!e) return;
    e.gpu.outTex.destroy();
    this._views.delete(view.id);
    // Note: we don't reshuffle existing offsets; each view keeps its slice.
  }

  onViewResize(view: IView) {
    const entry = this._views.get(view.id);
    if (!entry) return;

    const { width, height } = view.getSize();
    const canvas = view.getElement();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));

    const { gpu } = entry;
    gpu.outTex.destroy();

    const nv = this.createPerViewGPU(canvas.width, canvas.height);
    nv.context = gpu.context;
    nv.uboOffset = gpu.uboOffset; // keep same dynamic slice

    if (this._compute.pipelineHandle) {
      nv.outBG = this._device.createBindGroup({
        layout: this._compute.getLayouts().out,
        entries: [{ binding: 0, resource: nv.outView }],
      });
    }

    this._views.set(view.id, { view, gpu: nv });
  }

  render(workgroupSize = 8) {
    if (!this._compute.pipelineHandle || !this._sceneBG) return;

    const enc = this._device.createCommandEncoder();

    if (this.DEBUG_CLEAR_MAGENTA) {
      for (const { gpu } of this._views.values()) {
        const rp = enc.beginRenderPass({
          colorAttachments: [
            {
              view: gpu.outView,
              loadOp: "clear",
              clearValue: { r: 1, g: 0, b: 1, a: 1 },
              storeOp: "store",
            },
          ],
        });
        rp.end();
      }
    }

    // Compute pass per view
    {
      const pass = enc.beginComputePass();
      pass.setPipeline(this._compute.pipelineHandle);

      for (const { view, gpu } of this._views.values()) {
        if (!gpu.outBG) {
          gpu.outBG = this._device.createBindGroup({
            layout: this._compute.getLayouts().out,
            entries: [{ binding: 0, resource: gpu.outView }],
          });
        }
        if (!gpu.outBG) continue;

        // ---- Build and upload per-view Frame slice into 256B-aligned dynamic offset ----
        this.writeFrameSlice(
          gpu.uboOffset,
          gpu.width,
          gpu.height,
          this._time,
          this._numNodes,
          view.getCamera()
        );

        // bind groups: 0=out, 1=frame (dynamic), 2=scene
        pass.setBindGroup(0, gpu.outBG);
        pass.setBindGroup(1, this._frameBG, [gpu.uboOffset]);
        pass.setBindGroup(2, this._sceneBG);

        // dispatch to cover full texture size
        const wx = Math.ceil(gpu.width / workgroupSize);
        const wy = Math.ceil(gpu.height / workgroupSize);
        pass.dispatchWorkgroups(wx, wy);
      }

      pass.end();
    }

    // Blit to canvas
    for (const { gpu } of this._views.values()) {
      this._blit.encode(enc, gpu.context, gpu.blitBG);
    }

    this._device.queue.submit([enc.finish()]);
  }

  // ---- internals ------------------------------------------------------------

  /**
   * Pack FramePacked (6×vec4 = 96 bytes) and upload into the frame UBO slice.
   * Layout matches WGSL:
   *  - u0: vec4<u32> = [width, height, numNodes, flags]
   *  - f0: vec4<f32> = [time, 0, 0, 0]
   *  - c0..c3: camera columns (16 floats, column-major)
   */
  private writeFrameSlice(
    offset: number,
    width: number,
    height: number,
    time: number,
    numNodes: number,
    cameraCols16: Float32Array | number[] // 16 floats, column-major
  ) {
    // 6 vec4<f32> = 24 floats = 96 bytes
    const FLOATS = 24;
    const buf = new ArrayBuffer(FLOATS * 4);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);

    // u0 : vec4<u32> @ 0..3
    u32[0] = width >>> 0;
    u32[1] = height >>> 0;
    u32[2] = numNodes >>> 0;
    u32[3] = 0; // flags/unused

    // f0 : vec4<f32> @ 4..7
    f32[4] = time;
    f32[5] = 0;
    f32[6] = 0;
    f32[7] = 0;

    // c0..c3 : vec4<f32> @ 8..23
    const cam = cameraCols16 as ReadonlyArray<number>;
    // ensure we have at least 16 numbers; extra are ignored
    f32.set(cam.slice(0, 16), 8);

    this._device.queue.writeBuffer(this._frameUBO, offset, buf);
  }

  private createPerViewGPU(width: number, height: number): ViewGPU {
    const outTex = this._device.createTexture({
      size: { width, height },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING,
    });
    const outView = outTex.createView();

    if (!this._blitReady) throw new Error("Blit pass not initialized");
    const blitBG = this._blit.createBindGroup(outView);

    let outBG: GPUBindGroup | null = null;
    if (this._compute.pipelineHandle) {
      outBG = this._device.createBindGroup({
        layout: this._compute.getLayouts().out,
        entries: [{ binding: 0, resource: outView }],
      });
    }

    return {
      context: undefined as any,
      outTex,
      outView,
      outBG,
      blitBG,
      width,
      height,
      uboOffset: 0,
    };
  }

  private rebuildPerViewOutBG() {
    if (!this._compute.pipelineHandle) return;
    const layout = this._compute.getLayouts().out;
    for (const e of this._views.values()) {
      e.gpu.outBG = this._device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: e.gpu.outView }],
      });
    }
  }
}

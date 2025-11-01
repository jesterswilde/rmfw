// src/scene/scene.ts
// Phase 4 — ECS-backed Scene wired to GPU Bridge (uses initWorld + new systems/loader)

import { load } from '../utils/util.js';
import type { IView, SceneViews, ViewGPU } from './interface.js';

import { ComputeRenderer } from './computeRenderer.js';
import { QuadBlitPass } from './quadBlit.js';

// --- ECS + Bridge ---
import { initWorld, TransformMeta, RenderNodeMeta, ShapeLeafMeta, OperationMeta } from '../ecs/registry.js';
import { loadScene as loadEcsScene } from '../ecs/load.js';
import { propagateTransforms, PropagateWorkspace } from '../ecs/systems/propagateTransforms.js';

import { GpuBridge } from '../ecs/gpu/bridge.js';
import { TransformsChannel } from '../ecs/gpu/transformsChannel.js';
import { RenderChannel } from '../ecs/gpu/renderChannel.js';

type DfsTreeLike = { order: Int32Array; epoch: number };

export class Scene {
  private _device: GPUDevice;

  // Scene @group(2) built from the bridge
  private _sceneLayout!: GPUBindGroupLayout;
  private _sceneBG!: GPUBindGroup;

  // ECS state
  private _world = initWorld();
  private _tTree!: DfsTreeLike;
  private _rTree!: DfsTreeLike;
  private _propWorkspace: PropagateWorkspace | null = null 

  // GPU bridge
  private bridge = new GpuBridge();
  private transformsChan = new TransformsChannel();
  private renderChan = new RenderChannel();

  // Renderer
  private _compute: ComputeRenderer;

  private _time = 0;
  private _numRows = 0; // render rows (including implicit root row 0)

  private _views: SceneViews = new Map<number, { view: IView, gpu: ViewGPU }>();

  // Frame UBO (dynamic)
  private _frameUBO!: GPUBuffer;
  private _frameBG!: GPUBindGroup; // @group(1)
  private _uboStride = 256; // computed from device limits in ctor
  private _maxViews = 8;

  private _blit!: QuadBlitPass;
  private _blitReady = false;
  private _canvasFormat: GPUTextureFormat = 'rgba8unorm';

  // debug
  private readonly DEBUG_CLEAR_MAGENTA = false;

  constructor(device: GPUDevice, wgslPath: string, entryPoint = 'render') {
    this._device = device;

    // Respect adapter alignment (commonly 256)
    const align = Math.max(256, device.limits.minUniformBufferOffsetAlignment || 256);
    this._uboStride = align;

    // Register channels at fixed slots (trees are attached after load):
    // @group(2)/binding(0) -> Render rows
    this.bridge.register({
      group: 2,
      binding: 0,
      channel: this.renderChan,
      argsProvider: (w) => ({
        order: this._rTree?.order ?? new Int32Array(0),
        orderEpoch: this._rTree?.epoch ?? -1,
        shapeStore: w.storeOf(ShapeLeafMeta),
        opStore: w.storeOf(OperationMeta),
        renderStore: w.storeOf(RenderNodeMeta),
        transformStore: w.storeOf(TransformMeta),
        transformOrder: this._tTree?.order ?? new Int32Array(0),
        transformOrderEpoch: this._tTree?.epoch ?? -1,
      }),
    });

    // @group(2)/binding(2) -> Inverse-world transforms
    this.bridge.register({
      group: 2,
      binding: 2,
      channel: this.transformsChan,
      argsProvider: (w) => ({
        order: this._tTree?.order ?? new Int32Array(0),
        orderEpoch: this._tTree?.epoch ?? -1,
        store: w.storeOf(TransformMeta),
      }),
    });

    // Scene layout & bind group from bridge
    this._sceneLayout = device.createBindGroupLayout({
      entries: this.bridge.layoutEntriesFor(2),
    });
    this._sceneBG = this._device.createBindGroup({
      layout: this._sceneLayout,
      entries: this.bridge.bindGroupEntriesFor(2),
    });

    // Frame UBO & BG (@group(1)) — allocate dynamic buffer with 256-byte slices
    this._frameUBO = device.createBuffer({
      size: this._maxViews * this._uboStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Compute: include frame+scene layouts
    this._compute = new ComputeRenderer(wgslPath);
    this._compute.init().then(() => {
      this._compute.buildWithScene(this._sceneLayout, entryPoint);
      this._frameBG = device.createBindGroup({
        layout: this._compute.getLayouts().frame,
        entries: [{ binding: 0, resource: { buffer: this._frameUBO } }],
      });
      this.rebuildPerViewOutBG(); // create per-view group(0)
    });

    // Blit is created on first registerView (needs canvas format)
  }

  // ✅ Keep this method public so main.ts can call scene.loadScene(...)
  public async loadScene(sceneLocation: string): Promise<void> {
    // Fetch JSON, then load into ECS using your loader (v1)
    const sceneObj = await load(sceneLocation, 'json');

    const { trees } = loadEcsScene(this._world, sceneObj);
    // Build tree refs (names must match registry/trees)
    const tTree = trees.get('TransformNode') as DfsTreeLike | undefined;
    const rTree = trees.get('RenderNode') as DfsTreeLike | undefined;
    if (!tTree || !rTree) {
      throw new Error('Missing TransformNode or RenderNode trees after load');
    }
    this._tTree = tTree;
    this._rTree = rTree;

    // Initial propagation (writes world/invWorld & bumps row versions)
    propagateTransforms(this._world, this._propWorkspace);

    // First sync will size buffers and mark-all-dirty
    this.bridge.syncAll(this._world, this._device, this._device.queue);

    // Rebuild scene bind group in case buffers resized
    this._sceneBG = this._device.createBindGroup({
      layout: this._sceneLayout,
      entries: this.bridge.bindGroupEntriesFor(2),
    });

    // rows = render DFS + implicit root
    this._numRows = (this._rTree.order.length | 0) + 1;
  }

  update(dt: number) {
    this._time += dt;

    // Sync GPU buffers (may recreate)
    this.bridge.syncAll(this._world, this._device, this._device.queue);

    // Rebuild BG (cheap; guarantees correctness if any buffer resized)
    this._sceneBG = this._device.createBindGroup({
      layout: this._sceneLayout,
      entries: this.bridge.bindGroupEntriesFor(2),
    });

    if (this._rTree) this._numRows = (this._rTree.order.length | 0) + 1;
  }

  registerView(view: IView) {
    const canvas = view.getElement();
    const ctx = canvas.getContext('webgpu')!;

    // DPR-aware backing size
    const { width, height } = view.getSize();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width  = Math.max(1, Math.floor(width  * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));

    // Canvas format
    this._canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device: this._device, format: this._canvasFormat, alphaMode: 'premultiplied' });

    // Blit
    if (!this._blitReady) {
      this._blit = new QuadBlitPass(this._device, this._canvasFormat);
      this._blit.init();
      this._blitReady = true;
    }

    const gpu = this.createPerViewGPU(canvas.width, canvas.height);
    gpu.context = ctx;

    // assign 256-aligned dynamic slice
    gpu.uboOffset = (this._views.size) * this._uboStride;

    this._views.set(view.id, { view, gpu });

    // If compute ready, build outBG now
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
  }

  onViewResize(view: IView) {
    const entry = this._views.get(view.id);
    if (!entry) return;

    const { width, height } = view.getSize();
    const canvas = view.getElement();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width  = Math.max(1, Math.floor(width  * dpr));
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
    if (!this._compute.pipelineHandle) return;

    const enc = this._device.createCommandEncoder();

    if (this.DEBUG_CLEAR_MAGENTA) {
      for (const { gpu } of this._views.values()) {
        const rp = enc.beginRenderPass({
          colorAttachments: [{
            view: gpu.outView,
            loadOp: 'clear',
            clearValue: { r: 1, g: 0, b: 1, a: 1 },
            storeOp: 'store',
          }]
        });
        rp.end();
      }
    }

    // 2) Compute (bind 0=out, 1=frame, 2=scene)
    {
      const pass = enc.beginComputePass();
      pass.setPipeline(this._compute.pipelineHandle!);

      for (const { view, gpu } of this._views.values()) {
        if (!gpu.outBG) {
          gpu.outBG = this._device.createBindGroup({
            layout: this._compute.getLayouts().out,
            entries: [{ binding: 0, resource: gpu.outView }],
          });
        }
        if (!gpu.outBG) continue;

        // ---- Build and upload per-view Frame (96B payload into 256B slice) ----
        this.writeFrameSlice(gpu.uboOffset, gpu.width, gpu.height, this._time, this._numRows, view.getCamera());

        // bind groups
        pass.setBindGroup(0, gpu.outBG);
        pass.setBindGroup(1, this._frameBG, [gpu.uboOffset]); // dynamic offset aligned
        pass.setBindGroup(2, this._sceneBG);

        // dispatch for full texture size
        const wx = Math.ceil(gpu.width  / workgroupSize);
        const wy = Math.ceil(gpu.height / workgroupSize);
        pass.dispatchWorkgroups(wx, wy);
      }

      pass.end();
    }

    // 3) Blit to canvas
    for (const { gpu } of this._views.values()) {
      this._blit.encode(enc, gpu.context!, gpu.blitBG!);
    }

    this._device.queue.submit([enc.finish()]);
  }

  // ---- internals ------------------------------------------------------------
  /** Pack FramePacked: 6 x vec4 = 96 bytes */
  private writeFrameSlice(
    offset: number,
    width: number,
    height: number,
    time: number,
    numRows: number,
    _cameraCols16: Float32Array | number[],
  ) {
    const SIZE = 96; // 6 * 16B
    const buf = new ArrayBuffer(SIZE);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);

    // u0 : vec4<u32>
    u32[0] = width >>> 0;
    u32[1] = height >>> 0;
    u32[2] = numRows >>> 0; // rows in render buffer (including implicit root at row 0)
    u32[3] = 0;

    // f0 : vec4<f32>
    f32[4] = time;

    // Camera columns currently unused by WGSL; keep zeros for future hookup.
    this._device.queue.writeBuffer(this._frameUBO, offset, buf);
  }

  private createPerViewGPU(width: number, height: number): ViewGPU {
    const outTex = this._device.createTexture({
      size: { width, height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const outView = outTex.createView();

    if (!this._blitReady) throw new Error('Blit pass not initialized');
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
      outTex, outView, outBG, blitBG,
      width, height,
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

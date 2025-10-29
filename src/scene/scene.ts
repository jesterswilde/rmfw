import { EntityPool } from '../pools/entity.js';
import { Mat34Pool } from '../pools/matrix.js';
import { NodeTree } from '../pools/nodeTree.js';
import { parseScene } from '../systems/loadScene.js';
import { repack } from '../systems/repack.js';
import { load } from '../utils/util.js';
import { ComputeRenderer } from './computeRenderer.js';
import { QuadBlitPass } from './quadBlit.js';
import { propagateTransforms } from '../systems/propegatTransforms.js';
import type { IView, SceneViews, ViewGPU } from './interface.js';


export class Scene {
  private _device: GPUDevice;

  private _bindGroupLayout: GPUBindGroupLayout; // scene @group(2)
  private _sceneBG!: GPUBindGroup;

  private _nodes: NodeTree;
  private _entities: EntityPool;
  private _matrices: Mat34Pool;

  private _nodesVersion = -1;
  private _entitiesVersion = -1;
  private _matricesVersion = -1;

  private _compute: ComputeRenderer;

  private _time = 0;
  private _numObjs = 0; // will be set from _entities.size after load

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

    // Pools
    this._nodes = new NodeTree(256);
    this._entities = new EntityPool(256);
    this._matrices = new Mat34Pool(256);
    this._nodes.createGPUBuffer(device);
    this._entities.createGPUBuffer(device);
    this._matrices.createGPUBuffer(device);
    this._nodesVersion = this._nodes.version;
    this._entitiesVersion = this._entities.version;
    this._matricesVersion = this._matrices.version;

    // Scene storage layout (@group(2))
    this._bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // entities/shapes
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // nodes
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }, // transforms
      ],
    });
    this._sceneBG = this._device.createBindGroup({
      layout: this._bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this._entities.getGPUBuffer()! } },
        { binding: 1, resource: { buffer: this._nodes.getGPUBuffer()! } },
        { binding: 2, resource: { buffer: this._matrices.getGPUBuffer()! } },
      ],
    });

    // Frame UBO & BG (@group(1)) — allocate dynamic buffer with 256-byte slices
    this._frameUBO = device.createBuffer({
      size: this._maxViews * this._uboStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Compute: include frame+scene layouts
    this._compute = new ComputeRenderer(wgslPath);
    this._compute.init().then(() => {
      this._compute.buildWithScene(this._bindGroupLayout, entryPoint);
      this._frameBG = device.createBindGroup({
        layout: this._compute.getLayouts().frame,
        entries: [{ binding: 0, resource: { buffer: this._frameUBO } }],
      });
      this.rebuildPerViewOutBG(); // create per-view group(0)
    });

    // Blit is created on first registerView (needs canvas format)
  }

  async loadScene(sceneLocation: string) {
    const sceneObj = await load(sceneLocation, 'json');

    parseScene(sceneObj, this._nodes, this._entities, this._matrices);
    propagateTransforms(this._nodes, this._matrices);
    //Repack doesn't carry over dirty flags so it's important that propegation happens first
    repack(this._nodes, this._entities, this._matrices);

    this._nodesVersion = this._nodes.version;
    this._entitiesVersion = this._entities.version;
    this._matricesVersion = this._matrices.version;

    this._numObjs = this._entities.size;

    this._sceneBG = this._device.createBindGroup({
      layout: this._bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this._entities.getGPUBuffer()! } },
        { binding: 1, resource: { buffer: this._nodes.getGPUBuffer()! } },
        { binding: 2, resource: { buffer: this._matrices.getGPUBuffer()! } },
      ],
    });
  }

  update(dt: number) {
    this._time += dt;

    const changed =
      this._nodes.version !== this._nodesVersion ||
      this._entities.version !== this._entitiesVersion ||
      this._matrices.version !== this._matricesVersion;

    if (changed) {
      this._sceneBG = this._device.createBindGroup({
        layout: this._bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this._entities.getGPUBuffer()! } },
          { binding: 1, resource: { buffer: this._nodes.getGPUBuffer()! } },
          { binding: 2, resource: { buffer: this._matrices.getGPUBuffer()! } },
        ],
      });
      this._nodesVersion = this._nodes.version;
      this._entitiesVersion = this._entities.version;
      this._matricesVersion = this._matrices.version;

      this._numObjs = this._entities.size;
    }

    propagateTransforms(this._nodes, this._matrices)
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
    // Note: we don't reshuffle existing offsets; each view keeps its slice.
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
    if (!this._compute.pipelineHandle) 
      return;

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
      pass.setPipeline(this._compute.pipelineHandle);

      for (const { view, gpu } of this._views.values()) {
        if (!gpu.outBG) {
          gpu.outBG = this._device.createBindGroup({
            layout: this._compute.getLayouts().out,
            entries: [{ binding: 0, resource: gpu.outView }],
          });
        }
        if (!gpu.outBG) continue;

        // ---- Build and upload per-view Frame (128B) into 256B dynamic slice ----
        this.writeFrameSlice(gpu.uboOffset, gpu.width, gpu.height, this._time, this._numObjs, view.getCamera());

        // bind groups
        pass.setBindGroup(0, gpu.outBG);
        // dynamic offset must be multiple of minUniformBufferOffsetAlignment (we enforce in ctor)
        pass.setBindGroup(1, this._frameBG, [gpu.uboOffset]);
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
      this._blit.encode(enc, gpu.context, gpu.blitBG);
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
    numShapes: number,
    cameraCols16: Float32Array | number[], // 16 floats, column-major
  ) {
    const SIZE = 96; // 6 * 16B
    const buf = new ArrayBuffer(SIZE);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);

    // u0 : vec4<u32> @ 0..15
    u32[0] = width >>> 0;    // x = res.x
    u32[1] = height >>> 0;   // y = res.y
    u32[2] = numShapes >>> 0;// z = numShapes
    u32[3] = 0;              // w = flags/unused

    // f0 : vec4<f32> @ 16..31 (float index 4..7)
    f32[4] = time;           // x = time

    //// camera columns @ 32..95 (float index 8..23)
    //const cam = Array.from(cameraCols16 as any).slice(0, 16); // guard length
    //// c0
    //new Float32Array(buf, 32, 4).set(cam.slice(0, 4));
    //// c1
    //new Float32Array(buf, 48, 4).set(cam.slice(4, 8));
    //// c2
    //new Float32Array(buf, 64, 4).set(cam.slice(8, 12));
    //// c3
    //new Float32Array(buf, 80, 4).set(cam.slice(12, 16));

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

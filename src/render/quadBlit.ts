export class QuadBlitPass {
  private pipeline!: GPURenderPipeline;
  private layout!: GPUBindGroupLayout;
  private sampler!: GPUSampler;

  constructor(
    private device: GPUDevice,
    public readonly format: GPUTextureFormat
  ) {}

  init(): void {
    const module = this.device.createShaderModule({
      code: /* wgsl */`
      struct VOut {
        @builtin(position) pos: vec4f,
        @location(0) uv: vec2f
      };

      @vertex
      fn vert(@builtin(vertex_index) i:u32) -> VOut {
        var pos = array<vec2f,6>(
          vec2f( 1, 1), vec2f( 1,-1), vec2f(-1,-1),
          vec2f( 1, 1), vec2f(-1,-1), vec2f(-1, 1));
        var uv  = array<vec2f,6>(
          vec2f(1,0), vec2f(1,1), vec2f(0,1),
          vec2f(1,0), vec2f(0,1), vec2f(0,0));
        var o: VOut;
        o.pos = vec4f(pos[i], 0, 1);
        o.uv  = uv[i];
        return o;
      }

      @group(0) @binding(0) var samp: sampler;
      @group(0) @binding(1) var tex : texture_2d<f32>;

      @fragment
      fn frag(@location(0) uv: vec2f) -> @location(0) vec4f {
        // sample the whole texture, not just the center
        return textureSample(tex, samp, uv);
      }`
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vert' },
      fragment: { module, entryPoint: 'frag', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.layout = this.pipeline.getBindGroupLayout(0);
    this.sampler = this.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  }

  createBindGroup(view: GPUTextureView) {
    return this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: view },
      ],
    });
  }

  encode(encoder: GPUCommandEncoder, context: GPUCanvasContext, bg: GPUBindGroup) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }]
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6, 1, 0, 0);
    pass.end();
  }
}

export type ViewGPU = {
  context: GPUCanvasContext;
  outTex: GPUTexture;
  outView: GPUTextureView;
  outBG: GPUBindGroup | null; // @group(0)
  blitBG: GPUBindGroup;
  width: number;
  height: number;
  uboOffset: number;          // dynamic UBO slice (bytes)
};

export interface IView {
  id: number;
  getElement(): HTMLCanvasElement;
  getSize(): { width: number; height: number };
  getCamera(): Float32Array; // 4x4 column-major
  update(t: number, dt: number): void;
  dispose(): void;
}

export type SceneViews = Map<number, {
    view: IView;
    gpu: ViewGPU;
}>
export class GPUDeviceManager {
  private static _inst: GPUDeviceManager | null = null;
  device!: GPUDevice;
  adapter!: GPUAdapter;

  static async get(): Promise<GPUDeviceManager> {
    if (!this._inst) {
      const mgr = new GPUDeviceManager();
      await mgr.init();
      this._inst = mgr;
    }
    return this._inst;
  }

  private async init() {
    this.adapter = (await navigator.gpu.requestAdapter())!;
    if (!this.adapter)
      throw new Error("No WebGPU adapter");
    this.device = (await this.adapter.requestDevice())!;
  }
}
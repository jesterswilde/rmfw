import { GPUDeviceManager } from "../gpu/device.js";
import { FrameLoop } from "../core/loop.js";
import { Scene } from "./scene.js";
import { CanvasView } from "./canvasView.js";
import { getInputs, setupInputListeners } from "../inputs.js";
import { moveCam, rotateCam } from "../camera.js";
import type { ResizableView, SceneEngine } from "./interface.js";

export class SceneRuntime implements SceneEngine {
  private initPromise: Promise<void> | null = null;
  private scene: Scene | null = null;
  private views = new Set<CanvasView>();
  private nextViewId = 1;

  async ensureReady(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    return this.initPromise;
  }

  async createViewport(width: number, height: number): Promise<ResizableView> {
    await this.ensureReady();
    if (!this.scene) {
      throw new Error("Scene runtime not initialised");
    }
    const view = new CanvasView(this.scene, this.nextViewId++, width, height);
    this.views.add(view);

    const originalDispose = view.dispose.bind(view);
    view.dispose = () => {
      if (this.views.delete(view)) {
        originalDispose();
      }
    };
    return view;
  }

  destroyViewport(view: ResizableView): void {
    view.dispose();
  }

  private async init(): Promise<void> {
    const gpuManager = await GPUDeviceManager.get();
    setupInputListeners();

    const scene = new Scene(gpuManager.device, "dist/wgsl/main.wgsl");
    await scene.loadScene("assets/scene.json");
    this.scene = scene;

    const loop = new FrameLoop();

    loop.add((_t, dt) => {
      const inputs = getInputs();
      rotateCam(inputs.look);
      moveCam(inputs.move, dt);
    }, 0);

    loop.add((t, dt) => {
      scene.update(dt);
      for (const view of this.views) {
        view.update(t, dt);
      }
    }, 10);

    loop.add(() => {
      scene.render();
    }, 20);

    loop.start();
  }
}

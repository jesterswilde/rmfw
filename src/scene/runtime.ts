import { GPUDeviceManager } from "../gpu/device.js";
import { FrameLoop } from "../core/loop.js";
import { Scene } from "./scene.js";
import { CanvasView } from "./canvasView.js";
import { getInputs, setupInputListeners } from "../inputs.js";
import { moveCam, rotateCam } from "../camera.js";
import type { ResizableView } from "./interface.js";

const DEFAULT_CANVAS_ID = "scene-canvas";

export class Engine {
  private initPromise: Promise<void> | null = null;
  private scene: Scene | null = null;
  private views = new Set<CanvasView>();
  private nextViewId = 1;
  private startPromise: Promise<void> | null = null;
  private mainView: ResizableView | null = null;

  async ensureReady(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    return this.initPromise;
  }

  async createViewport(
    width: number,
    height: number,
    canvas?: HTMLCanvasElement
  ): Promise<ResizableView> {
    await this.ensureReady();
    if (!this.scene) {
      throw new Error("Scene runtime not initialised");
    }
    const view = new CanvasView(
      this.scene,
      this.nextViewId++,
      width,
      height,
      canvas
    );
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

  start(canvasId = DEFAULT_CANVAS_ID): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.startInternal(canvasId).catch((err) => {
        this.startPromise = null;
        throw err;
      });
    }
    return this.startPromise;
  }

  private async startInternal(canvasId: string): Promise<void> {
    if (typeof document === "undefined") {
      return;
    }

    if (document.readyState === "loading") {
      await new Promise<void>((resolve) => {
        document.addEventListener("DOMContentLoaded", () => resolve(), {
          once: true,
        });
      });
    }

    const canvas = document.getElementById(canvasId);
    if (!(canvas instanceof HTMLCanvasElement)) {
      console.error(`Missing #${canvasId} canvas element`);
      return;
    }

    const { width, height } = this.measureCanvas(canvas);

    try {
      const view = await this.createViewport(width, height, canvas);
      this.mainView = view;

      if (typeof window !== "undefined") {
        window.addEventListener(
          "beforeunload",
          () => {
            if (this.mainView === view) {
              this.mainView = null;
            }
            this.destroyViewport(view);
          },
          { once: true }
        );
      }
    } catch (err) {
      console.error("Failed to initialise viewport", err);
      throw err;
    }
  }

  private measureCanvas(canvas: HTMLCanvasElement): {
    width: number;
    height: number;
  } {
    const rect = canvas.getBoundingClientRect();
    const fallbackWidth =
      typeof window !== "undefined" ? window.innerWidth : canvas.width;
    const fallbackHeight =
      typeof window !== "undefined" ? window.innerHeight : canvas.height;

    const width = Math.max(
      1,
      Math.floor(rect.width || canvas.clientWidth || canvas.width || fallbackWidth)
    );
    const height = Math.max(
      1,
      Math.floor(
        rect.height || canvas.clientHeight || canvas.height || fallbackHeight
      )
    );

    return { width, height };
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

export const engine = new Engine();

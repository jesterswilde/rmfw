import type { ResizableView } from "./interface.js";
import type { Scene } from "./scene.js";

export class CanvasView implements ResizableView {
  id: number;
  private canvas: HTMLCanvasElement;
  private width: number;
  private height: number;
  private camera = new Float32Array(16);
  private scene: Scene;

  constructor(scene: Scene, id: number, w = 512, h = 512) {
    this.scene = scene;
    this.id = id;
    this.canvas = document.createElement("canvas");
    this.width = w; this.height = h;

    // CSS size for layout
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    // Backing pixel size (DPR-aware)
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width  = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));

    this.initCamera();
    this.scene.registerView(this);
  }

  getElement() { return this.canvas; }
  getSize() { return { width: this.width, height: this.height }; }
  getCamera() { return this.camera; }

  resize(w: number, h: number) {
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));

    // CSS size
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    // Backing size
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width  = Math.max(1, Math.floor(this.width  * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.height * dpr));

    this.scene.onViewResize(this);
  }

  update(_t: number, _dt: number) {
    // handle inputs / mutate camera if needed
  }

  dispose() {
    this.scene.deregisterView(this);
    this.canvas.remove();
  }

  private initCamera() {
    this.camera.set([
      1,0,0,0,
      0,1,0,0,
      0,0,1,-10,
      0,0,0,1,
    ]);
  }
}

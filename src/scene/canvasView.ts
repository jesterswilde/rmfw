import type { ResizableView } from "./interface.js";
import type { Scene } from "./scene.js";

export class CanvasView implements ResizableView {
  id: number;
  private canvas: HTMLCanvasElement;
  private width: number;
  private height: number;
  private camera = new Float32Array(16);
  private scene: Scene;
  private readonly externalCanvas: boolean;

  constructor(scene: Scene, id: number, w = 512, h = 512, existingCanvas?: HTMLCanvasElement) {
    this.scene = scene;
    this.id = id;
    this.canvas = existingCanvas ?? document.createElement("canvas");
    this.width = w;
    this.height = h;
    this.externalCanvas = Boolean(existingCanvas);

    this.syncSizing();
    this.initCamera();
    this.scene.registerView(this);
  }

  getElement() {
    return this.canvas;
  }

  getSize() {
    return { width: this.width, height: this.height };
  }

  getCamera() {
    return this.camera;
  }

  resize(w: number, h: number) {
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));

    this.syncSizing();
    this.scene.onViewResize(this);
  }

  update(_t: number, _dt: number) {
    // handle inputs / mutate camera if needed
  }

  dispose() {
    this.scene.deregisterView(this);
    if (!this.externalCanvas) {
      this.canvas.remove();
    }
  }

  private syncSizing() {
    if (!this.externalCanvas) {
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
    }

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.floor(this.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.height * dpr));
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

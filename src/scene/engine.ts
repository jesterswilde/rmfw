import { GPUDeviceManager } from "../gpu/device.js";
import { FrameLoop } from "../core/loop.js";
import { Scene } from "./scene.js";
import { CanvasView } from "./canvasView.js";
import { getInputs, setupInputListeners } from "../inputs.js";
import { moveCam, rotateCam } from "../camera.js";


export class Engine {
  private scene: Scene | null = null;

  async init(): Promise<void> {
    const gpuManager = await GPUDeviceManager.get();
    setupInputListeners();

    const scene = new Scene(gpuManager.device, "dist/wgsl/main.wgsl");
    await scene.loadScene("assets/scene.json");
    this.scene = scene;
    const view = new CanvasView(scene, 640, 480)
    document.body.appendChild(view.getElement());

    const loop = new FrameLoop();

    loop.add((_t, dt) => {
      const inputs = getInputs();
      rotateCam(inputs.look);
      moveCam(inputs.move, dt);
    }, 0);

    loop.add((t, dt) => {
      scene.update(dt);
      view.update(t,dt);
    }, 10);

    loop.add(() => {
      scene.render();
    }, 20);

    loop.start();
  }
}

export const engine = new Engine();
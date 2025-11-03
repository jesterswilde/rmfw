import { GPUDeviceManager } from "./gpu/device.js";
import { FrameLoop } from "./core/loop.js";
import { Scene } from "./scene/scene.js";
import { CanvasView } from "./scene/canvasView.js";

import { getInputs, setupInputListeners } from "./inputs.js";
import { moveCam, rotateCam } from "./camera.js";

(async function main() {
  const gpuManager = await GPUDeviceManager.get();
  setupInputListeners();

  const scene = new Scene(gpuManager.device, "dist/wgsl/main.wgsl");

  const viewA = new CanvasView(scene, /*id*/ 1, 640, 360);
  document.body.appendChild(viewA.getElement());

  // const viewB = new CanvasView(scene, 2, 512, 768);
  // document.body.appendChild(viewB.getElement());

  const loop = new FrameLoop();

  loop.add((t, dt) => {
    const inputs = getInputs();
    rotateCam(inputs.look);
    moveCam(inputs.move, dt);
  }, 0)
  loop.add((t,dt)=>{
    scene.update(dt);
    viewA.update(t, dt);
    // viewB.update(t, dt);
  }, 10)
  loop.add((t,dt)=>{
    scene.render();
  }, 20)

  loop.start();
  window.addEventListener("resize", () => {
    const w = Math.max(1, Math.floor(window.innerWidth * 0.6));
    const h = Math.max(1, Math.floor(window.innerHeight * 0.6));
    viewA.resize(w, h);            // view forwards to scene.onViewResize(...)
    // viewB.resize(...);
  });
})();

import { SceneRuntime } from "./scene/runtime.js";

const runtime = new SceneRuntime();

runtime.ensureReady().catch((err) => {
  console.error("Failed to initialise scene runtime", err);
});

export function getSceneEngine(): SceneRuntime {
  return runtime;
}

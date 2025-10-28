import { Engine } from "./scene/runtime.js";

const runtime = new Engine();

runtime.ensureReady().catch((err) => {
  console.error("Failed to initialise scene runtime", err);
});

export function getSceneEngine(): Engine {
  return runtime;
}

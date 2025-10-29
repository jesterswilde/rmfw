import { engine } from "./scene/runtime.js";

engine.start().catch((err) => {
  console.error("Failed to start scene engine", err);
});

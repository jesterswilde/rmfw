import { Vector3 } from "./utils/math.js";

interface InputObj { 
  move: Vector3;
  look: Vector3;
}

const keyState: Record<string, boolean> = {};
const mouseDelta = { x: 0, y: 0 };
let listenersAttached = false;

const clearKeys = () => {
  for (const k in keyState) keyState[k] = false;
};

const attachListeners = () => {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  window.addEventListener("keydown", (e) => {
    keyState[e.key.toLowerCase()] = true;
  });
  window.addEventListener("keyup", (e) => {
    keyState[e.key.toLowerCase()] = false;
  });
  window.addEventListener("mousemove", (e) => {
    mouseDelta.x += e.movementX;
    mouseDelta.y += e.movementY;
  });
  window.addEventListener("blur", clearKeys);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clearKeys();
    });
  }
};

const onDomReady = (fn: () => void) => {
  if (typeof document === "undefined") {
    fn();
    return;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
};

export const setupInputListeners = () => {
  onDomReady(attachListeners);
};

const computeMoveVector = (): Vector3 => {
  let x = 0;
  let y = 0;
  let z = 0;
  if (keyState["w"]) z += 1;
  if (keyState["s"]) z -= 1;
  if (keyState["a"]) x -= 1;
  if (keyState["d"]) x += 1;
  const length = Math.hypot(x, y, z);
  if (length > 0) {
    x /= length;
    y /= length;
    z /= length;
  }
  return new Vector3(x, y, z);
};

const computeLookVector = (): Vector3 => {
  const sensitivity = 0.002;
  const lookX = mouseDelta.x * sensitivity;
  const lookY = mouseDelta.y * sensitivity;
  mouseDelta.x = 0;
  mouseDelta.y = 0;
  return new Vector3(lookX, lookY, 0);
};

export const getInputs = (): InputObj => {
  return {
    move: computeMoveVector(),
    look: computeLookVector()
  };
};

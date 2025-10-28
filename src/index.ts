import { getSceneEngine } from "./main.js";

const CANVAS_ID = "scene-canvas";

async function mountViewport(): Promise<void> {
  const canvas = document.getElementById(CANVAS_ID) as HTMLCanvasElement | null;
  if (!canvas) {
    console.error(`Missing #${CANVAS_ID} canvas element`);
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(
    1,
    Math.floor(
      rect.width || canvas.clientWidth || canvas.width || window.innerWidth || 1
    )
  );
  const height = Math.max(
    1,
    Math.floor(
      rect.height || canvas.clientHeight || canvas.height || window.innerHeight || 1
    )
  );

  const engine = getSceneEngine();
  try {
    const view = await engine.createViewport(width, height, canvas);

    const cleanup = () => {
      window.removeEventListener("beforeunload", cleanup);
      engine.destroyViewport(view);
    };

    window.addEventListener("beforeunload", cleanup);
  } catch (err) {
    console.error("Failed to initialise viewport", err);
  }
}

function init(): void {
  void mountViewport();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

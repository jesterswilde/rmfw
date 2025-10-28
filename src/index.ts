import { getSceneEngine } from "./main.js";

const ROOT_ID = "default-viewport-root";

async function mountDefaultViewport(): Promise<void> {
  const root = document.getElementById(ROOT_ID);
  if (!root) {
    console.error(`Missing #${ROOT_ID} container for default viewport`);
    return;
  }

  root.textContent = "Initializing viewport...";

  const engine = getSceneEngine();
  try {
    const initialRect = root.getBoundingClientRect();
    const initialWidth = Math.max(
      1,
      Math.floor(initialRect.width || root.clientWidth || window.innerWidth || 1)
    );
    const initialHeight = Math.max(
      1,
      Math.floor(initialRect.height || root.clientHeight || window.innerHeight || 1)
    );

    const view = await engine.createViewport(initialWidth, initialHeight);
    const canvas = view.getElement();
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";

    root.textContent = "";
    root.appendChild(canvas);

    const resizeViewport = () => {
      const rect = root.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width || 1));
      const height = Math.max(1, Math.floor(rect.height || 1));
      view.resize(width, height);
    };

    resizeViewport();

    const observer = new ResizeObserver(() => {
      resizeViewport();
    });
    observer.observe(root);

    const cleanup = () => {
      observer.disconnect();
      window.removeEventListener("beforeunload", cleanup);
      engine.destroyViewport(view);
    };

    window.addEventListener("beforeunload", cleanup);
  } catch (err) {
    console.error("Failed to initialise viewport", err);
    root.textContent = "Failed to initialize viewport.";
  }
}

function init(): void {
  void mountDefaultViewport();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

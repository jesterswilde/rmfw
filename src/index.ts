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
    const measureInitialWidth = () => {
      const rect = root.getBoundingClientRect();
      const candidates = [
        rect.width,
        root.clientWidth,
        typeof window !== "undefined" ? window.innerWidth : undefined
      ];
      for (const value of candidates) {
        if (value && value > 0) {
          return Math.floor(value);
        }
      }
      return 1;
    };

    const measureInitialHeight = () => {
      const rect = root.getBoundingClientRect();
      const candidates = [
        rect.height,
        root.clientHeight,
        typeof window !== "undefined" ? window.innerHeight : undefined
      ];
      for (const value of candidates) {
        if (value && value > 0) {
          return Math.floor(value);
        }
      }
      return 1;
    };

    const initialWidth = Math.max(1, measureInitialWidth());
    const initialHeight = Math.max(1, measureInitialHeight());

    const view = await engine.createViewport(initialWidth, initialHeight);
    const canvas = view.getElement();
    canvas.style.display = "block";

    root.textContent = "";
    root.appendChild(canvas);

    let lastWidth = 0;
    let lastHeight = 0;
    const resizeViewport = (rect?: DOMRectReadOnly) => {
      const candidates = (
        dimension: number | undefined,
        client: number,
        fallback: number
      ) => {
        if (dimension && dimension > 0) return Math.floor(dimension);
        if (client > 0) return Math.floor(client);
        if (fallback > 0) return Math.floor(fallback);
        return 1;
      };

      const width = Math.max(
        1,
        candidates(
          rect?.width,
          root.clientWidth,
          typeof window !== "undefined" ? window.innerWidth : 0
        )
      );
      const height = Math.max(
        1,
        candidates(
          rect?.height,
          root.clientHeight,
          typeof window !== "undefined" ? window.innerHeight : 0
        )
      );

      if (width === lastWidth && height === lastHeight) {
        return;
      }

      lastWidth = width;
      lastHeight = height;
      view.resize(width, height);
    };

    resizeViewport();

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === root) {
          resizeViewport(entry.contentRect);
        }
      }
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

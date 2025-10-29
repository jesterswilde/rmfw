import type { LeafNode } from "./types.js";
import type { ResizableView } from "../scene/interface.js";
import { engine } from "../scene/runtime.js";

type ActiveViewport = {
  view: ResizableView;
  observer: ResizeObserver;
};

const activeViewports = new Map<string, ActiveViewport>();

export function mountViewportPane(
  node: LeafNode,
  container: HTMLElement
): () => void {
  let disposed = false;
  let cleanup: (() => void) | null = null;

  container.textContent = "Initializing viewport...";

  const attach = () => {
    if (disposed) return;
    if (!container.isConnected) {
      requestAnimationFrame(attach);
      return;
    }

    void setupViewport();
  };

  const setupViewport = async () => {
    try {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width || 1));
      const height = Math.max(1, Math.floor(rect.height || 1));

      const previous = activeViewports.get(node.id);
      if (previous) {
        previous.observer.disconnect();
        engine.destroyViewport(previous.view);
        activeViewports.delete(node.id);
      }

      const view = await engine.createViewport(width, height);
      if (disposed) {
        engine.destroyViewport(view);
        return;
      }

      const canvas = view.getElement();
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";

      container.textContent = "";
      container.appendChild(canvas);

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.target !== container) continue;
          const next = entry.contentRect;
          const w = Math.max(1, next.width);
          const h = Math.max(1, next.height);
          view.resize(w, h);
        }
      });

      observer.observe(container);
      activeViewports.set(node.id, { view, observer });

      cleanup = () => {
        observer.disconnect();
        if (activeViewports.get(node.id)?.view === view) {
          activeViewports.delete(node.id);
        }
        engine.destroyViewport(view);
      };
    } catch (err) {
      console.error("Failed to initialise viewport", err);
      if (!disposed) {
        container.textContent = "Failed to initialize viewport";
      }
    }
  };

  attach();

  return () => {
    disposed = true;
    cleanup?.();
    cleanup = null;
  };
}

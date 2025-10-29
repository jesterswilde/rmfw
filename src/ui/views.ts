// /ui/views.ts
export type ViewId = string; // use string ids so it's easy to add new ones

export interface ViewInitCtx {
  paneId: string;                 // Leaf node id
  mountEl: HTMLElement;           // You own this DOM subtree
  requestResizeNow: () => void;   // Call if you need immediate size info
}

export interface ViewInstance {
  /** Clean up all listeners, timers, DOM you created under ctx.mountEl. */
  destroy(): void;
  /** Called when the pane's content box changes size. */
  onResize?(box: DOMRectReadOnly): void;
}

export interface ViewDef {
  id: ViewId;
  label: string; // human-readable label for menus
  /** Called once when the view is mounted. Return your instance. */
  init(ctx: ViewInitCtx): ViewInstance;
}

const registry = new Map<ViewId, ViewDef>();

export function registerView(def: ViewDef) {
  registry.set(def.id, def);
}

export function getView(id: ViewId): ViewDef | undefined {
  return registry.get(id);
}

export function listViews(): ViewDef[] {
  return [...registry.values()];
}

/* -------------------------------------------------------------------------- */
/* Default sample views matching your PaneType enum                            */
/* (Replace with your real ones; these are just placeholders)                 */
/* -------------------------------------------------------------------------- */

function simpleLabelView(text: string): ViewDef {
  return {
    id: text,
    label: text,
    init({ mountEl }: ViewInitCtx) {
      const root = document.createElement("div");
      root.className = "view-simple";
      root.textContent = `${text} view`;
      mountEl.appendChild(root);
      return {
        destroy() {
          root.remove();
        },
        onResize(box) {
          // example: keep a little size hint
          root.dataset["w"] = String(Math.round(box.width));
          root.dataset["h"] = String(Math.round(box.height));
        },
      };
    },
  };
}

// Register placeholders for your existing PaneType values:
registerView(simpleLabelView("Viewport"));
registerView(simpleLabelView("Output"));
registerView(simpleLabelView("Properties"));

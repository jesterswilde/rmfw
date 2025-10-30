import {
  type Node as PaneNode,
  type SplitNode,
  type ChildEntry,
  type LeafNode,
  Orientation,
  PaneType,
} from "./types.js";
import { showContextMenu, type MenuItem } from "./contextMenu.js";

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

const DEFAULT_MIN_PX = 100;

/* -------------------------------------------------------------------------- */
/* Initial tree                                                                */
/* -------------------------------------------------------------------------- */

const initialTree: SplitNode = {
  id: "root",
  kind: "split",
  orientation: Orientation.Vertical,
  minPx: DEFAULT_MIN_PX,
  children: [
    {
      sizePct: 34,
      node: {
        id: "left-leaf",
        kind: "leaf",
        paneType: PaneType.Viewport,
        minPx: DEFAULT_MIN_PX,
      },
    },
    {
      sizePct: 33,
      node: {
        id: "middle-split",
        kind: "split",
        orientation: Orientation.Horizontal,
        minPx: DEFAULT_MIN_PX,
        children: [
          {
            sizePct: 60,
            node: {
              id: "mid-top",
              kind: "leaf",
              paneType: PaneType.Properties,
              minPx: DEFAULT_MIN_PX,
            },
          },
          {
            sizePct: 40,
            node: {
              id: "mid-bottom",
              kind: "leaf",
              paneType: PaneType.Output,
              minPx: DEFAULT_MIN_PX,
            },
          },
        ],
      },
    },
    {
      sizePct: 33,
      node: {
        id: "right-leaf",
        kind: "leaf",
        paneType: PaneType.Output,
        minPx: DEFAULT_MIN_PX,
      },
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Globals                                                                     */
/* -------------------------------------------------------------------------- */

let currentRoot: SplitNode = initialTree;
let rootMountEl: HTMLElement | null = null;
let disposeCurrent: (() => void) | null = null;

/* -------------------------------------------------------------------------- */
/* Path / Tree utilities                                                       */
/* -------------------------------------------------------------------------- */

type Path = number[];

/** Only include minPx if it's defined (for exactOptionalPropertyTypes). */
function withMinPx(minPx: number | undefined): {} {
  return minPx === undefined ? {} : { minPx };
}

/** Get parent split + index for a child at path. */
function getParentByPath(
  root: SplitNode,
  path: Path
): { parent: SplitNode; index: number } | null {
  if (path.length === 0) return null;
  let parent: SplitNode = root;
  for (let i = 0; i < path.length - 1; i++) {
    const idx = path[i]!;
    const entry = parent.children[idx];
    if (!entry || entry.node.kind !== "split") return null;
    parent = entry.node;
  }
  const index = path[path.length - 1]!;
  return { parent, index };
}

/** Get node at path (root if path empty). */
function getNodeByPath(root: SplitNode, path: Path): PaneNode {
  let node: PaneNode = root;
  for (const idx of path) {
    if (node.kind !== "split") break;
    node = node.children[idx]!.node;
  }
  return node;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/* -------------------------------------------------------------------------- */
/* Cached lane spans (spanH / spanV)                                           */
/* -------------------------------------------------------------------------- */
/**
 * spanH = required parallel columns under this node
 * spanV = required parallel rows    under this node
 *
 * combine:
 * - Vertical split (left/right):  spanH = sum(child.spanH), spanV = max(child.spanV)
 * - Horizontal split (top/bottom):spanH = max(child.spanH), spanV = sum(child.spanV)
 * - Leaf: spanH = 1, spanV = 1
 */

function computeSpans(node: PaneNode): void {
  if (node.kind === "leaf") {
    node.spanH = 1;
    node.spanV = 1;
    return;
  }

  let sumH = 0,
    maxH = 0;
  let sumV = 0,
    maxV = 0;

  for (const c of node.children) {
    // ensure child spans are up to date before using them
    computeSpans(c.node);
    const h = c.node.spanH ?? 1;
    const v = c.node.spanV ?? 1;
    sumH += h;
    if (h > maxH) maxH = h;
    sumV += v;
    if (v > maxV) maxV = v;
  }

  if (node.orientation === Orientation.Vertical) {
    node.spanH = sumH; // columns add
    node.spanV = maxV; // rows limited by tallest branch
  } else {
    node.spanH = maxH; // columns limited by widest branch
    node.spanV = sumV; // rows add
  }
}

/** Recompute spans for entire subtree (used at init). */
function recomputeSpansDeep(node: PaneNode): void {
  computeSpans(node);
}

/** Recompute spans up the ancestor chain from a changed child. */
function recomputeSpansUp(root: SplitNode, fromPath: Path): void {
  for (let depth = fromPath.length; depth >= 0; depth--) {
    const node =
      depth === 0
        ? (root as PaneNode)
        : (getNodeByPath(root, fromPath.slice(0, depth)) as PaneNode);
    computeSpans(node);
  }
}

/** Effective minimum pixels along a given axis for a child entry, using spans. */
function effectiveMinPxAlongAxis(entry: ChildEntry, axis: Orientation): number {
  const n = entry.node as PaneNode;
  const lanes = axis === Orientation.Vertical ? (n.spanH ?? 1) : (n.spanV ?? 1);
  const unit = n.minPx ?? DEFAULT_MIN_PX;
  return lanes * unit;
}

/* -------------------------------------------------------------------------- */
/* DOM helpers                                                                 */
/* -------------------------------------------------------------------------- */

function createSplitContainer(orientation: Orientation): HTMLDivElement {
  const div = document.createElement("div");
  div.className = `split ${orientation}`;
  return div;
}
function createChildWrapper(sizePct: number): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "child";
  wrapper.style.flex = `0 0 ${sizePct}%`;
  return wrapper;
}
function setChildSize(wrapper: HTMLElement, pct: number) {
  wrapper.style.flex = `0 0 ${pct}%`;
}
function paneTypeClass(t: PaneType): string {
  switch (t) {
    case PaneType.Viewport:
      return "type-vp";
    case PaneType.Output:
      return "type-out";
    case PaneType.Properties:
      return "type-prop";
  }
}
function createLeafPane(
  node: LeafNode,
  openMenu: (e: MouseEvent) => void
): HTMLDivElement {
  const pane = document.createElement("div");
  pane.className = "pane " + paneTypeClass(node.paneType);
  pane.dataset["paneId"] = node.id;
  pane.style.position = "relative";

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = node.paneType;
  pane.appendChild(label);

  const btn = document.createElement("button");
  btn.className = "pane-btn";
  btn.title = "Pane menu";
  btn.textContent = "⋯";
  btn.addEventListener("click", openMenu);
  pane.appendChild(btn);

  return pane;
}

/* -------------------------------------------------------------------------- */
/* Generic context menu for panes (no closures)                                */
/* -------------------------------------------------------------------------- */

type PaneMenuCtx = { path: Path };

function buildPaneMenu(path: Path): { items: MenuItem[]; ctx: PaneMenuCtx } {
  const closable = (() => {
    const loc = getParentByPath(currentRoot, path);
    if (!loc) return false;
    const { parent } = loc;
    return !(parent === currentRoot && parent.children.length === 1);
  })();

  const typeItemsV: MenuItem[] = (Object.values(PaneType) as PaneType[]).map(
    (pt) => ({ kind: "action", id: `split:v:${pt}`, label: String(pt) })
  );
  const typeItemsH: MenuItem[] = (Object.values(PaneType) as PaneType[]).map(
    (pt) => ({ kind: "action", id: `split:h:${pt}`, label: String(pt) })
  );

  const items: MenuItem[] = [
    { kind: "submenu", label: "Split vertically", items: typeItemsV },
    { kind: "submenu", label: "Split horizontally", items: typeItemsH },
    { kind: "separator" },
    { kind: "action", id: "close", label: "Close", disabled: !closable },
  ];

  return { items, ctx: { path } };
}

function onPaneMenuSelect(id: string, ctx?: PaneMenuCtx) {
  if (!ctx) return;
  const { path } = ctx;

  if (id === "close") {
    closeAtPath(currentRoot, path);
    // spans changed above; rerender
    rerender();
    return;
  }
  if (id.startsWith("split:")) {
    const [, dirChar, paneTypeStr] = id.split(":");
    const orientation =
      dirChar === "v" ? Orientation.Vertical : Orientation.Horizontal;
    const paneType = paneTypeStr as unknown as PaneType;
    splitAtPath(currentRoot, path, orientation, paneType);
    // spans changed above; rerender
    rerender();
    return;
  }
}

/* -------------------------------------------------------------------------- */
/* Drag logic (pair-conserving with effective min along axis)                  */
/* -------------------------------------------------------------------------- */

function attachTwoChildDrag(
  separator: HTMLDivElement,
  parentEl: HTMLElement,
  parentNode: SplitNode,
  leftWrapper: HTMLElement,
  rightWrapper: HTMLElement,
  leftEntry: ChildEntry,
  rightEntry: ChildEntry
): () => void {
  let active = false;
  let startClientPos = 0;
  let startLeftPct = leftEntry.sizePct;
  let startRightPct = rightEntry.sizePct;
  let pairTotalPct = startLeftPct + startRightPct;

  const isVertical = parentNode.orientation === Orientation.Vertical;
  (separator.style as any).touchAction = "none";

  const onPointerDown = (ev: PointerEvent) => {
    ev.preventDefault();
    active = true;
    separator.classList.add("dragging");
    try {
      (separator as any).setPointerCapture?.(ev.pointerId);
    } catch {}

    startClientPos = isVertical ? ev.clientX : ev.clientY;
    startLeftPct = leftEntry.sizePct;
    startRightPct = rightEntry.sizePct;
    pairTotalPct = startLeftPct + startRightPct;

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp, { once: true });
    document.addEventListener("pointercancel", onPointerUp, { once: true });
  };

  const onPointerMove = (ev: PointerEvent) => {
    if (!active) return;

    const rect = parentEl.getBoundingClientRect();
    const deltaPx = (isVertical ? ev.clientX : ev.clientY) - startClientPos;
    const axisSizePx = isVertical ? rect.width : rect.height;

    const deltaPct = (deltaPx / axisSizePx) * 100;

    let newLeftPct = startLeftPct + deltaPct;
    let newRightPct = startRightPct - deltaPct;

    // ✅ use effective mins based on cached spans
    const leftMinPx = effectiveMinPxAlongAxis(
      leftEntry,
      parentNode.orientation
    );
    const rightMinPx = effectiveMinPxAlongAxis(
      rightEntry,
      parentNode.orientation
    );

    const leftMinPct = (leftMinPx / axisSizePx) * 100;
    const rightMinPct = (rightMinPx / axisSizePx) * 100;

    if (newLeftPct < leftMinPct) {
      const diff = leftMinPct - newLeftPct;
      newLeftPct += diff;
      newRightPct -= diff;
    } else if (newRightPct < rightMinPct) {
      const diff = rightMinPct - newRightPct;
      newRightPct += diff;
      newLeftPct -= diff;
    }

    newLeftPct = clamp(newLeftPct, leftMinPct, pairTotalPct - rightMinPct);
    newRightPct = pairTotalPct - newLeftPct;

    // mutate model + live update wrappers (no rerender during drag)
    leftEntry.sizePct = newLeftPct;
    rightEntry.sizePct = newRightPct;

    setChildSize(leftWrapper, newLeftPct);
    setChildSize(rightWrapper, newRightPct);
  };

  const onPointerUp = (ev?: PointerEvent) => {
    active = false;
    separator.classList.remove("dragging");
    if (ev && (separator as any).hasPointerCapture?.(ev.pointerId)) {
      try {
        (separator as any).releasePointerCapture?.(ev.pointerId);
      } catch {}
    }
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointercancel", onPointerUp);
    document.removeEventListener("pointerup", onPointerUp);
    // no rerender; model + wrappers already reflect the sizes
  };

  separator.addEventListener("pointerdown", onPointerDown);

  return () => {
    separator.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointercancel", onPointerUp);
    document.removeEventListener("pointerup", onPointerUp);
  };
}

/* -------------------------------------------------------------------------- */
/* Tree ops (split/close) — mutate model, recompute spans upwards, rerender    */
/* -------------------------------------------------------------------------- */

function deleteEntryAt(root: SplitNode, path: Path): void {
  const loc = getParentByPath(root, path);
  if (!loc) return;
  const { parent, index } = loc;

  const removed = parent.children.splice(index, 1)[0];
  if (!removed) return;

  if (parent.children.length >= 2) {
    // give removed size to left neighbor (or first if index 0)
    const neighborIdx = index - 1 >= 0 ? index - 1 : 0;
    parent.children[neighborIdx]!.sizePct += removed.sizePct;
    return;
  }

  if (parent.children.length === 1) {
    // promote
    const sole = parent.children[0]!;
    const gpLoc = getParentByPath(root, path.slice(0, -1));
    if (gpLoc) {
      const { parent: grand, index: parentIdx } = gpLoc;
      // keep the parent's share at grand level
      sole.sizePct = grand.children[parentIdx]!.sizePct;
      grand.children[parentIdx] = sole;
    } else {
      // parent was root
      if (sole.node.kind === "split") {
        Object.assign(root, sole.node);
      } else {
        sole.sizePct = 100;
        Object.assign(root, {
          id: "root",
          kind: "split" as const,
          orientation: root.orientation ?? Orientation.Vertical,
          minPx: root.minPx,
          children: [sole],
        });
      }
    }
    return;
  }

  // parent.children.length === 0 -> remove parent from grandparent
  const gpLoc = getParentByPath(root, path.slice(0, -1));
  if (!gpLoc) {
    // root lost all children -> ensure one leaf
    root.children = [
      {
        sizePct: 100,
        node: {
          id: `leaf-${Math.random().toString(36).slice(2)}`,
          kind: "leaf",
          paneType: PaneType.Viewport,
          minPx: DEFAULT_MIN_PX,
        },
      },
    ];
    return;
  }
  deleteEntryAt(root, path.slice(0, -1));
}

function closeAtPath(root: SplitNode, path: Path) {
  const loc = getParentByPath(root, path);
  if (!loc) return;
  const { parent } = loc;

  // Don't close the last remaining root child
  if (parent === root && parent.children.length === 1) return;

  deleteEntryAt(root, path);
  // Recompute spans from the parent upwards (path's parent)
  recomputeSpansUp(root, path.slice(0, -1));
}

function splitAtPath(
  root: SplitNode,
  path: Path,
  direction: Orientation,
  newPaneType: PaneType
) {
  const loc = getParentByPath(root, path);
  if (!loc) return;
  const { parent, index } = loc;
  const entry = parent.children[index]!;
  const target = entry.node;

  const mkLeaf = (paneType: PaneType, minPx?: number): ChildEntry => ({
    sizePct: 50,
    node: {
      id: `leaf-${Math.random().toString(36).slice(2)}`,
      kind: "leaf",
      paneType,
      ...withMinPx(minPx),
    },
  });

  if (target.kind !== "leaf") {
    const existing = target as SplitNode;
    parent.children[index] = {
      sizePct: entry.sizePct,
      node: {
        id: `split-${Math.random().toString(36).slice(2)}`,
        kind: "split",
        orientation: direction,
        ...withMinPx(existing.minPx),
        children: [
          { sizePct: 50, node: existing },
          mkLeaf(newPaneType, existing.minPx),
        ],
      },
    };
    // spans changed at this index
    recomputeSpansUp(root, path);
    return;
  }

  if (parent.orientation === direction) {
    // same-orientation: append sibling and split the space
    const taken = entry.sizePct / 2;
    entry.sizePct -= taken;
    parent.children.splice(index + 1, 0, {
      sizePct: taken,
      node: {
        id: `leaf-${Math.random().toString(36).slice(2)}`,
        kind: "leaf",
        paneType: newPaneType,
        ...withMinPx((target as LeafNode).minPx),
      },
    });
    recomputeSpansUp(root, path.slice(0, -1));
  } else {
    // new orientation: wrap in a split
    const first: ChildEntry = { sizePct: 50, node: { ...(target as LeafNode) } };
    const second: ChildEntry = {
      sizePct: 50,
      node: mkLeaf(newPaneType, (target as LeafNode).minPx).node,
    };
    parent.children[index] = {
      sizePct: entry.sizePct,
      node: {
        id: `split-${Math.random().toString(36).slice(2)}`,
        kind: "split",
        orientation: direction,
        ...withMinPx((target as LeafNode).minPx),
        children: [first, second],
      },
    };
    recomputeSpansUp(root, path);
  }
}

/* -------------------------------------------------------------------------- */
/* Render (recursive)                                                          */
/* -------------------------------------------------------------------------- */

function renderNode(node: PaneNode, path: Path) {
  if (node.kind === "leaf") {
    const onOpenMenu = (e: MouseEvent) => {
      const { items, ctx } = buildPaneMenu(path);
      showContextMenu<PaneMenuCtx>(e, items, onPaneMenuSelect, ctx);
    };
    const el = createLeafPane(node as LeafNode, onOpenMenu);
    return { el, destroy() {} };
  }

  const container = createSplitContainer(node.orientation);
  const wrappers: HTMLElement[] = [];
  const childResults: Array<{ el: HTMLElement; destroy: () => void }> = [];
  const disposers: Array<() => void> = [];

  node.children.forEach((child, idx) => {
    const wrap = createChildWrapper(child.sizePct);
    wrappers.push(wrap);

    const rendered = renderNode(child.node, path.concat(idx));
    childResults.push(rendered);
    wrap.appendChild(rendered.el);
    container.appendChild(wrap);

    if (idx < node.children.length - 1) {
      const sep = document.createElement("div");
      sep.className = `separator ${node.orientation}`;
      (sep.style as any).touchAction = "none";
      container.appendChild(sep);
    }
  });

  for (let i = 0; i < node.children.length - 1; i++) {
    const sepIndex = i * 2 + 1;
    const sep = container.children.item(sepIndex) as HTMLDivElement;
    const dispose = attachTwoChildDrag(
      sep,
      container,
      node as SplitNode,
      wrappers[i]!,
      wrappers[i + 1]!,
      node.children[i]!,
      node.children[i + 1]!
    );
    disposers.push(dispose);
  }

  const destroy = () => {
    disposers.forEach((d) => d());
    childResults.forEach((r) => r.destroy());
  };
  return { el: container, destroy };
}

/* -------------------------------------------------------------------------- */
/* Mount                                                                       */
/* -------------------------------------------------------------------------- */

function rerender() {
  if (!rootMountEl) return;
  disposeCurrent?.();
  const rendered = renderNode(currentRoot, []);
  rootMountEl.textContent = "";
  rootMountEl.appendChild(rendered.el);
  disposeCurrent = rendered.destroy;
}

function init() {
  rootMountEl = document.getElementById("panes-root");
  if (!rootMountEl) return;
  currentRoot = initialTree;
  // compute initial spans so drag mins are correct
  recomputeSpansDeep(currentRoot);
  rerender();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

export {};

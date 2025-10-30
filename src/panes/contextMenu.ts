export type MenuItem =
  | { kind: "action"; id: string; label: string; disabled?: boolean }
  | { kind: "submenu"; label: string; items: MenuItem[]; disabled?: boolean }
  | { kind: "separator" };

/**
 * Generic context menu. You pass data-only items and one onSelect callback.
 * We never capture your state—`ctx` is handed back to you on selection.
 */
export function showContextMenu<TCtx>(
  ev: MouseEvent,
  items: MenuItem[],
  onSelect: (id: string, ctx: TCtx | undefined) => void,
  ctx?: TCtx
) {
  ev.preventDefault();

  let activeSub: HTMLElement | null = null;
  let closeTimer: number | null = null;

  const cancelClose = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = window.setTimeout(closeAll, 120);
  };

  const root = document.createElement("div");
  root.className = "ctx root";
  root.setAttribute("role", "menu");

  const build = (container: HTMLElement, list: MenuItem[]) => {
    for (const it of list) {
      if (it.kind === "separator") {
        const sep = document.createElement("div");
        sep.className = "ctx-sep";
        container.appendChild(sep);
        continue;
      }

      const row = document.createElement("div");
      row.className = "ctx-item";
      row.textContent = it.label;

      if ("disabled" in it && it.disabled) {
        row.classList.add("disabled");
      }

      if (it.kind === "action") {
        row.addEventListener("click", () => {
          if (it.disabled) return;
          closeAll();
          onSelect(it.id, ctx);
        });
      } else {
        // SUBMENU
        row.classList.add("has-sub");
        const caret = document.createElement("span");
        caret.className = "ctx-caret";
        caret.textContent = "▸";
        row.appendChild(caret);

        const sub = document.createElement("div");
        sub.className = "ctx sub";
        sub.setAttribute("role", "menu");
        sub.style.display = "none";
        document.body.appendChild(sub);
        build(sub, it.items);

        // Instant open on enter
        row.addEventListener("mouseenter", () => {
          cancelClose();
          if (activeSub && activeSub !== sub) activeSub.style.display = "none";
          activeSub = sub;
          sub.style.display = "block";
          positionSubmenu(row, sub);
        });

        // Root/sub decide closings; do nothing here on leave.
        row.addEventListener("mouseleave", () => { /* no-op */ });

        // Keep open while inside submenu
        sub.addEventListener("mouseenter", cancelClose);

        // If leaving submenu to anywhere that's not the root, schedule close
        sub.addEventListener("mouseleave", (e) => {
          const to = e.relatedTarget as (globalThis.Node | null);
          if (to && root.contains(to)) return; // moving back into root
          scheduleClose();
        });
      }

      container.appendChild(row);
    }
  };

  build(root, items);
  document.body.appendChild(root);
  positionRootMenu(root, ev.clientX, ev.clientY);

  // Centralized close behavior
  root.addEventListener("mouseenter", cancelClose);
  root.addEventListener("mouseleave", (e) => {
    const to = e.relatedTarget as (globalThis.Node | null);
    if (to && activeSub && (activeSub === to || activeSub.contains(to))) return; // moving into submenu
    scheduleClose();
  });

  function closeAll() {
    document.querySelectorAll(".ctx.sub").forEach(n => n.remove());
    root.remove();
    document.removeEventListener("click", onDoc, true);
    document.removeEventListener("contextmenu", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
  }
  const onDoc = (e: MouseEvent) => { if (!root.contains(e.target as globalThis.Node)) closeAll(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeAll(); };

  setTimeout(() => {
    document.addEventListener("click", onDoc, true);
    document.addEventListener("contextmenu", onDoc, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

export function positionRootMenu(menu: HTMLElement, x: number, y: number) {
  menu.style.display = "block";
  const rect = menu.getBoundingClientRect();

  let left = x;
  if (left + rect.width > window.innerWidth) {
    left = x - rect.width;
    if (left < 0) left = Math.max(0, window.innerWidth - rect.width);
  }

  let top = y;
  if (top + rect.height > window.innerHeight) {
    top = y - rect.height;
    if (top < 0) top = Math.max(0, window.innerHeight - rect.height);
  }

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

export function positionSubmenu(parentRow: HTMLElement, sub: HTMLElement) {
  const rowRect = parentRow.getBoundingClientRect();
  const subRect = sub.getBoundingClientRect();

  let left = rowRect.right;
  if (left + subRect.width > window.innerWidth) {
    left = rowRect.left - subRect.width;
    if (left < 0) left = Math.max(0, window.innerWidth - subRect.width);
  }

  let top = rowRect.top;
  if (top + subRect.height > window.innerHeight) {
    top = rowRect.bottom - subRect.height;
    if (top < 0) top = Math.max(0, window.innerHeight - subRect.height);
  }

  sub.style.left = `${left}px`;
  sub.style.top = `${top}px`;
}

# Panes & Views — Development Roadmap

> A working map for building the pane and view system — written for builders, not managers. Each stage should leave the system alive, usable, and cleaner than before.

---

## Core ideas

- The **⋯ button** handles **layout actions only** — splitting and closing.
    
- The **label** shows the **view type** and opens the **type switcher**.
    
- Panes are resizable and splittable; everything should feel fast and physical.
    
- Multiple views can look at the same data.
    
- Input should always do what you expect: mouse to the thing under it, keyboard to the pane that owns focus.
    

---

## - [ ] Phase 1 — Tighten and simplify

 - [ ] Clean up the layout core so it’s predictable and minimal.

- [ ] **Current rough edges**

- [ ]  Rerenders nuke pane state too easily — breaks things like pointer-lock.
    
- [ ] Split and close mutate deep trees in ways that are hard to follow.
    
- [ ] Spans and mins are powerful but dense; trim or clarify.
    
- [ ] Path math is fragile; easy to desync when panes come and go.
    
- [ ]  Event listeners (drag, resize) need bulletproof cleanup.
    
- [ ] Menus mix layout and type logic — we separate them.
    

**Goal:** a layout engine that’s easy to read in one sitting and hard to break accidentally.

---

## - [ ] Phase 2 — View switching

- [ ] Clicking the label brings up a menu of view types. Pick one, and the pane swaps to it.

**Goal:** every pane can change its role on the fly. The layout engine doesn’t care what’s inside.

**Feels like:** instant, lightweight, zero flicker. You’re never punished for trying things.

---

## - [ ] Phase 3 — Input and focus

Get the rules of engagement between panes and input devices solid.

- [ ] **Mouse:** goes straight to whatever’s under it. A 3D view can lock or hide the cursor and it just works.

- [ ] **Keyboard:** belongs to the active pane — the one you clicked last. Global keys only fire when nothing claims them.

- [ ] **Focus:** clear visual hint. Esc always gets you out of a locked state cleanly.

**Goal:** feels like a desktop app from the 90s — direct, reliable, no ghosts.

---

## - [ ] Phase 4 — Graph View

- [  ] Wire in the graph editor as a real view type.

**Goal:** prove the system can host a serious interactive canvas.

---

## - [ ] Phase 5 — 3D View

- [ ] Add the 3D viewport. Real rendering, camera controls, pointer-lock, resize.

---

## Phase 6 — Multiple views on one source

- [ ] Make it normal to open several panes that talk to the same data.

**Example:** two camera angles on one scene, or two parts of one graph.

**Goal:** show that modules can own their own state and still cooperate without the layout engine knowing anything about them.

---

## - [ ] Phase 7 — Saved layouts

- [ ] Let users stash and restore arrangements.

**Goal:** one-click restore of your favorite setup. Nothing fancy — just solid persistence that doesn’t corrupt itself.

---

## - [ ] Phase 8 — Fit and finish

Once everything works, spend a cycle making it _feel_ right.

**Examples:** faster splits, smarter default sizes, crisper focus rings, little conveniences you discover by using it.

**Goal:** small polish that makes you forget it’s a prototype.

---

## Phase 9 — Reliability and performance

Accessibility, cleanup, and long-haul stability.

**Targets**

- Accessible

- Performance tooling

- Fast even with multiple live canvases.
    
- Tests for split/close, drag, focus, and saved layouts.
    

**Goal:** it just works, no matter how long it’s been open.
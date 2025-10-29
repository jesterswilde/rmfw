## Node Editor Roadmap

A staged plan from the current minimal scaffold toward a full Houdini‑inspired node editor.

### ✅ Stage 1 — Basic Node Selection (Done)

Static canvas

Hardcoded nodes

Click to select / deselect

### ✅ Stage 1.B — Refactor (styling)

Currently we have lots of colors all over the place, we need to move all the color and styling information up to a styles object at the top so we can make all that editing in one place. 

### 🔜 Stage 2 — Basic Interaction

Drag to move a single selected node

Maintain z‑order (bring to front on select/drag)

Visual feedback: hover states & selection outlines

### Stage 3 — Multi‑Selection + Gestures

Marquee selection rectangle

Shift‑click additive selection

Move multiple nodes together

Keyboard shortcuts (Delete, Copy/Paste future)

### Stage 4 — Ports + Connections

Render input/output ports

Click‑drag to create connections

Distinguish connection types:

Transform hierarchy

Render pipeline / material graph

Basic dependency ordering for rendering

### Stage 5 — Node Lifecycle

Create new nodes

Delete nodes

Persistence: save/load graph to JSON

### Stage 6 — Subgraphs ("Subnetworks")

Group nodes into a sub‑view

Inputs/outputs auto‑infer from inner structure

Enter/exit subgraph UI

Visualization breadcrumbs

### Stage 7 — UI Views + Inspection

Sidebar inspector to edit node labels & parameters

Better input widgets (numbers, dropdowns, etc.)

Alignment & layout helpers (snap/grid logic)

Stage 8 — Advanced Graph Features

Undo/redo stack

Node templates/presets

Graph evaluation scheduling

History and debug overlays

### Stage 9 — Visual Polish

Smooth animations for move/select

Dark/light themes

Minimap view

High‑detail port icons
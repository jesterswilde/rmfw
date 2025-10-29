## Node Editor Roadmap

A staged plan from the current minimal scaffold toward a full Houdini‑inspired node editor.

### ✅ Stage 1 — Basic Node Selection (Done)

Static canvas

Hardcoded nodes

Click to select / deselect

### ✅ Stage 1.B — Refactor (styling)

Currently we have lots of colors all over the place, we need to move all the color and styling information up to a styles object at the top so we can make all that editing in one place. 

### ✅ Stage 2 — Basic Interaction

Drag to move a single selected node

Maintain z‑order (bring to front on select/drag)

Visual feedback: hover states & selection outlines

### ✅ Stage 3 — Multi‑Selection + Gestures

Marquee selection rectangle

Shift‑click additive selection

Move multiple nodes together

### ✅ Stage 4 — Node Lifecycle
Create new nodes

Delete nodes

Keyboard shortcuts (Delete, Copy/Paste future)

### 🔜 Stage 5 — Ports + Connections

Render input/output ports

Click‑drag to create connections

Can click on a connection to select it

Should be able to delete a connection that is selected. 

Note: 
    We ahve selection modes, it defaults to node. If we have ea connection selected, then we are in connection selection mode. We can only select things in the given mode we are (except for single click, that just goes to the top thing we hit) 
    Shift and Marquee work for whatever mode we are in.

### Stage 6 - Module Ports

Distinguish connection types:

Transform hierarchy / Render pipeline / material graph

Node types should be modular so I can add more later and it should just slot in. 

### Stage 6 - Persistance

Persistence: save/load graph to JSON

Save/Load to both local storage and files

### Stage 7 — Subgraphs ("Subnetworks")

Group nodes into a sub‑view

Inputs/outputs of subnetwork internal reflected on subnetwork external

Enter/exit subgraph UI

Visualization breadcrumbs

### Stage 8 — UI View and reading real data

Sidebar inspector to edit node labels & parameters

Better input widgets (numbers, dropdowns, etc.)

Alignment & layout helpers (snap/grid logic)

### Stage 9 — Advanced Graph Features

Undo/redo stack

Node templates/presets

Graph evaluation scheduling

History and debug overlays

### Stage 10 — Visual Polish

Smooth animations for move/select

Dark/light themes

Minimap view

High‑detail port icons
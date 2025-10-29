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

### ✅ Stage 5 — Ports + Connections

Render input/output ports

Click‑drag to create connections

Can click on a connection to select it

Should be able to delete a connection that is selected. 

Note: 
    We ahve selection modes, it defaults to node. If we have ea connection selected, then we are in connection selection mode. We can only select things in the given mode we are (except for single click, that just goes to the top thing we hit) 
    Shift and Marquee work for whatever mode we are in.

### 🔜 Stage 6 - Module Ports

Distinguish connection types:

Port types types: Transform hierarchy / Render pipeline.
    Only ports of like types can connect to each other.
    Ports can have names (which you'll see when you hover of them, type and the optional name)
    A node may have multiple ports of the same type
    A port can define amount how many connections it may have (a finite number, or unlimited)

    Ports and connections of a given type should be colored similarly. 

Node types should be modular so I can add more later and it should just slot in. 

Tooltips: Hovering over a port should tell you the type.

### Stage 7 - Persistance

Persistence: save/load graph to JSON

Save/Load to both local storage and files

### Stage 8 — Subgraphs ("Subnetworks")

Group nodes into a sub‑view

Inputs/outputs of subnetwork internal reflected on subnetwork external

Enter/exit subgraph UI

Visualization breadcrumbs

### Stage 9 — UI View and reading real data

Sidebar inspector to edit node labels & parameters

Better input widgets (numbers, dropdowns, etc.)

Alignment & layout helpers (snap/grid logic)

### Stage 10 — Advanced Graph Features

Undo/redo stack

Node templates/presets

Graph evaluation scheduling

History and debug overlays

### Stage 11 — Visual Polish

Smooth animations for move/select

Dark/light themes

Minimap view

High‑detail port icons
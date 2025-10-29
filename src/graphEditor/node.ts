// =============================
// Node Editor — Step 1.B (TS)
// =============================
// Styling refactor: centralize all palette/sizing in a theme "styles" object,
// hydrated from CSS custom properties so designers can tweak without touching TS.

// ------- Types & Models -------

type NodeId = string;

interface Vec2 { x: number; y: number }

interface NodeRect {
  x: number; y: number; width: number; height: number;
}

interface NodeModel {
  id: NodeId;
  label: string;
  position: Vec2; // top-left in canvas coords
  size: Vec2;     // width / height
  selected?: boolean;
}

// ------- Theme / Styles -------

interface Styles {
  colors: {
    bg: string;
    panel: string;
    ink: string;
    inkMuted: string;
    accent: string;
    accent2: string;
    node: string;
    nodeStroke: string;
    nodeSelected: string;
  };
  node: {
    radius: number;
    titleH: number;
    strokeW: number;
    strokeWSelected: number;
  };
  text: {
    family: string;
    weightStrong: number;
    sizeLabel: number;
    colorLabel: string;
  };
}

function cssVar(name: string): string {
  const root = document.documentElement;
  const v = getComputedStyle(root).getPropertyValue(name);
  return v.trim();
}

function cssNumber(name: string, fallback = 0): number {
  const raw = cssVar(name);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Build styles from CSS variables with sensible fallbacks
function readStyles(): Styles {
  return {
    colors: {
      bg: cssVar('--bg') || 'magenta',
      panel: cssVar('--panel') || 'magenta',
      ink: cssVar('--ink') || 'magenta',
      inkMuted: cssVar('--ink-muted') || 'magenta',
      accent: cssVar('--accent') || 'magenta',
      accent2: cssVar('--accent-2') || 'magenta',
      node: cssVar('--node') || 'magenta',
      nodeStroke: cssVar('--node-stroke') || 'magenta',
      nodeSelected: cssVar('--node-selected') || 'magenta',
    },
    node: {
      radius: cssNumber('--node-radius', 12),
      titleH: cssNumber('--node-title-h', 26),
      strokeW: cssNumber('--stroke-normal', 1),
      strokeWSelected: cssNumber('--stroke-selected', 2),
    },
    text: {
      family: cssVar('--font-ui') || 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Inter, Arial',
      weightStrong: cssNumber('--font-weight-strong', 600),
      sizeLabel: cssNumber('--font-size-label', 12),
      colorLabel: cssVar('--ink') || 'magenta',
    }
  };
}

// Global styles object; if theme vars change (e.g., toggling data-theme),
// call refreshStyles() and re-render.
let styles: Styles = readStyles();
function refreshStyles() {
  styles = readStyles();
}

// ------- Canvas Setup -------

const canvas = document.getElementById('node-canvas') as HTMLCanvasElement;
if (!canvas) throw new Error('Canvas element #node-canvas not found');
const maybeCTX = canvas.getContext('2d');
if (!maybeCTX) throw new Error('2D context not available');
const ctx = maybeCTX;

// High-DPI/backing store scale
function fitCanvasToDisplaySize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const { clientWidth, clientHeight } = canvas;
  if (canvas.width !== Math.floor(clientWidth * dpr) || canvas.height !== Math.floor(clientHeight * dpr)) {
    canvas.width = Math.floor(clientWidth * dpr);
    canvas.height = Math.floor(clientHeight * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // map logical CSS px to device px
}

function getCanvasPoint(evt: MouseEvent): Vec2 {
  const rect = canvas.getBoundingClientRect();

  // 1) Convert from CSS px to backing-store px (device pixels)
  const xCSS = evt.clientX - rect.left;
  const yCSS = evt.clientY - rect.top;
  const xDevice = xCSS * (canvas.width / rect.width);
  const yDevice = yCSS * (canvas.height / rect.height);

  // 2) Convert from backing-store px to canvas user space by
  //    inverting the current transform (handles DPR, pan/zoom, etc.)
  const inv = ctx.getTransform().inverse();
  const p = new DOMPoint(xDevice, yDevice).matrixTransform(inv);
  return { x: p.x, y: p.y };
}



// ------- Data Store (Hardcoded) -------

const nodes: NodeModel[] = [
  { id: 'geo',   label: 'Geometry', position: { x: 120,  y: 120 },  size: { x: 160, y: 80 } },
  { id: 'xform', label: 'Transform', position: { x: 360,  y: 240 }, size: { x: 180, y: 88 } },
  { id: 'mat',   label: 'Material', position: { x: 660,  y: 180 },  size: { x: 170, y: 80 } },
  { id: 'out',   label: 'Render Output', position: { x: 920, y: 280 }, size: { x: 200, y: 96 } }
];

let selectedId: NodeId | null = null;

// ------- Rendering -------

function clear() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawRoundedRect(r: NodeRect, radius = styles.node.radius) {
  const { x, y, width, height } = r;
  const rad = radius;
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + width - rad, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + rad);
  ctx.lineTo(x + width, y + height - rad);
  ctx.quadraticCurveTo(x + width, y + height, x + width - rad, y + height);
  ctx.lineTo(x + rad, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function drawNode(node: NodeModel) {
  const rect: NodeRect = { x: node.position.x, y: node.position.y, width: node.size.x, height: node.size.y };
  const isSelected = node.id === selectedId;

  // body
  drawRoundedRect(rect);
  ctx.fillStyle = isSelected ? styles.colors.nodeSelected : styles.colors.node;
  ctx.fill();

  // stroke
  ctx.lineWidth = isSelected ? styles.node.strokeWSelected : styles.node.strokeW;
  ctx.strokeStyle = isSelected ? styles.colors.accent : styles.colors.nodeStroke;
  ctx.stroke();

  // title bar (subtle)
  const titleH = styles.node.titleH;
  drawRoundedRect({ ...rect, height: titleH });
  // use a translucent overlay derived from accent / ink for selected and default
  ctx.fillStyle = isSelected ? 'rgba(106,163,255,0.18)' : 'rgba(255,255,255,0.04)';
  ctx.fill();

  // label text
  ctx.fillStyle = styles.text.colorLabel;
  ctx.font = `${styles.text.weightStrong} ${styles.text.sizeLabel}px ${styles.text.family}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(node.label, rect.x + 10, rect.y + titleH / 2);
}

function render() {
  clear();
  // Future: draw connections first, then nodes in z-order.
  for (const n of nodes) drawNode(n);
}

// ------- Hit Testing -------

function hitTest(pt: Vec2): NodeModel | null {
  // Iterate from topmost to bottommost (last drawn is topmost in our simple painter's algo)
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    const { x, y } = n.position; const { x: w, y: h } = n.size;
    if (pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h) {
      return n;
    }
  }
  return null;
}

// ------- Interaction -------

canvas.addEventListener('mousedown', (evt) => {
  if (evt.button !== 0) return; // left button only
  const pt = getCanvasPoint(evt);
  const target = hitTest(pt);
  selectedId = target ? target.id : null;
  render();
});

// Clear selection on dblclick empty background (no drag behavior yet)
canvas.addEventListener('dblclick', () => {
  selectedId = null; render();
});

// ------- Resize / Init -------

function onResizeOrThemeChange() {
  refreshStyles();          // re-hydrate in case CSS vars changed (e.g., theme toggle)
  fitCanvasToDisplaySize();
  render();
}

window.addEventListener('resize', onResizeOrThemeChange);

// Optional: if you add theme toggling via data attributes, fire a custom event and listen here.
// window.addEventListener('themechange', onResizeOrThemeChange);

// Initial mount
onResizeOrThemeChange();

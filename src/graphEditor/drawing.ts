import type { NodeRect, NodeModel, GraphState, ConnectionModel, PortModel } from "./interfaces.js";
import { styles } from "./styles.js";
import { portAnchor, findPortById, __PORT_VISUAL_R } from "./helpers.js";

/* ===== Primitives ===== */

function drawRoundedRect({ctx}: GraphState, r: NodeRect, radius = styles.node.radius) {
  const { x, y, width, height } = r, rad = radius, c = ctx;
  c.beginPath();
  c.moveTo(x + rad, y);
  c.lineTo(x + width - rad, y);
  c.quadraticCurveTo(x + width, y, x + width, y + rad);
  c.lineTo(x + width, y + height - rad);
  c.quadraticCurveTo(x + width, y + height, x + width - rad, y + height);
  c.lineTo(x + rad, y + height);
  c.quadraticCurveTo(x, y + height, x, y + height - rad);
  c.lineTo(x, y + rad);
  c.quadraticCurveTo(x, y, x + rad, y);
  c.closePath();
}

/* ===== Nodes ===== */

function drawNode(state: GraphState, node: NodeModel) {
  const { ctx, selectedIDs, hoverID } = state;
  const rect: NodeRect = { x: node.position.x, y: node.position.y, width: node.size.x, height: node.size.y };
  const isSelected = selectedIDs.has(node.id);
  const isHover = node.id === hoverID && !isSelected;

  drawRoundedRect(state, rect);
  ctx.fillStyle = isSelected ? styles.colors.nodeSelected : styles.colors.node;
  ctx.fill();

  if (isSelected) {
    ctx.save();
    ctx.shadowColor = styles.colors.accent;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = styles.colors.accent;
    ctx.globalAlpha = styles.effects.selectionGlowAlpha;
    ctx.lineWidth = styles.node.strokeWSelected + 2;
    ctx.stroke();
    ctx.restore();
  }

  ctx.lineWidth = isSelected ? styles.node.strokeWSelected : styles.node.strokeW;
  ctx.strokeStyle = isSelected ? styles.colors.accent : styles.colors.nodeStroke;
  ctx.stroke();

  if (isHover) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = styles.colors.accent;
    ctx.globalAlpha = styles.effects.hoverOutlineAlpha;
    drawRoundedRect(state, { ...rect, x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 });
    ctx.stroke();
    ctx.restore();
  }

  const titleH = styles.node.titleH;
  drawRoundedRect(state, { ...rect, height: titleH });
  ctx.fillStyle = isSelected ? 'rgba(106,163,255,0.18)' : 'rgba(255,255,255,0.04)';
  ctx.fill();

  ctx.fillStyle = styles.text.colorLabel;
  ctx.font = `${styles.text.weightStrong} ${styles.text.sizeLabel}px ${styles.text.family}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(node.label, rect.x + 10, rect.y + titleH / 2);
}

/* ===== Colors ===== */
function colorForPort(p: PortModel) {
  return p.portType === 'transform' ? styles.colors.portTransform : styles.colors.portRender;
}
function colorForWire(portType: 'transform' | 'render') {
  return portType === 'transform' ? styles.colors.wireTransform : styles.colors.wireRender;
}

/* ===== Port Hemispheres (clip just outside the node) ===== */
function clipOutsideOfNode(ctx: CanvasRenderingContext2D, node: NodeModel, side: 'input' | 'output') {
  const y = node.position.y, h = node.size.y;
  ctx.save();
  if (side === 'input') {
    ctx.beginPath();
    ctx.rect(-1e6, -1e6, 2e6, 1e6 + y);   // keep area above node top
    ctx.clip();
  } else {
    ctx.beginPath();
    ctx.rect(-1e6, y + h, 2e6, 1e6);      // keep area below node bottom
    ctx.clip();
  }
}

/* Tooltip info for a separate top-layer pass */
type TooltipSpec = { p: PortModel; x: number; y: number };

function drawPorts(state: GraphState, node: NodeModel, tooltipAcc: TooltipSpec[]) {
  const { ctx, hoverPortID } = state;
  const ports = node.ports;
  if (!ports) return;

  const all = [...ports.inputs, ...ports.outputs];
  for (const p of all) {
    const a = portAnchor(node, p);
    const hovered = hoverPortID === p.id;

    clipOutsideOfNode(ctx, node, p.side);

    ctx.fillStyle = colorForPort(p);
    ctx.beginPath();
    ctx.arc(a.x, a.y, __PORT_VISUAL_R, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = styles.colors.nodeStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(a.x, a.y, __PORT_VISUAL_R, 0, Math.PI * 2);
    ctx.stroke();

    if (hovered) {
      ctx.strokeStyle = colorForPort(p);
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(a.x, a.y, __PORT_VISUAL_R + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Defer tooltip drawing to the very end (outside clips)
      tooltipAcc.push({ p, x: a.x, y: a.y });
    }

    ctx.restore(); // end clip
  }
}

/* ===== Connections (vertical) ===== */
function drawConnection(state: GraphState, c: ConnectionModel, { selected = false, hover = false } = {}) {
  const { ctx } = state;

  const fromNode = state.nodes.find(n => n.id === c.from.nodeId)!;
  const toNode   = state.nodes.find(n => n.id === c.to.nodeId)!;
  const fromPort = fromNode.ports!.outputs.find(p => p.id === c.from.portId)!;
  const toPort   = toNode.ports!.inputs.find(p => p.id === c.to.portId)!;
  const p0 = portAnchor(fromNode, fromPort);
  const p3 = portAnchor(toNode, toPort);
  const dy = Math.max(40, Math.abs(p3.y - p0.y) * 0.5);
  const p1 = { x: p0.x, y: p0.y + dy };
  const p2 = { x: p3.x, y: p3.y - dy };

  ctx.save();
  ctx.lineWidth = selected ? 3 : 2;
  ctx.globalAlpha = hover && !selected ? 0.9 : 1;
  ctx.strokeStyle = colorForWire(c.portType);
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  ctx.stroke();
  ctx.restore();
}

/* Wire preview */
function drawWireDrag(state: GraphState) {
  if (!state.wireDrag.active || !state.wireDrag.from || !state.wireDrag.toPos) return;

  const start = findPortById(state, state.wireDrag.from.portId);
  if (!start) return;

  const p0 = portAnchor(start.node, start.port);
  const p3 = state.wireDrag.toPos!;
  const sign = start.port.side === 'output' ? +1 : -1;
  const dy = Math.max(40, Math.abs(p3.y - p0.y) * 0.5);
  const p1 = { x: p0.x, y: p0.y + sign * dy };
  const p2 = { x: p3.x, y: p3.y - sign * dy };

  const { ctx } = state;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = colorForWire(start.port.portType);
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  ctx.stroke();
  ctx.restore();
}

/* ===== Marquee (restored) ===== */
function drawMarquee(state: GraphState) {
  const { ctx, marquee } = state;
  if (!marquee.active || !marquee.anchor || !marquee.current) return;

  const x = Math.min(marquee.anchor.x, marquee.current.x);
  const y = Math.min(marquee.anchor.y, marquee.current.y);
  const w = Math.abs(marquee.anchor.x - marquee.current.x);
  const h = Math.abs(marquee.anchor.y - marquee.current.y);

  ctx.save();
  ctx.fillStyle = styles.colors.accent;
  ctx.globalAlpha = styles.effects.marqueeFillAlpha;
  ctx.fillRect(x, y, w, h);

  ctx.globalAlpha = styles.effects.marqueeStrokeAlpha;
  ctx.lineWidth = 1;
  ctx.strokeStyle = styles.colors.accent;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

/* ===== Tooltip top-layer (above everything) ===== */
function drawPortTooltip(state: GraphState, p: PortModel, at: { x: number; y: number }) {
  const { ctx, canvas } = state;
  const pad = 6;
  const tip = p.name ? `${p.portType} — ${p.name}` : p.portType;

  ctx.save();
  ctx.font = `12px ${styles.text.family}`;
  const textW = ctx.measureText(tip).width;
  const boxH = 20;
  const boxW = textW + pad * 2;

  const margin = 8;    // distance from port
  const sidePad = 10;  // canvas edge padding

  // Prefer above
  let bx = at.x - boxW / 2;
  let by = at.y - margin - boxH;

  const cw = canvas.width, ch = canvas.height;

  // If above goes off top, try right; else left
  if (by < sidePad) {
    bx = at.x + margin;
    by = at.y - boxH / 2;
    if (bx + boxW > cw - sidePad) {
      bx = at.x - margin - boxW;
      if (bx < sidePad) bx = sidePad;
    }
  }

  // Clamp inside canvas
  if (bx < sidePad) bx = sidePad;
  if (bx + boxW > cw - sidePad) bx = cw - sidePad - boxW;
  if (by < sidePad) by = sidePad;
  if (by + boxH > ch - sidePad) by = ch - sidePad - boxH;

  ctx.fillStyle = styles.colors.tooltipBg;
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.fillStyle = styles.colors.tooltipInk;
  ctx.textBaseline = "middle";
  ctx.fillText(tip, bx + pad, by + boxH / 2);
  ctx.restore();
}

/* ===== Public ===== */

export function clear({ctx, canvas}: GraphState) { ctx.clearRect(0, 0, canvas.width, canvas.height); }

export function render(state: GraphState) {
  clear(state);

  // Accumulate tooltips so they render last (above any clips)
  const tooltipQueue: TooltipSpec[] = [];

  // Connections under nodes
  for (const c of state.connections) {
    const selected = state.selectedConnectionIDs.has(c.id);
    const hover = state.hoverConnectionID === c.id && !selected;
    drawConnection(state, c, { selected, hover });
  }

  // Nodes + ports
  for (const n of state.nodes) {
    drawNode(state, n);
    drawPorts(state, n, tooltipQueue);
  }

  // Wire preview on top of nodes/ports
  drawWireDrag(state);

  // Marquee above all static elements
  drawMarquee(state);

  // Tooltips very top
  for (const t of tooltipQueue) drawPortTooltip(state, t.p, { x: t.x, y: t.y });
}

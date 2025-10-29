import type { NodeRect, NodeModel, GraphState, ConnectionModel } from "./interfaces.js";
import { styles } from "./styles.js";
import { portAnchor } from "./helpers.js";

/* Nodes */

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

function drawPorts(state: GraphState, node: NodeModel) {
  const { ctx, hoverPortID } = state;
  const ports = node.ports;
  if (!ports) return;

  const all = [...ports.inputs, ...ports.outputs];
  for (const p of all) {
    const a = portAnchor(node, p);
    const hovered = hoverPortID === p.id;

    // base
    ctx.save();
    ctx.fillStyle = styles.colors.portFill!;
    ctx.strokeStyle = styles.colors.nodeStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // hover ring
    if (hovered) {
      ctx.save();
      ctx.strokeStyle = styles.colors.accent;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

/* Connections */

function drawConnection(state: GraphState, c: ConnectionModel, { selected = false, hover = false } = {}) {
  const { ctx } = state;
  const fromNode = state.nodes.find(n => n.id === c.from.nodeId)!;
  const toNode = state.nodes.find(n => n.id === c.to.nodeId)!;
  const fromPort = fromNode.ports!.outputs.find(p => p.id === c.from.portId)!;
  const toPort = toNode.ports!.inputs.find(p => p.id === c.to.portId)!;

  const p0 = portAnchor(fromNode, fromPort);
  const p3 = portAnchor(toNode, toPort);
  const dx = Math.max(40, Math.abs(p3.x - p0.x) * 0.5);
  const p1 = { x: p0.x + dx, y: p0.y };
  const p2 = { x: p3.x - dx, y: p3.y };

  ctx.save();
  ctx.lineWidth = selected ? 3 : 2;
  ctx.globalAlpha = hover && !selected ? 0.9 : 1;
  ctx.strokeStyle = selected ? styles.colors.connectionSelected! : styles.colors.connection!;
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  ctx.stroke();
  ctx.restore();
}

function drawWireDrag(state: GraphState) {
  if (!state.wireDrag.active || !state.wireDrag.from || !state.wireDrag.toPos) return;
  const { ctx } = state;
  const fromNode = state.nodes.find(n => n.id === state.wireDrag.from!.nodeId)!;
  const fromPort = fromNode.ports!.outputs.find(p => p.id === state.wireDrag.from!.portId)!;
  const p0 = portAnchor(fromNode, fromPort);
  const p3 = state.wireDrag.toPos!;
  const dx = Math.max(40, Math.abs(p3.x - p0.x) * 0.5);
  const p1 = { x: p0.x + dx, y: p0.y };
  const p2 = { x: p3.x - dx, y: p3.y };

  ctx.save();
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = styles.colors.accent2;
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  ctx.stroke();
  ctx.restore();
}

/* Marquee */

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

/* Public */

export function clear({ctx, canvas}: GraphState) { ctx.clearRect(0, 0, canvas.width, canvas.height); }

export function render(state: GraphState) {
  clear(state);

  for (const c of state.connections) {
    const selected = state.selectedConnectionIDs.has(c.id);
    const hover = state.hoverConnectionID === c.id && !selected;
    drawConnection(state, c, { selected, hover });
  }

  for (const n of state.nodes) {
    drawNode(state, n);
    drawPorts(state, n);
  }

  drawWireDrag(state);
  drawMarquee(state);
}

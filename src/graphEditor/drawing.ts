import type { NodeRect, NodeModel, GraphState } from "./interfaces.js";
import { styles } from "./styles.js";

function drawRoundedRect({ctx}: GraphState, r: NodeRect, radius = styles.node.radius) {
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

function drawNode(state: GraphState, node: NodeModel) {
  const {ctx, selectedID, hoverID} = state
  const rect: NodeRect = { x: node.position.x, y: node.position.y, width: node.size.x, height: node.size.y };
  const isSelected = node.id === selectedID;
  const isHover = node.id === hoverID && !isSelected;

  // body
  drawRoundedRect(state, rect);
  ctx.fillStyle = isSelected ? styles.colors.nodeSelected : styles.colors.node;
  ctx.fill();

  // subtle selection glow (under stroke)
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

  // main stroke
  ctx.lineWidth = isSelected ? styles.node.strokeWSelected : styles.node.strokeW;
  ctx.strokeStyle = isSelected ? styles.colors.accent : styles.colors.nodeStroke;
  ctx.stroke();

  // hover outline (when not selected)
  if (isHover) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = styles.colors.accent;
    ctx.globalAlpha = styles.effects.hoverOutlineAlpha;
    drawRoundedRect(state, { ...rect, x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 });
    ctx.stroke();
    ctx.restore();
  }

  // title bar (subtle)
  const titleH = styles.node.titleH;
  drawRoundedRect(state, { ...rect, height: titleH });
  ctx.fillStyle = isSelected ? 'rgba(106,163,255,0.18)' : 'rgba(255,255,255,0.04)';
  ctx.fill();

  // label text
  ctx.fillStyle = styles.text.colorLabel;
  ctx.font = `${styles.text.weightStrong} ${styles.text.sizeLabel}px ${styles.text.family}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(node.label, rect.x + 10, rect.y + titleH / 2);
}

export function clear({ctx, canvas}: GraphState) { ctx.clearRect(0, 0, canvas.width, canvas.height); }

export function render(state: GraphState) {
  clear(state);
  // Future: connections first
  for (const n of state.nodes) 
    drawNode(state, n);
}

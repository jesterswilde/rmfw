// ================================
// Node Editor — Stage 3 (Drawing)
// ================================

import type { NodeRect, NodeModel, GraphState } from "./interfaces.js";
import { styles } from "./styles.js";

// ------- Primitives -------

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

// ------- Public API -------

export function clear({ctx, canvas}: GraphState) { ctx.clearRect(0, 0, canvas.width, canvas.height); }

export function render(state: GraphState) {
  clear(state);
  // Future: draw connections first
  for (const n of state.nodes) drawNode(state, n);
  drawMarquee(state);
}

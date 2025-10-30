export interface Styles {
  colors: {
    bg: string; panel: string; ink: string; inkMuted: string;
    accent: string; accent2: string; node: string; nodeStroke: string; nodeSelected: string;
    portTransform: string;        // new
    portRender: string;           // new
    wireTransform: string;        // new
    wireRender: string;           // new
    tooltipBg: string;            // new
    tooltipInk: string;           // new
  };
  node: { radius: number; titleH: number; strokeW: number; strokeWSelected: number; };
  text: { family: string; weightStrong: number; sizeLabel: number; colorLabel: string; };
  effects: { hoverOutlineAlpha: number; selectionGlowAlpha: number; marqueeFillAlpha: number; marqueeStrokeAlpha: number; };
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

function readStyles(): Styles {
  return {
    colors: {
      bg: cssVar('--bg') || '#0f1115',
      panel: cssVar('--panel') || '#151822',
      ink: cssVar('--ink') || '#e8ecf1',
      inkMuted: cssVar('--ink-muted') || '#98a2b3',
      accent: cssVar('--accent') || '#6aa3ff',
      accent2: cssVar('--accent-2') || '#5de4c7',
      node: cssVar('--node') || '#1c2230',
      nodeStroke: cssVar('--node-stroke') || '#2b3345',
      nodeSelected: cssVar('--node-selected') || '#2a3550',
      portTransform: cssVar('--port-transform') || '#5de4c7',
      portRender: cssVar('--port-render') || '#f59e0b',
      wireTransform: cssVar('--wire-transform') || '#34d399',
      wireRender: cssVar('--wire-render') || '#fbbf24',
      tooltipBg: cssVar('--tooltip-bg') || 'rgba(0,0,0,0.85)',
      tooltipInk: cssVar('--tooltip-ink') || '#ffffff',
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
      colorLabel: cssVar('--ink') || '#e8ecf1',
    },
    effects: {
      hoverOutlineAlpha: 0.5,
      selectionGlowAlpha: 0.25,
      marqueeFillAlpha: 0.15,
      marqueeStrokeAlpha: 0.9,
    }
  };
}

export let styles: Styles = readStyles();
export function refreshStyles() { styles = readStyles(); }

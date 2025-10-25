export type Tickable = (t: number, dt: number) => void;

export class FrameLoop {
  private subs = new Set<Tickable>();
  private last = performance.now();
  private running = false;

  add(fn: Tickable) { this.subs.add(fn); }
  remove(fn: Tickable) { this.subs.delete(fn); }

  start() {
    if (this.running) return;
    this.running = true;
    const step = () => {
      if (!this.running) return;
      const now = performance.now();
      const dt = (now - this.last) / 1000;
      this.last = now;
      for (const fn of this.subs) fn(now * 0.001, dt);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  stop() { this.running = false; }
}
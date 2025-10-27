import type { Tickable } from "./interfaces";

export class FrameLoop {
  private subs: Array<[Tickable, priority: number]> = []
  private last = performance.now();
  private running = false;

  add(t: Tickable, priority = 50) {
    this.subs.push([t, priority])
    this.subs.sort((a,b)=> a[1] - b[1]);
  }
  remove(fn: Tickable) { 
    const index = this.subs.findIndex(([f])=> f == fn)
    if(index > 0)
      this.subs.splice(index, 1);
  }


  start() {
    if (this.running) 
      return;
    this.running = true;
    const step = () => {
      if (!this.running) return;
      const now = performance.now();
      const dt = (now - this.last) / 1000;
      this.last = now;
      for (const [fn] of this.subs)
        fn(now * 0.001, dt);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  stop() { this.running = false; }
}
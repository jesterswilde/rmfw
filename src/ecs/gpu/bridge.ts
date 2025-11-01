// src/ecs/gpu/bridge.ts
// GPU Bridge registry & sync loop (channels are now in separate files)

import type { World } from "../core/index";
import type { BaseChannel, BindLayoutSpec } from "./baseChannel.js";

type Key = string;
const keyOf = (g: number, b: number) => `${g}:${b}`;

export type ChannelRegistration = {
  group: number;
  binding: number;
  channel: BaseChannel;
  argsProvider: (world: World) => any;
};

export class GpuBridge {
  private map = new Map<Key, ChannelRegistration>();

  register(reg: ChannelRegistration) {
    const k = keyOf(reg.group, reg.binding);
    if (this.map.has(k)) throw new Error(`GpuBridge.register: (${k}) already registered`);
    this.map.set(k, reg);
  }

  unregister(where: { group: number; binding: number }, destroyBuffer = true) {
    const k = keyOf(where.group, where.binding);
    const reg = this.map.get(k);
    if (!reg) return;
    if (destroyBuffer) {
      const buf = (reg.channel as any).buffer as GPUBuffer | null;
      if (buf) buf.destroy();
    }
    this.map.delete(k);
  }

  destroy() {
    for (const reg of this.map.values()) {
      const buf = (reg.channel as any).buffer as GPUBuffer | null;
      if (buf) buf.destroy();
    }
    this.map.clear();
  }

  layoutEntriesFor(group: number): GPUBindGroupLayoutEntry[] {
    const out: { binding: number; entry: BindLayoutSpec }[] = [];
    for (const r of this.map.values()) {
      if (r.group !== group) continue;
      out.push({ binding: r.binding, entry: r.channel.layoutEntry(r.binding) });
    }
    out.sort((a, b) => a.binding - b.binding);
    return out.map(x => ({ ...x.entry }));
  }

  bindGroupEntriesFor(group: number): GPUBindGroupEntry[] {
    const out: { binding: number; entry: GPUBindGroupEntry }[] = [];
    for (const r of this.map.values()) {
      if (r.group !== group) continue;
      const buffer = (r.channel as any).buffer as GPUBuffer | null;
      if (!buffer) throw new Error(`GpuBridge.bindGroupEntriesFor: buffer missing at binding ${r.binding}`);
      out.push({ binding: r.binding, entry: { binding: r.binding, resource: { buffer } } });
    }
    out.sort((a, b) => a.binding - b.binding);
    return out.map(x => x.entry);
  }

  /** One pass per channel: sync → (re)size buffer (marks full dirty if recreated) → flush if anything dirty. */
  syncAll(world: World, device: GPUDevice, queue: GPUQueue) {
    for (const r of this.map.values()) {
      const changed = r.channel.sync(world, r.argsProvider(world));
      const recreated = r.channel.createOrResize(device); // marks full dirty when true
      if (changed || recreated) {
        r.channel.flush(queue);
      }
    }
  }
}

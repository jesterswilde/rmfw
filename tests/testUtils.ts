// tests/testUtils.ts
import { initWorld } from "../src/ecs/registry";
import type { World } from "../src/ecs/core";

export function makeWorld(cap = 64): World {
  return initWorld({ initialCapacity: cap });
}

export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

export function isTypedArray(x: any): boolean {
  return ArrayBuffer.isView(x) && !(x instanceof DataView);
}

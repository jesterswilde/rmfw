// tests/ecs/gpu/baseChannel.extra.test.ts
import { installWebGPUShims, MockQueue, makeMockDevice } from "../../utils/webgpu.mock.js";
import { BaseChannel, BYTES_PER_F32 } from "../../../src/ecs/gpu/baseChannel.js";

installWebGPUShims();

const ROW_BYTES = 6 * BYTES_PER_F32; // 6 f32 per row for this test channel

class TestChannel extends BaseChannel {
  constructor() {
    super();
    // start empty
  }

  /** Manually size the CPU buffer to N rows and write simple ascending data per row. */
  setRows(n: number) {
    this.ensureCpu(n, ROW_BYTES);
    // fill f32 with deterministic pattern: row r has 6 floats: [r, r+0.1, ...]
    for (let r = 0; r < n; r++) {
      const base = r * 6;
      this.f32[base + 0] = r;
      this.f32[base + 1] = r + 0.1;
      this.f32[base + 2] = r + 0.2;
      this.f32[base + 3] = r + 0.3;
      this.f32[base + 4] = r + 0.4;
      this.f32[base + 5] = r + 0.5;
    }
  }

  /** Expose protected helpers for testing. */
  dirty(row: number) { (this as any).markRowDirty(row); }
  dirtyAll() { (this as any).markAllDirty(); }

  // Abstract requirement: do nothing (caller uses setRows/dirty directly)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sync(_world: any, _args: any): boolean { return false; }
}

describe("BaseChannel – layout + dirty range behavior", () => {
  it("layoutEntry defaults to read-only storage + COMPUTE visibility", () => {
    const chan = new TestChannel();
    const entry = chan.layoutEntry(3);
    expect(entry.binding).toBe(3);
    expect(entry.visibility).toBe((globalThis as any).GPUShaderStage.COMPUTE);
    expect(entry.buffer!.type).toBe("read-only-storage");
  });

  it("dirty coalescing: adjacent rows merge; non-adjacent stay separate", () => {
    const chan = new TestChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    chan.setRows(10);
    chan.createOrResize(dev);

    // IMPORTANT: createOrResize() marks the whole buffer dirty.
    // Flush once to clear the initial full-dirty state so we can test coalescing precisely.
    chan.flush(q);
    q.reset();

    // mark rows [2], [3], [7]
    chan.dirty(2);
    chan.dirty(3); // adjacent to 2 -> should merge into [2..3]
    chan.dirty(7); // disjoint

    chan.flush(q);
    // Expect two writes: [2..3] and [7..7]
    expect(q.writes.length).toBe(2);
    const w0 = q.writes[0]!;
    const w1 = q.writes[1]!;
    expect(w0.offset).toBe(2 * ROW_BYTES);
    expect(w0.size).toBe(2 * ROW_BYTES); // rows 2 and 3
    expect(w1.offset).toBe(7 * ROW_BYTES);
    expect(w1.size).toBe(1 * ROW_BYTES);
  });

  it("markAllDirty triggers one full-buffer write", () => {
    const chan = new TestChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    chan.setRows(5);
    chan.createOrResize(dev);
    (chan as any).markAllDirty();
    chan.flush(q);

    expect(q.writes.length).toBe(1);
    expect(q.writes[0]!.offset).toBe(0);
    expect(q.writes[0]!.size).toBe(5 * ROW_BYTES);
  });

  it("buffer recreation on growth forces full upload; CPU buffer doesn't shrink on row decrease", () => {
    const chan = new TestChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    chan.setRows(4);
    const cpuCapBefore = (chan as any).cpu.byteLength as number;
    chan.createOrResize(dev);
    chan.dirtyAll();
    chan.flush(q);
    expect(q.writes.length).toBe(1);
    q.reset();

    // Grow to 12 rows — must recreate GPU buffer and upload full
    chan.setRows(12);
    const recreated = chan.createOrResize(dev);
    expect(recreated).toBe(true);
    chan.flush(q);
    expect(q.writes.length).toBe(1);
    expect(q.writes[0]!.size).toBe(12 * ROW_BYTES);

    // Now decrease rows; CPU buffer should not shrink (capacity stays >=)
    const cpuCapAfterGrow = (chan as any).cpu.byteLength as number;
    chan.setRows(3);
    expect((chan as any).cpu.byteLength).toBe(cpuCapAfterGrow);
    // GPU buffer may be recreated to smaller size; that's allowed.
    expect(cpuCapAfterGrow).toBeGreaterThanOrEqual(cpuCapBefore);
  });

  it("zero-sized safety: 0 rows produces no writes and no errors", () => {
    const chan = new TestChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    chan.setRows(0);
    chan.createOrResize(dev); // should create a small (>=4 bytes) buffer
    chan.flush(q);
    expect(q.writes.length).toBe(0);
  });

  it("shared buffer views allow i32/f32 bitcast-style access", () => {
    const chan = new TestChannel();
    const q = new MockQueue();
    const dev = makeMockDevice(q);

    chan.setRows(1);
    chan.createOrResize(dev);

    // Write via i32 and read back through a new typed view over the same buffer
    ((chan as unknown) as { i32: Int32Array }).i32[0] = 0x3f800000; // bit pattern for 1.0f
    const f32Again = new Float32Array(((chan as any).cpu as ArrayBuffer));
    expect(f32Again[0]).toBe(1); // confirms shared buffer & endianness behavior
  });
});

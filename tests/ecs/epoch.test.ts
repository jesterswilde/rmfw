// tests/epochs.test.ts
import { initWorld } from "../../src/ecs/core/registry";

describe("Epochs (Phase 1 semantics)", () => {
  test("storeEpoch increments on add/update/remove; rowVersion increments per-row", () => {
    const world = initWorld({ initialCapacity: 8 });
    const T = world.store<any>("Transform");

    const epoch0 = T.storeEpoch;
    const e = world.createEntity();
    const row = T.add(e, { local_tx: 5 });
    expect(T.storeEpoch).toBe(epoch0 + 1);
    const rv0 = T.rowVersion[row];

    const epoch1 = T.storeEpoch;
    T.update(e, { local_tx: 6, local_ty: 7 });
    expect(T.storeEpoch).toBe(epoch1 + 1);
    expect(T.rowVersion[row]).toBe(rv0 + 1);

    const epoch2 = T.storeEpoch;
    T.remove(e);
    expect(T.storeEpoch).toBe(epoch2 + 1);
  });

  test("entityEpoch does not change on component mutations in phase 1; only on destroy", () => {
    const world = initWorld({ initialCapacity: 8 });
    const T = world.store<any>("Transform");

    const e = world.createEntity();
    const before = world.entityEpoch[e]!;
    T.add(e, { local_tx: 1 });
    T.update(e, { local_tx: 2 });
    expect(world.entityEpoch[e]).toBe(before); // unchanged in Phase 1

    world.destroyEntitySafe(e);
    expect(world.entityEpoch[e]).toBe((before + 1) >>> 0);
  });
});

import { World, NONE } from "../core/index.js";
import { isOrthonormal3x3, inverseRigid3x4_into, inverseGeneral3x4_into, mulRigid3x4_into } from "../math.js";
import { TransformMeta } from "../registry.js";
import { appendChildAtEnd, Tree, detachFromParent, isAncestor, nodeColumns } from "./tree.js";

/** Transform-aware tree: preserves world space when reparenting. */
export class TransformTree extends Tree {
  constructor(
    world: World,
    nodeMeta: Readonly<{ name: string; fields: readonly any[] }>,
    rootTransformData: Record<string, number>
  ) {
    super(world, TransformMeta, nodeMeta, rootTransformData);
  }

  /** Override: reparent preserving world transform. */
  override setParent(entity: number, parent: number) {
    const e = entity | 0;
    const p = parent === NONE ? this.rootEntity : (parent | 0);
    if (e === this.rootEntity) throw new Error("Cannot reparent the root");
    this.assertMember(e);
    if (p !== this.rootEntity && !this.nodeStore.has(p))
      throw new Error(`Parent ${p} is not a member of ${this.componentName}`);
    if (isAncestor(this.nodeStore, e, p))
      throw new Error("Cannot set parent: target parent is a descendant of the entity");

    // Compute local' = inv(parentWorld_new) * world_current (if Transform exists).
    const T = this.world.storeOf(TransformMeta);
    const tf = T.fields();

    // Parent world (identity if no Transform)
    let pr00 = 1, pr01 = 0, pr02 = 0, ptx = 0;
    let pr10 = 0, pr11 = 1, pr12 = 0, pty = 0;
    let pr20 = 0, pr21 = 0, pr22 = 1, ptz = 0;

    const parentTRow = T.denseIndexOf(p);
    if (parentTRow >= 0) {
      pr00 = tf.world_r00[parentTRow]!;
      pr01 = tf.world_r01[parentTRow]!;
      pr02 = tf.world_r02[parentTRow]!;
      ptx  = tf.world_tx[parentTRow]!;
      pr10 = tf.world_r10[parentTRow]!;
      pr11 = tf.world_r11[parentTRow]!;
      pr12 = tf.world_r12[parentTRow]!;
      pty  = tf.world_ty[parentTRow]!;
      pr20 = tf.world_r20[parentTRow]!;
      pr21 = tf.world_r21[parentTRow]!;
      pr22 = tf.world_r22[parentTRow]!;
      ptz  = tf.world_tz[parentTRow]!;
    }

    const invParent = new Float32Array(12);
    if (isOrthonormal3x3(pr00, pr01, pr02, pr10, pr11, pr12, pr20, pr21, pr22)) {
      inverseRigid3x4_into(
        pr00, pr01, pr02, ptx,
        pr10, pr11, pr12, pty,
        pr20, pr21, pr22, ptz,
        invParent
      );
    } else {
      inverseGeneral3x4_into(
        pr00, pr01, pr02, ptx,
        pr10, pr11, pr12, pty,
        pr20, pr21, pr22, ptz,
        invParent
      );
    }

    const eTRow = T.denseIndexOf(e);
    if (eTRow >= 0) {
      const wr00 = tf.world_r00[eTRow]!, wr01 = tf.world_r01[eTRow]!, wr02 = tf.world_r02[eTRow]!, wtx = tf.world_tx[eTRow]!;
      const wr10 = tf.world_r10[eTRow]!, wr11 = tf.world_r11[eTRow]!, wr12 = tf.world_r12[eTRow]!, wty = tf.world_ty[eTRow]!;
      const wr20 = tf.world_r20[eTRow]!, wr21 = tf.world_r21[eTRow]!, wr22 = tf.world_r22[eTRow]!, wtz = tf.world_tz[eTRow]!;

      const localPrime = new Float32Array(12);
      mulRigid3x4_into(
        invParent[0]!, invParent[1]!, invParent[2]!, invParent[3]!,
        invParent[4]!, invParent[5]!, invParent[6]!, invParent[7]!,
        invParent[8]!, invParent[9]!, invParent[10]!, invParent[11]!,
        wr00, wr01, wr02, wtx,
        wr10, wr11, wr12, wty,
        wr20, wr21, wr22, wtz,
        localPrime
      );

      tf.local_r00[eTRow] = localPrime[0]!;
      tf.local_r01[eTRow] = localPrime[1]!;
      tf.local_r02[eTRow] = localPrime[2]!;
      tf.local_tx[eTRow]  = localPrime[3]!;
      tf.local_r10[eTRow] = localPrime[4]!;
      tf.local_r11[eTRow] = localPrime[5]!;
      tf.local_r12[eTRow] = localPrime[6]!;
      tf.local_ty[eTRow]  = localPrime[7]!;
      tf.local_r20[eTRow] = localPrime[8]!;
      tf.local_r21[eTRow] = localPrime[9]!;
      tf.local_r22[eTRow] = localPrime[10]!;
      tf.local_tz[eTRow]  = localPrime[11]!;
      (tf as any).dirty[eTRow] = 1;
    }

    // Structural link change.
    detachFromParent(this.nodeStore, e);
    appendChildAtEnd(this.nodeStore, p, e);

    this.bump(e);
    this.rebuildOrder();
  }

  /** Override remove: bulk-move children under root while preserving each child’s world. */
  override remove(entity: number) {
    const e = entity | 0;
    if (e === this.rootEntity) throw new Error("Cannot remove the root");
    this.assertMember(e);

    // Snapshot children first because setParent(child, root) will rewrite links.
    const cols = nodeColumns(this.nodeStore);
    const eRow = this.nodeStore.denseIndexOf(e)!;
    const kids: number[] = [];
    {
      let cur = cols.firstChild[eRow]! | 0;
      for (let guard = 0; guard < this.nodeStore.size && cur !== NONE; guard++) {
        kids.push(cur);
        const cRow = this.nodeStore.denseIndexOf(cur);
        if (cRow < 0) break;
        cur = cols.nextSibling[cRow]! | 0;
      }
    }

    // Detach e from its parent structurally.
    detachFromParent(this.nodeStore, e);

    // Reparent children to root while preserving their world transforms.
    for (let i = 0; i < kids.length; i++) {
      this.setParent(kids[i]!, this.rootEntity);
    }

    // Finally delete the entity from the world (no tree detaches needed here).
    this.world.destroyEntitySafe(e, /*removeFromTrees*/ false);

    this.bump();
    this.rebuildOrder();
  }
}
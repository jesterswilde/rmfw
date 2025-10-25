// bench.ts
//npx tsc bench.ts --target ES2020 --module commonjs
//node --expose-gc bench.js --n=1000000 --bf=4 --trials=8
/* eslint-disable no-console */
// ---------- CLI ----------
const arg = (name, def) => {
    const v = process.argv.find(a => a.startsWith(`--${name}=`));
    return v ? Number(v.split("=")[1]) : def;
};
const N = arg("n", 300000); // total nodes
const MAX_CHILDREN = arg("bf", 4); // max children per parent
const TRIALS = arg("trials", 6); // measured runs
const SEED = arg("seed", 1337); // seed for reproducibility
const TILE_BYTES = arg("tile", 4096); // tile size for Blocked DFS pack (bytes)
// ---------- constants ----------
const SENTINEL = -1;
const NODE_STACK_SIZE = 1 << 15; // initial stack cap; grows up to n if needed
const LANES = 4; // index, childIndex, siblingIndex, flags
const NODE_BYTES = LANES * 4; // 16 bytes
// ---------- timers / gc ----------
const isNode = typeof process !== "undefined";
const now = () => {
    if (isNode && process.hrtime?.bigint) {
        return Number(process.hrtime.bigint()) / 1e6;
    }
    return performance.now();
};
const doGC = () => globalThis.gc?.();
// ---------- PRNG ----------
function mulberry32(seed) {
    let t = seed >>> 0;
    return () => {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}
const toU32 = (x) => (x >>> 0);
// ---------- topology: firstChild / nextSibling ----------
function buildTopology(n, maxChildren, seed) {
    if (n <= 0)
        throw new Error("buildTopology: n must be > 0");
    if (maxChildren <= 0)
        throw new Error("buildTopology: bf must be > 0");
    const rand = mulberry32(seed);
    const firstChild = new Int32Array(n).fill(SENTINEL);
    const lastChild = new Int32Array(n).fill(SENTINEL);
    const nextSibling = new Int32Array(n).fill(SENTINEL);
    const childCount = new Int32Array(n).fill(0);
    const candidates = new Int32Array(n);
    let candLen = 0;
    candidates[candLen++] = 0;
    for (let i = 1; i < n; i++) {
        const pIdx = candidates[(rand() * candLen) | 0];
        if (firstChild[pIdx] === SENTINEL) {
            firstChild[pIdx] = i;
        }
        else {
            nextSibling[lastChild[pIdx]] = i;
        }
        lastChild[pIdx] = i;
        if (++childCount[pIdx] >= maxChildren) {
            // remove pIdx from candidates (swap remove)
            for (let k = 0; k < candLen; k++) {
                if (candidates[k] === pIdx) {
                    candidates[k] = candidates[--candLen];
                    break;
                }
            }
        }
        candidates[candLen++] = i;
    }
    return { firstChild, nextSibling };
}
// ---------- topology validation ----------
function validateTopology(n, topo) {
    const { firstChild, nextSibling } = topo;
    if (firstChild.length !== n || nextSibling.length !== n) {
        throw new Error(`validate: array sizes mismatch n=${n}`);
    }
    const seen = new Uint8Array(n);
    let visited = 0;
    const stack = new Int32Array(n);
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
        const i = stack[--sp];
        if (i < 0 || i >= n)
            throw new Error(`validate: out-of-bounds node index ${i}`);
        if (seen[i])
            continue;
        seen[i] = 1;
        visited++;
        // Walk this node's children via sibling chain; check bounds and simple loops
        let prev = -2;
        for (let c = firstChild[i], guard = 0; c !== SENTINEL; c = nextSibling[c]) {
            if (++guard > n)
                throw new Error(`validate: sibling chain cycle detected at parent ${i}`);
            if (c < 0 || c >= n)
                throw new Error(`validate: child OOB: parent ${i} -> ${c}`);
            if (c === prev)
                throw new Error(`validate: sibling self/loop at ${c}`);
            prev = c;
            stack[sp++] = c;
        }
    }
    if (visited !== n) {
        let firstMissing = -1;
        for (let i = 0; i < n; i++)
            if (!seen[i]) {
                firstMissing = i;
                break;
            }
        throw new Error(`validate: reachable=${visited}/${n}; example missing index=${firstMissing}`);
    }
}
// ---------- orders ----------
function orderDFS(n, topo) {
    const { firstChild, nextSibling } = topo;
    const order = new Int32Array(n);
    let k = 0;
    const stack = new Int32Array(n);
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
        const i = stack[--sp];
        order[k++] = i;
        // push children in reverse so first child comes out first
        const tmp = [];
        for (let c = firstChild[i]; c !== SENTINEL; c = nextSibling[c])
            tmp.push(c);
        for (let j = tmp.length - 1; j >= 0; j--)
            stack[sp++] = tmp[j];
    }
    if (k !== n)
        throw new Error(`orderDFS: produced ${k}/${n} nodes`);
    return order;
}
function orderBFS(n, topo) {
    // O(n) queue with head/tail indices (no Array.shift()).
    const { firstChild, nextSibling } = topo;
    const order = new Int32Array(n);
    let k = 0;
    const q = new Int32Array(n);
    let head = 0, tail = 0;
    q[tail++] = 0;
    while (head < tail) {
        const i = q[head++];
        order[k++] = i;
        for (let c = firstChild[i]; c !== SENTINEL; c = nextSibling[c])
            q[tail++] = c;
    }
    if (k !== n)
        throw new Error(`orderBFS: only enqueued ${k}/${n} nodes — topology might be disconnected`);
    return order;
}
// ---------- CSR builder (1) ----------
function buildCSR(n, topo) {
    const { firstChild, nextSibling } = topo;
    const degree = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        for (let c = firstChild[i]; c !== SENTINEL; c = nextSibling[c])
            degree[i]++;
    }
    const offsets = new Int32Array(n + 1);
    for (let i = 0; i < n; i++)
        offsets[i + 1] = offsets[i] + degree[i];
    const children = new Int32Array(offsets[n]);
    const fill = offsets.slice();
    for (let i = 0; i < n; i++) {
        for (let c = firstChild[i]; c !== SENTINEL; c = nextSibling[c]) {
            children[fill[i]++] = c;
        }
    }
    return { offsets, children, degree };
}
// ---------- subtree sizes on original indices ----------
function computeSubtreeSizes(n, topo) {
    const { firstChild, nextSibling } = topo;
    const sz = new Int32Array(n);
    // postorder via explicit stack
    const stack = new Int32Array(n);
    const iter = new Int8Array(n); // 0 = enter, 1 = exit
    let sp = 0;
    stack[sp] = 0;
    iter[sp++] = 0;
    while (sp) {
        const i = stack[sp - 1];
        if (iter[sp - 1] === 0) {
            iter[sp - 1] = 1;
            for (let c = firstChild[i]; c !== SENTINEL; c = nextSibling[c]) {
                stack[sp] = c;
                iter[sp++] = 0;
            }
        }
        else {
            // exit
            let s = 1;
            for (let c = firstChild[i]; c !== SENTINEL; c = nextSibling[c])
                s += sz[c];
            sz[i] = s;
            sp--;
        }
    }
    return sz;
}
// ---------- AoS builders ----------
function buildAoS(n, topo, seed) {
    const { firstChild, nextSibling } = topo;
    const rand = mulberry32(seed ^ 0xA1B2C3D4);
    const buffer = new ArrayBuffer(n * NODE_BYTES);
    const I32 = new Int32Array(buffer);
    const U32 = new Uint32Array(buffer);
    for (let i = 0; i < n; i++) {
        const b = i * LANES;
        I32[b + 0] = i;
        I32[b + 1] = firstChild[i];
        I32[b + 2] = nextSibling[i];
        U32[b + 3] = toU32((rand() * 0xffffffff) | 0); // flags inert
    }
    return { buffer, I32, U32 };
}
function buildAoSPacked(n, topo, seed, order) {
    const { firstChild, nextSibling } = topo;
    const newIdxOfOld = new Int32Array(n);
    for (let newI = 0; newI < n; newI++)
        newIdxOfOld[order[newI]] = newI;
    const buffer = new ArrayBuffer(n * NODE_BYTES);
    const I32 = new Int32Array(buffer);
    const U32 = new Uint32Array(buffer);
    const rand = mulberry32(seed ^ 0x12345678);
    for (let newI = 0; newI < n; newI++) {
        const oldI = order[newI];
        const base = newI * LANES;
        I32[base + 0] = newI;
        const oldFirst = firstChild[oldI];
        const oldNext = nextSibling[oldI];
        I32[base + 1] = oldFirst === SENTINEL ? SENTINEL : newIdxOfOld[oldFirst];
        I32[base + 2] = oldNext === SENTINEL ? SENTINEL : newIdxOfOld[oldNext];
        U32[base + 3] = toU32((rand() * 0xffffffff) | 0);
    }
    return { buffer, I32, U32 };
}
function buildPreorderCSRAndSubtree(n, topo, seed) {
    const order = orderDFS(n, topo);
    const newIdxOfOld = new Int32Array(n);
    for (let newI = 0; newI < n; newI++)
        newIdxOfOld[order[newI]] = newI;
    // headers in preorder (child/sib kept for parity but not used by traversal)
    const buffer = new ArrayBuffer(n * NODE_BYTES);
    const I32 = new Int32Array(buffer);
    const U32 = new Uint32Array(buffer);
    const rand = mulberry32(seed ^ 0x7777);
    const { firstChild, nextSibling } = topo;
    for (let newI = 0; newI < n; newI++) {
        const oldI = order[newI];
        const b = newI * LANES;
        I32[b + 0] = newI;
        const of = firstChild[oldI], os = nextSibling[oldI];
        I32[b + 1] = of === SENTINEL ? SENTINEL : newIdxOfOld[of];
        I32[b + 2] = os === SENTINEL ? SENTINEL : newIdxOfOld[os];
        U32[b + 3] = toU32((rand() * 0xffffffff) | 0);
    }
    // CSR using NEW indices
    const degree = new Int32Array(n);
    for (let oldP = 0; oldP < n; oldP++) {
        let d = 0;
        for (let c = topo.firstChild[oldP]; c !== SENTINEL; c = topo.nextSibling[c])
            d++;
        degree[newIdxOfOld[oldP]] = d;
    }
    const offsets = new Int32Array(n + 1);
    for (let i = 0; i < n; i++)
        offsets[i + 1] = offsets[i] + degree[i];
    const children = new Int32Array(offsets[n]);
    const fill = offsets.slice();
    for (let oldP = 0; oldP < n; oldP++) {
        const p = newIdxOfOld[oldP];
        for (let c = topo.firstChild[oldP]; c !== SENTINEL; c = topo.nextSibling[c]) {
            children[fill[p]++] = newIdxOfOld[c];
        }
    }
    // subtree sizes in NEW indices
    const oldSub = computeSubtreeSizes(n, topo);
    const subtree = new Int32Array(n);
    for (let newI = 0; newI < n; newI++) {
        const oldI = order[newI];
        subtree[newI] = oldSub[oldI];
    }
    return { I32, U32, order, csr: { offsets, children, degree }, subtree };
}
// ---------- (4) Blocked (tiled) DFS pack ----------
function buildBlockedDFSPack(n, topo, seed, tileBytes) {
    const order = orderDFS(n, topo); // start with preorder
    const nodesPerTile = Math.max(1, Math.floor(tileBytes / NODE_BYTES));
    const blockedOrder = new Int32Array(n);
    let k = 0;
    for (let t = 0; t < n; t += nodesPerTile) {
        const end = Math.min(n, t + nodesPerTile);
        for (let i = t; i < end; i++)
            blockedOrder[k++] = order[i];
    }
    return buildAoSPacked(n, topo, seed ^ 0xB10C, blockedOrder);
}
// ---------- Objects from AoS ----------
function buildObjectsFromAoS(I32, U32) {
    const n = I32.length / LANES;
    const nodes = new Array(n);
    for (let i = 0; i < n; i++) {
        const b = i * LANES;
        nodes[i] = {
            index: I32[b + 0],
            childIndex: I32[b + 1],
            siblingIndex: I32[b + 2],
            flags: U32[b + 3] >>> 0
        };
    }
    return nodes;
}
// ---------- DFS (no sibling pre-scan), with safety ----------
// NOTE: U32 is now correctly typed as Uint32Array
function dfsAoS_NoGate(I32, U32, rootIdx) {
    const n = I32.length / LANES;
    let checksum = 0 >>> 0;
    let visited = 0;
    let stack = new Int32Array(Math.max(4, Math.min(NODE_STACK_SIZE, n)));
    let sp = 0;
    const push = (v) => {
        if (v !== SENTINEL) {
            if (v < 0 || v >= n)
                throw new Error(`dfsAoS: pushed OOB index ${v}`);
            if (sp >= stack.length) {
                if (stack.length >= n)
                    throw new Error(`dfsAoS: stack growth would exceed n=${n}`);
                const grow = new Int32Array(Math.min(stack.length << 1, n));
                grow.set(stack);
                stack = grow;
            }
            stack[sp++] = v;
        }
    };
    let i = rootIdx;
    if (i < 0 || i >= n)
        throw new Error(`dfsAoS: root OOB ${i}`);
    let iters = 0;
    const ITER_CAP = 2 * n;
    while (true) {
        if (++iters > ITER_CAP)
            throw new Error(`dfsAoS: iteration cap exceeded (${iters} > ${ITER_CAP})`);
        const b = i * LANES;
        const idx = I32[b + 0];
        const child = I32[b + 1];
        const sib = I32[b + 2];
        const flags = U32[b + 3];
        if (child !== SENTINEL && (child < 0 || child >= n))
            throw new Error(`dfsAoS: child OOB at ${i} -> ${child}`);
        if (sib !== SENTINEL && (sib < 0 || sib >= n))
            throw new Error(`dfsAoS: sibling OOB at ${i} -> ${sib}`);
        checksum = toU32(checksum + ((idx ^ child ^ sib ^ flags) >>> 0));
        visited++;
        if (child !== SENTINEL) {
            if (sib !== SENTINEL)
                push(sib);
            i = child;
            continue;
        }
        if (sib !== SENTINEL) {
            i = sib;
            continue;
        }
        if (sp === 0)
            break;
        i = stack[--sp];
    }
    return { checksum, visited };
}
function dfsObj_NoGate(nodes, rootIdx) {
    const n = nodes.length;
    let checksum = 0 >>> 0;
    let visited = 0;
    let stack = new Int32Array(Math.max(4, Math.min(NODE_STACK_SIZE, n)));
    let sp = 0;
    const push = (v) => {
        if (v !== SENTINEL) {
            if (v < 0 || v >= n)
                throw new Error(`dfsObj: pushed OOB index ${v}`);
            if (sp >= stack.length) {
                if (stack.length >= n)
                    throw new Error(`dfsObj: stack growth would exceed n=${n}`);
                const grow = new Int32Array(Math.min(stack.length << 1, n));
                grow.set(stack);
                stack = grow;
            }
            stack[sp++] = v;
        }
    };
    let i = rootIdx;
    if (i < 0 || i >= n)
        throw new Error(`dfsObj: root OOB ${i}`);
    let iters = 0;
    const ITER_CAP = 2 * n;
    while (true) {
        if (++iters > ITER_CAP)
            throw new Error(`dfsObj: iteration cap exceeded (${iters} > ${ITER_CAP})`);
        const node = nodes[i];
        const child = node.childIndex;
        const sib = node.siblingIndex;
        if (child !== SENTINEL && (child < 0 || child >= n))
            throw new Error(`dfsObj: child OOB at ${i} -> ${child}`);
        if (sib !== SENTINEL && (sib < 0 || sib >= n))
            throw new Error(`dfsObj: sibling OOB at ${i} -> ${sib}`);
        checksum = toU32(checksum + ((node.index ^ node.childIndex ^ node.siblingIndex ^ node.flags) >>> 0));
        visited++;
        if (child !== SENTINEL) {
            if (sib !== SENTINEL)
                push(sib);
            i = child;
            continue;
        }
        if (sib !== SENTINEL) {
            i = sib;
            continue;
        }
        if (sp === 0)
            break;
        i = stack[--sp];
    }
    return { checksum, visited };
}
// ---------- (1) DFS with CSR children ----------
// Visit a node only on FIRST arrival (cur === offsets[i]); when we pop back,
// we resume scanning its children without counting it again.
function dfsCSR(I32, U32, csr, root = 0) {
    const n = I32.length / LANES;
    let checksum = 0 >>> 0, visited = 0;
    // stack holds [node, nextChildCursor]
    let stackNode = new Int32Array(Math.max(4, Math.min(NODE_STACK_SIZE, n)));
    let stackCur = new Int32Array(stackNode.length);
    let sp = 0;
    const push = (node, cur) => {
        if (sp >= stackNode.length) {
            if (stackNode.length >= n)
                throw new Error(`dfsCSR: stack growth would exceed n=${n}`);
            const growN = new Int32Array(Math.min(stackNode.length << 1, n));
            const growC = new Int32Array(growN.length);
            growN.set(stackNode);
            growC.set(stackCur);
            stackNode = growN;
            stackCur = growC;
        }
        stackNode[sp] = node;
        stackCur[sp] = cur;
        sp++;
    };
    let i = root;
    let cur = csr.offsets[i]; // cursor into children[i..)
    let iters = 0;
    const ITER_CAP = 2 * n + csr.children.length; // generous guard
    while (true) {
        if (++iters > ITER_CAP)
            throw new Error(`dfsCSR: iteration cap exceeded (${iters} > ${ITER_CAP})`);
        // Only visit on first arrival for this node
        if (cur === csr.offsets[i]) {
            const b = i * LANES;
            checksum = (checksum + ((I32[b] ^ I32[b + 1] ^ I32[b + 2] ^ U32[b + 3]) >>> 0)) >>> 0;
            visited++;
        }
        const end = csr.offsets[i + 1];
        if (cur < end) {
            // Defer the rest of this node's children and descend to the next child
            const nextCur = cur + 1;
            const child = csr.children[cur];
            push(i, nextCur);
            i = child;
            cur = csr.offsets[i];
            continue;
        }
        // No more children: pop a deferred parent state
        if (sp === 0)
            break;
        sp--;
        i = stackNode[sp];
        cur = stackCur[sp];
    }
    return { checksum, visited };
}
// ---------- (2) Preorder+subtreeSize traversal (uses CSR ranges; link-free headers) ----------
function dfsPreorderCSR(I32, U32, csr, _subtree, root = 0) {
    // subtree is ready for future “skip subtree” features; traversal matches dfsCSR.
    return dfsCSR(I32, U32, csr, root);
}
// ---------- harness ----------
function median(xs) {
    const a = xs.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function bench(label, fn, trials) {
    // warmup
    fn();
    fn();
    const times = [];
    let lastVisited = 0;
    let lastChecksum = 0;
    for (let i = 0; i < trials; i++) {
        doGC();
        const t0 = now();
        const r = fn();
        const t1 = now();
        times.push(t1 - t0);
        lastVisited = r.visited;
        lastChecksum = r.checksum;
        if (typeof r.checksum !== "number" || typeof r.visited !== "number") {
            throw new Error(`bench(${label}): invalid result: ${JSON.stringify(r)}`);
        }
    }
    const med = median(times);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    return { label, min, med, avg, max, times, visited: lastVisited, checksum: lastChecksum };
}
const nsPerVisited = (ms, visited) => (ms * 1e6) / Math.max(1, visited);
// ---------- run ----------
(async function main() {
    try {
        console.log(`Nodes: ${N.toLocaleString()} | max children: ${MAX_CHILDREN} | trials: ${TRIALS} | seed: ${SEED} | tile=${TILE_BYTES}B`);
        const topo = buildTopology(N, MAX_CHILDREN, SEED);
        validateTopology(N, topo); // catch bad structures early
        // Baseline orders and packs
        const ordDFS = orderDFS(N, topo);
        const ordBFS = orderBFS(N, topo);
        const aosLinear = buildAoS(N, topo, SEED ^ 0x1111);
        const aosDFS = buildAoSPacked(N, topo, SEED ^ 0x2222, ordDFS);
        const aosBFS = buildAoSPacked(N, topo, SEED ^ 0x3333, ordBFS);
        const aosBlk = buildBlockedDFSPack(N, topo, SEED ^ 0x4444, TILE_BYTES);
        // Object mirror from linear AoS
        const obj = buildObjectsFromAoS(aosLinear.I32, aosLinear.U32);
        // (1) CSR over original indexing
        const csrOrig = buildCSR(N, topo);
        // (2) Preorder + CSR + subtreeSize (link-free header traversal)
        const pre = buildPreorderCSRAndSubtree(N, topo, SEED ^ 0x7777);
        // quick correctness on AoS vs Obj and CSR
        const checkA = dfsAoS_NoGate(aosLinear.I32, aosLinear.U32, 0);
        const checkB = dfsObj_NoGate(obj, 0);
        const checkC = dfsCSR(aosLinear.I32, aosLinear.U32, csrOrig, 0);
        const checkD = dfsPreorderCSR(pre.I32, pre.U32, pre.csr, pre.subtree, 0);
        if (checkA.visited !== N || checkB.visited !== N || checkC.visited !== N || checkD.visited !== N) {
            throw new Error(`Warm check failed: visited AoS=${checkA.visited}, Obj=${checkB.visited}, CSR=${checkC.visited}, Pre=${checkD.visited}, expected=${N}`);
        }
        console.log(`Warm check: visited=${N}, checksum(aos)=${checkA.checksum}, checksum(obj)=${checkB.checksum}, checksum(csr)=${checkC.checksum}, checksum(pre)=${checkD.checksum}`);
        const tests = [
            // Existing AoS/Object
            bench("AoS (linear, DFS no-scan)", () => dfsAoS_NoGate(aosLinear.I32, aosLinear.U32, 0), TRIALS),
            bench("AoS (DFS-packed, DFS no-scan)", () => dfsAoS_NoGate(aosDFS.I32, aosDFS.U32, 0), TRIALS),
            bench("AoS (BFS-packed, DFS no-scan)", () => dfsAoS_NoGate(aosBFS.I32, aosBFS.U32, 0), TRIALS),
            bench("AoS (Blocked DFS pack, DFS no-scan)", () => dfsAoS_NoGate(aosBlk.I32, aosBlk.U32, 0), TRIALS),
            bench("Object (DFS no-scan)", () => dfsObj_NoGate(obj, 0), TRIALS),
            // New methods
            bench("CSR (children array, offsets)", () => dfsCSR(aosLinear.I32, aosLinear.U32, csrOrig, 0), TRIALS),
            bench("Preorder+Subtree (link-free headers, CSR children)", () => dfsPreorderCSR(pre.I32, pre.U32, pre.csr, pre.subtree, 0), TRIALS),
        ];
        for (const b of tests) {
            console.log(`\n${b.label}\n` +
                `  min=${b.min.toFixed(3)} ms  med=${b.med.toFixed(3)} ms  avg=${b.avg.toFixed(3)} ms  max=${b.max.toFixed(3)} ms\n` +
                `  med ~ ${nsPerVisited(b.med, b.visited).toFixed(1)} ns/visited-node  (visited=${b.visited.toLocaleString()})`);
        }
    }
    catch (err) {
        console.error("\n❌ Benchmark aborted with error:");
        console.error(err?.stack || err?.message || err);
        process.exit(1);
    }
})();

// ============================================================================
// Compute raymarcher tracer
// Output: storage texture, 2D dispatch
// Groups:
//   @group(0): outImage (storage texture)
//   @group(1): per-view uniforms (resolution, time, numShapes, cameraMatrix)
//   @group(2): scene data buffers (shapes, nodes, transforms)
// ============================================================================

@group(0) @binding(0) var outImage : texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(0) var<uniform> frame : FramePacked;
@group(2) @binding(0) var<storage, read> shapes: array<PackedShape>;
@group(2) @binding(1) var<storage, read> nodes: array<Node>;
@group(2) @binding(2) var<storage, read> transforms: array<Transform3x4>;

// --- Uniforms (per-view) ----------------------------------------------------
// --- Per-view uniforms: vec4-only, column-major camera ----------------------
struct FramePacked {
  u0 : vec4<u32>,  // x = res.x, y = res.y, z = numShapes, w = flags/unused
  f0 : vec4<f32>,  // x = time, yzw = unused
  c0 : vec4<f32>,  // camera column 0 (right)
  c1 : vec4<f32>,  // camera column 1 (up)
  c2 : vec4<f32>,  // camera column 2 (forward)
  c3 : vec4<f32>  // camera column 3 (position)
};
fn frameRes() -> vec2<u32> { return frame.u0.xy; }
fn frameNumShapes() -> u32  { return frame.u0.z; }
fn frameTime() -> f32       { return frame.f0.x; }
fn frameCamera() -> mat4x4<f32> { return mat4x4<f32>(frame.c0, frame.c1, frame.c2, frame.c3); }

// --- Scene data --------------------------------------------------------------
struct PackedShape {
  header: vec4<i32>, // type | xformID | material | flags
  v0: vec4<f32>,
  v1: vec4<f32>
};

struct Node {
  index: i32,
  childIndex: i32,
  siblingIndex: i32,
  flags: u32
};

struct Transform3x4 {
  row0: vec4<f32>,
  row1: vec4<f32>,
  row2: vec4<f32>
};

struct IndexValue { index: i32, value: f32, isPositive: i32 }
struct GateValue { evaluateChildren: bool, value: f32 }
struct Ray { origin: vec3<f32>, direction: vec3<f32> }

// ---------------------------------------------------------------------------

const PI = 3.141592653589793;
const EPS = 0.001;

const NODE_STACK_SIZE = 16;
const MAX_CHILD_SIZE  = 32;
const NODE_HAS_GATE   = 1u << 0u;

const SHAPE_TYPE_SPHERE = 1u;
const SHAPE_TYPE_BOX    = 2u;

const OP_UNION               = 20u;
const OP_SIMPLE_UNION        = 21u;
const OP_SIMPLE_SUBTRACT     = 22u;
const OP_SIMPLE_INTERSECTION = 23u;

const GATE_BOX = 40u;

// --- SDF helpers -------------------------------------------------------------
fn sdSphere(p: vec3f, s: f32) -> f32 { return length(p)-s; }

fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn boxGate(p: vec3f, b: vec3f) -> GateValue {
  let pad = 0.08 * max(b.x, max(b.y, b.z));
  let dist = sdBox(p, b);
  if (dist > pad) { return GateValue(true, dist - pad); }
  return GateValue(false, -1.0);
}

fn simpleUnion(a: IndexValue, b: IndexValue) -> IndexValue {
  var r = a;
  if (b.value < a.value) { r = b; }
  return r;
}

fn simpleSubtract(a: IndexValue, b: IndexValue) -> IndexValue {
  var r = b;
  if (-a.value > b.value) { 
    r = a; 
    r.value = -r.value;
    r.isPositive = 0;
  }
  return r;
}

fn simpleIntersection(a: IndexValue, b: IndexValue) -> IndexValue {
  var r = a;
  if (b.value > a.value) { r = b; }
  return r;
}

fn reduceUnion(values: ptr<function, array<IndexValue, MAX_CHILD_SIZE>>, topIndex: i32, count: u32) -> IndexValue {
  var i = topIndex;
  var best = (*values)[i];
  var remaining = count - 1u;
  while (remaining > 0u) {
    i -= 1;
    let iv = (*values)[i];
    if (iv.value < best.value) { best = iv; }
    remaining -= 1u;
  }
  return best;
}

fn radians(deg: f32) -> f32 { return deg * PI / 180.0; }

fn xformPoint(p: vec3<f32>, invM: Transform3x4) -> vec3<f32> {
  return vec3(
    dot(invM.row0.xyz, p) + invM.row0.w,
    dot(invM.row1.xyz, p) + invM.row1.w,
    dot(invM.row2.xyz, p) + invM.row2.w
  );
}

fn cameraRay(u: f32, v: f32, fov_y_deg: f32) -> Ray {
  let ndc = vec2<f32>(u * 2.0 - 1.0, 1.0 - v * 2.0);
  let fov_y = radians(fov_y_deg);
  let tanHalf = tan(0.5 * fov_y);
  let res = frameRes();
  let aspect = f32(res.x) / f32(res.y);

  var d_cam = vec3<f32>(ndc.x * aspect * tanHalf, ndc.y * tanHalf, 1.0);
  d_cam = normalize(d_cam);

  // --- Hardcoded camera ---
  let camPos = vec3<f32>(0.0, 0.0, -5.0);
  let camForward = vec3<f32>(0.0, 0.0, 1.0);
  let camRight   = vec3<f32>(1.0, 0.0, 0.0);
  let camUp      = vec3<f32>(0.0, 1.0, 0.0);

  let dir_world = normalize(d_cam.x * camRight + d_cam.y * camUp + d_cam.z * camForward);
  return Ray(camPos, dir_world);
}

// --- Camera ------------------------------------------------------------------
//fn cameraRay(u: f32, v: f32, fov_y_deg: f32) -> Ray {
//  let ndc = vec2<f32>(u * 2.0 - 1.0, 1.0 - v * 2.0);
//  let fov_y = radians(fov_y_deg);
//  let tanHalf = tan(0.5 * fov_y);
//  let res = frameRes();
//  let aspect = f32(res.x) / f32(res.y);
//
//  var d_cam = vec3<f32>(ndc.x * aspect * tanHalf, ndc.y * tanHalf, 1.0);
//  d_cam = normalize(d_cam);
//
//  let camRight   = frame.c0.xyz;
//  let camUp      = frame.c1.xyz;
//  let camForward = frame.c2.xyz;
//  let camPos     = frame.c3.xyz;
//
//  let dir_world = normalize(d_cam.x * camRight + d_cam.y * camUp + d_cam.z * camForward);
//  return Ray(camPos, dir_world);
//}

// ============================================================================
// Node traversal SDF (kept for later)
// ============================================================================
fn evaluateLeafNode(p: vec3<f32>, node: Node) -> IndexValue {
  let i = node.index;
  var value = 10000.0;
  let shape = shapes[i];
  let xform = transforms[shape.header.y]; // header.y == xformID

  if (u32(shape.header.x) == SHAPE_TYPE_SPHERE) {
    value = sdSphere(xformPoint(p, xform), shape.v0.x);
  } else if (u32(shape.header.x) == SHAPE_TYPE_BOX) {
    value = sdBox(xformPoint(p, xform), shape.v0.xyz);
  }
  return IndexValue(i, value, 1);
}

fn evaluateParentNode(
  p: vec3<f32>,
  node: Node,
  valueStack: ptr<function, array<IndexValue, MAX_CHILD_SIZE>>,
  valuesIPtr: ptr<function, i32>
) {
  var valuesI = *valuesIPtr;
  let shape = shapes[node.index];
  var iv = IndexValue(-1, 0.0, 1);

  if (u32(shape.header.x) == OP_UNION) {
    iv = reduceUnion(valueStack, valuesI, u32(shape.v0.x));
    valuesI -= i32(shape.v0.x) + 1;
  } else if (u32(shape.header.x) == OP_SIMPLE_UNION) {
    iv = simpleUnion((*valueStack)[valuesI], (*valueStack)[valuesI - 1]);
    valuesI -= 1;
  } else if (u32(shape.header.x) == OP_SIMPLE_SUBTRACT) {
    iv = simpleSubtract((*valueStack)[valuesI], (*valueStack)[valuesI - 1]);
    valuesI -= 1;
  } else if (u32(shape.header.x) == OP_SIMPLE_INTERSECTION) {
    iv = simpleIntersection((*valueStack)[valuesI], (*valueStack)[valuesI - 1]);
    valuesI -= 1;
  }

  *valuesIPtr = valuesI;
  (*valueStack)[valuesI] = iv;
}

fn traverseNodes(p: vec3<f32>, rootNode: Node) -> IndexValue {
  var stack: array<Node, NODE_STACK_SIZE>;
  var stackI: i32 = 0;
  var values: array<IndexValue, MAX_CHILD_SIZE>;
  var valuesI: i32 = -1;
  var isPopping: bool = false;

  stack[stackI] = rootNode;

  loop {
    if (stackI < 0) { break; }

    var node = stack[stackI];

    // Leaf
    if (node.childIndex == -1) {
      let iv = evaluateLeafNode(p, node);
      valuesI += 1;
      values[valuesI] = iv;

      if (node.siblingIndex != -1) {
        stack[stackI] = nodes[node.siblingIndex];
        isPopping = false;
      } else {
        isPopping = true;
        stackI -= 1;
      }
      continue;
    }

    // First time entering a node
    if (!isPopping) {
      let isGate = (node.flags & NODE_HAS_GATE) > 0u;
      if (isGate) {
        let shape = shapes[node.index];
        let gateValue = boxGate(p, shape.v0.xyz);
        if (!gateValue.evaluateChildren) {
          valuesI += 1;
          values[valuesI] = IndexValue(node.index, gateValue.value, 1);
          if (node.siblingIndex != -1) {
            stack[stackI] = nodes[node.siblingIndex];
            isPopping = false;
          } else {
            isPopping = true;
            stackI -= 1;
          }
          continue;
        }
      }
      stackI += 1;
      stack[stackI] = nodes[node.childIndex];
      continue;
    }

    // Leaving a node: reduce children into parent
    evaluateParentNode(p, node, &values, &valuesI);
    if (node.siblingIndex != -1) {
      stack[stackI] = nodes[node.siblingIndex];
      isPopping = false;
    } else {
      stackI -= 1;
    }
  }

  if (valuesI >= 0) { return values[valuesI]; }
  return IndexValue(-1, 1e6, 1);
}


fn sdfObject(p_o: vec3<f32>, shape: PackedShape) -> f32 {
  let sType = u32(shape.header.x);
  if (sType == SHAPE_TYPE_SPHERE) {
    return sdSphere(p_o, shape.v0.x);
  } else if (sType == SHAPE_TYPE_BOX) {
    return sdBox(p_o, shape.v0.xyz);
  }
  return 1e6;
}



fn normalForHit(p_world: vec3<f32>, iv: IndexValue) -> vec3<f32> {
  if (iv.index < 0) { return vec3<f32>(0.0, 1.0, 0.0); }

  let shape = shapes[u32(iv.index)];
  let tId = i32(shape.header.y);
  if (tId < 0) { return vec3<f32>(0.0, 1.0, 0.0); }

  let invM = transforms[u32(tId)]; // world->object (rows)
  let p_o  = xformPoint(p_world, invM);

  let e = 0.001;

  let dx = sdfObject(p_o + vec3<f32>(-e, 0.0, 0.0), shape) -
           sdfObject(p_o + vec3<f32>(e, 0.0, 0.0), shape);
  let dy = sdfObject(p_o + vec3<f32>(0.0, -e, 0.0), shape) -
           sdfObject(p_o + vec3<f32>(0.0, e, 0.0), shape);
  let dz = sdfObject(p_o + vec3<f32>(0.0, 0.0, -e), shape) -
           sdfObject(p_o + vec3<f32>(0.0, 0.0, e), shape);

  var n_o = normalize(vec3<f32>(dx, dy, dz));

  // Transform normal back to world space
  // WO is world->object linear part; rows are invM.row*.xyz.
  // For rigid transforms (R^T), R = transpose(WO).
  let R = mat3x3<f32>(invM.row0.xyz, invM.row1.xyz, invM.row2.xyz); // columns = rows of WO
  var n_w = normalize(R * n_o);

  if (iv.isPositive == 0) {
    n_w = -n_w;
  }
  return n_w;
}


// ============================================================================
// --- Compute kernel ----------------------------------------------------------
@compute @workgroup_size(8, 8, 1)
fn render(@builtin(global_invocation_id) gid : vec3u) {
  let px = gid.x;
  let py = gid.y;
  let res = frameRes();
  if (gid.x >= res.x || gid.y >= res.y) { return; }

  let uv = vec2<f32>(
    (f32(px) + 0.5) / f32(res.x),
    (f32(py) + 0.5) / f32(res.y)
  );

  let ray = cameraRay(uv.x, uv.y, 65.0);

  let steps: i32 = 96;
  let threshold = 0.001;
  let maxDist = 200.0;
  let lightDir = normalize(vec3<f32>(0.1, -0.2, 0.2));

  var t = 0.0;
  var hit = false;
  var p = ray.origin;
  var ivHit = IndexValue(-1, 0.0, 1);

  for (var i: i32 = 0; i < steps; i = i + 1) {
    let iv = traverseNodes(p, nodes[0]);
    let dist = iv.value;
    if (dist < threshold) { 
      hit = true; 
      ivHit = iv;  
      break; 
    }
    t = t + dist;
    if (t > maxDist) { break; }
    p = ray.origin + ray.direction * t;
  }

  var color = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  if (hit) {
    let n = normalForHit(p, ivHit);
    let diffuse = max(dot(n, lightDir), 0.0);
    color = vec4<f32>(diffuse, diffuse, diffuse, 1.0);
  }

  textureStore(outImage, vec2<i32>(i32(px), i32(py)), color);
}
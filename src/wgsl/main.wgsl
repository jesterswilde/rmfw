// ============================================================================
// Compute raymarcher tracer (row-packed scene; no separate nodes buffer)
// Groups:
//   @group(0): outImage (storage texture)
//   @group(1): per-view uniforms (resolution, time, numRows, camera)
//   @group(2): scene buffers -> @binding(0)=rows, @binding(1)=transforms
// ============================================================================

@group(0) @binding(0) var outImage : texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(0) var<uniform> frame : FramePacked;
@group(2) @binding(0) var<storage, read> rows: array<PackedRow>;
@group(2) @binding(1) var<storage, read> transforms: array<Transform3x4>;

// --- Per-view uniforms -------------------------------------------------------
struct FramePacked {
  u0 : vec4<u32>,  // x = res.x, y = res.y, z = numRows, w = rootRow (currently 0)
  f0 : vec4<f32>,  // x = time
  c0 : vec4<f32>,  // camera column 0 (right)
  c1 : vec4<f32>,  // camera column 1 (up)
  c2 : vec4<f32>,  // camera column 2 (forward)
  c3 : vec4<f32>,  // camera column 3 (position)
};
fn frameRes() -> vec2<u32> { return frame.u0.xy; }
fn frameNumRows() -> u32   { return frame.u0.z; }
fn frameRootRow() -> u32   { return frame.u0.w; } // 0 = implicit root
fn frameTime() -> f32      { return frame.f0.x; }

// --- Packed scene row (64B = 16 lanes * 4B) ---------------------------------
// Header: 5 x i32 (common across kinds)
//   i0 = kind     (KIND_NONE / KIND_SHAPE / KIND_OP)
//   i1 = subtype  (shapeType or opType)
//   i2 = h0       (shape: materialID | op: firstChildRow)
//   i3 = h1       (shape: transformRow | op: nextSiblingRow)
//   i4 = h2       (shape: nextSiblingRow | op: reserved/childCount or -1)
//
// Payload: 11 x f32 (shape params or op reserved)
struct PackedRow {
  i0: i32; i1: i32; i2: i32; i3: i32; i4: i32;
  f0: f32; f1: f32; f2: f32; f3: f32; f4: f32; f5: f32; f6: f32; f7: f32; f8: f32; f9: f32; f10: f32;
};

struct Transform3x4 {
  row0: vec4<f32>,
  row1: vec4<f32>,
  row2: vec4<f32>,
};

// --- Enums -------------------------------------------------------------------
const KIND_NONE  : i32 = 0;
const KIND_SHAPE : i32 = 1;
const KIND_OP    : i32 = 2;

const SHAPE_SPHERE : i32 = 1;
const SHAPE_BOX    : i32 = 2;

const OP_UNION               : i32 = 20;
const OP_SIMPLE_UNION        : i32 = 21;
const OP_SIMPLE_SUBTRACT     : i32 = 22;
const OP_SIMPLE_INTERSECTION : i32 = 23;

// --- SDF helpers -------------------------------------------------------------
fn sdSphere(p: vec3f, s: f32) -> f32 { return length(p)-s; }
fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn radians(deg: f32) -> f32 { return deg * 3.141592653589793 / 180.0; }

fn xformPoint(p: vec3<f32>, invM: Transform3x4) -> vec3<f32> {
  return vec3(
    dot(invM.row0.xyz, p) + invM.row0.w,
    dot(invM.row1.xyz, p) + invM.row1.w,
    dot(invM.row2.xyz, p) + invM.row2.w
  );
}

// Camera — keep hardcoded for now
fn cameraRay(u: f32, v: f32, fov_y_deg: f32) -> vec2<vec3<f32>> {
  let ndc = vec2<f32>(u * 2.0 - 1.0, 1.0 - v * 2.0);
  let tanHalf = tan(0.5 * radians(fov_y_deg));
  let res = frameRes();
  let aspect = f32(res.x) / f32(res.y);

  var d_cam = vec3<f32>(ndc.x * aspect * tanHalf, ndc.y * tanHalf, 1.0);
  d_cam = normalize(d_cam);

  let camPos = vec3<f32>(0.0, 0.0, -5.0);
  let camF   = vec3<f32>(0.0, 0.0, 1.0);
  let camR   = vec3<f32>(1.0, 0.0, 0.0);
  let camU   = vec3<f32>(0.0, 1.0, 0.0);
  let dir_world = normalize(d_cam.x * camR + d_cam.y * camU + d_cam.z * camF);
  return vec2<vec3<f32>>(camPos, dir_world);
}

// --- Row access helpers ------------------------------------------------------
fn rowKind(i: u32) -> i32 { return rows[i].i0; }
fn rowSubtype(i: u32) -> i32 { return rows[i].i1; }
// shape: materialID; op: firstChildRow
fn rowH0(i: u32) -> i32 { return rows[i].i2; }
// shape: transformRow; op: nextSiblingRow
fn rowH1(i: u32) -> i32 { return rows[i].i3; }
// shape: nextSiblingRow; op: reserved/childCount
fn rowH2(i: u32) -> i32 { return rows[i].i4; }

// shape payload helpers
fn shapeP3(i: u32) -> vec3<f32> { return vec3(rows[i].f0, rows[i].f1, rows[i].f2); }
fn shapeP3b(i: u32) -> vec3<f32> { return vec3(rows[i].f3, rows[i].f4, rows[i].f5); }
fn shapeR(i: u32) -> f32 { return rows[i].f0; } // sphere radius in f0 by convention

// --- Evaluate one SHAPE leaf -------------------------------------------------
fn evalShape(p_world: vec3<f32>, row: u32) -> f32 {
  let st = rowSubtype(row);
  let tRow = rowH1(row);     // transformRow for shapes
  var q = p_world;
  if (tRow >= 0) {
    q = xformPoint(p_world, transforms[u32(tRow)]);
  }

  if (st == SHAPE_SPHERE) {
    return sdSphere(q, rows[row].f0); // radius in f0
  } else if (st == SHAPE_BOX) {
    return sdBox(q, shapeP3(row));    // half-extents in f0..f2
  }
  return 1e6;
}

// --- Reduce ops --------------------------------------------------------------
fn reducePair(op: i32, a: f32, b: f32) -> f32 {
  if (op == OP_SIMPLE_UNION)        { return min(a, b); }
  if (op == OP_SIMPLE_SUBTRACT)     { return max(a, -b); }
  if (op == OP_SIMPLE_INTERSECTION) { return max(a, b); }
  // fallback: union
  return min(a, b);
}

fn reduceNary(op: i32, acc: f32, v: f32) -> f32 {
  // OP_UNION uses min over all; others can just reuse reducePair semantics
  if (op == OP_UNION) { return min(acc, v); }
  return reducePair(op, acc, v);
}

// --- Row-based traversal -----------------------------------------------------
const STACK_MAX : u32 = 64u;

fn traverseSDF(p: vec3<f32>, rootRow: u32) -> f32 {
  var stack: array<u32, STACK_MAX>;
  var sp: i32 = 0;
  var popping = false;
  var values: array<f32, STACK_MAX>;
  var vp: i32 = -1;

  stack[0u] = rootRow;

  loop {
    if (sp < 0) { break; }
    let cur = stack[u32(sp)];

    if (rowKind(cur) == KIND_SHAPE) {
      // Leaf
      let d = evalShape(p, cur);
      vp += 1;
      values[u32(vp)] = d;

      let sib = rowH2(cur); // nextSiblingRow
      if (sib >= 0) {
        stack[u32(sp)] = u32(sib);
        popping = false;
      } else {
        popping = true;
        sp -= 1;
      }
      continue;
    }

    // OP node
    if (!popping) {
      let first = rowH0(cur); // firstChildRow
      if (first >= 0) {
        sp += 1;
        stack[u32(sp)] = u32(first);
        popping = false;
        continue;
      } else {
        // degenerate op: no children -> return large positive
        vp += 1;
        values[u32(vp)] = 1e6;
        popping = true;
        continue;
      }
    } else {
      // Reduce the top two values (binary) or n-ary if OP_UNION
      let op = rowSubtype(cur);
      // If OP_UNION and we chained children by nextSibling, just min-reduce until we hit the value produced last.
      // We produced exactly one value per child visit; siblings were walked in-order; use pairwise for simplicity:
      if (vp >= 1) {
        let b = values[u32(vp)]; vp -= 1;
        let a = values[u32(vp)];
        values[u32(vp)] = reducePair(op, a, b);
      }
      let sib = rowH1(cur); // nextSiblingRow for ops
      if (sib >= 0) {
        stack[u32(sp)] = u32(sib);
        popping = false;
      } else {
        sp -= 1;
      }
    }
  }

  if (vp >= 0) { return values[u32(vp)]; }
  return 1e6;
}

fn normalNumeric(p_world: vec3<f32>, row: u32, d: f32) -> vec3<f32> {
  // Gradient via forward differences in object -> transform back (we only know the last hit row is a shape)
  let e = 0.001;
  let dx = traverseSDF(p_world + vec3<f32>(e, 0.0, 0.0), row) - d;
  let dy = traverseSDF(p_world + vec3<f32>(0.0, e, 0.0), row) - d;
  let dz = traverseSDF(p_world + vec3<f32>(0.0, 0.0, e), row) - d;
  return normalize(vec3<f32>(dx, dy, dz));
}

// ============================================================================
// --- Compute kernel ----------------------------------------------------------
@compute @workgroup_size(8, 8, 1)
fn render(@builtin(global_invocation_id) gid : vec3u) {
  let res = frameRes();
  if (gid.x >= res.x || gid.y >= res.y) { return; }

  let uv = vec2<f32>(
    (f32(gid.x) + 0.5) / f32(res.x),
    (f32(gid.y) + 0.5) / f32(res.y)
  );

  let ray = cameraRay(uv.x, uv.y, 65.0);
  let origin = ray.x;
  let dir    = normalize(ray.y);

  let steps = 96;
  let threshold = 0.001;
  let maxDist = 200.0;
  let lightDir = normalize(vec3<f32>(0.1, -0.2, 0.2));

  var t = 0.0;
  var hit = false;
  var p = origin;
  let root = frameRootRow(); // 0 (implicit root row) by convention

  var lastD = 0.0;

  for (var i = 0; i < steps; i = i + 1) {
    lastD = traverseSDF(p, root);
    if (lastD < threshold) { hit = true; break; }
    t = t + lastD;
    if (t > maxDist) { break; }
    p = origin + dir * t;
  }

  var color = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  if (hit) {
    let n = normalNumeric(p, root, lastD);
    let diffuse = max(dot(n, lightDir), 0.0);
    color = vec4<f32>(diffuse, diffuse, diffuse, 1.0);
  }

  textureStore(outImage, vec2<i32>(i32(gid.x), i32(gid.y)), color);
}

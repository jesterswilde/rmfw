struct Dump { w: array<u32, 32> } // big enough
@group(1) @binding(0) var<uniform> dump: Dump;

@compute @workgroup_size(8,8,1)
fn render(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= dump.w[0] || gid.y >= dump.w[1]) { return; } // res.x/res.y in w[0], w[1]
  // numShapes is the 4-byte word at byte 48 -> u32 index 12
  let num = dump.w[12];
  let g = clamp(f32(num) / 64.0, 0.0, 1.0);
  let b = fract(bitcast<f32>(dump.w[4])); // time at byte 16 -> f32 index 4 -> u32[4]
  textureStore(outImage, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(1.0, g, b, 1.0));
}

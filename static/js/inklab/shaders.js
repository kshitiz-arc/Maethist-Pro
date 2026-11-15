// InkLab's WGSL, kept as strings so the worker receives it with the scripts it
// already loads: no extra fetch at startup, no build step.
(function (root) {
  'use strict';

  // Shared by every stage. Uniform layout is 48 bytes; the explicit padding
  // makes the offsets the JS writer relies on visible here.
  const PARAMS = /* wgsl */ `
struct Params {
  count : u32,          // offset 0
  baseSize : f32,       // 4   CSS px
  dpr : f32,            // 8
  _pad0 : f32,          // 12
  viewport : vec2<f32>, // 16  device px
  _pad1 : vec2<f32>,    // 24
  ink : vec4<f32>,      // 32  premultiplied
};
`;

  // One record per segment, 64 bytes. ra sits at byte 48 and rb at 52, which is
  // where gpu-renderer.js reads them back.
  const SEGMENT = /* wgsl */ `
struct Segment {
  c0 : vec2<f32>,       // the tessellated quad, device px, triangle-strip order
  c1 : vec2<f32>,
  c2 : vec2<f32>,
  c3 : vec2<f32>,
  a : vec2<f32>,        // segment start, device px
  b : vec2<f32>,        // segment end, device px
  ra : f32,             // radius at a: width(k) / 2, device px
  rb : f32,             // radius at b: width(k + 1) / 2, device px
  _pad : vec2<f32>,
};
`;

  // Step 2 of the spec: raw pen samples in, tessellated quad vertices out, with
  // width from the brush formula. That formula is a copy of stroke-width.js,
  // which is itself pinned to canvas.js - so keep the operations and their
  // order matching, and see tests/test_inklab_webgpu.py for the parity check.
  const TESSELLATE = PARAMS + SEGMENT + /* wgsl */ `
@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var<storage, read> samples : array<vec4<f32>>;       // x, y, pressure, time - t0
@group(0) @binding(2) var<storage, read_write> segments : array<Segment>;

// Every page sample carries a numeric PointerEvent.pressure, so the JS
// fallback of 0.55 for a missing pressure has no counterpart here.
fn pressureAt(i : u32) -> f32 {
  return max(0.05, min(1.0, samples[i].z));
}

fn speedAt(i : u32) -> f32 {
  if (i == 0u) {
    return 0.0;
  }
  let a = samples[i - 1u];
  let b = samples[i];
  let distance = length(b.xy - a.xy);
  // JavaScript's "interval || 16": a zero interval becomes 16 ms. Times here
  // are finite, so the NaN case cannot arise.
  let interval = b.w - a.w;
  let dt = max(8.0, select(interval, 16.0, interval == 0.0));
  return distance / dt;
}

fn widthAt(i : u32) -> f32 {
  let pressure = pressureAt(i);
  let speed = speedAt(i);
  // Taper depends on how many samples follow i, which is why the shader is
  // given the live count and not only a point's neighbours.
  let remaining = f32(params.count - 1u - i);
  let speedWeight = max(0.42, min(1.5, 1.58 - speed * 0.88));
  let pressureWeight = 0.42 + pressure * 1.95;
  let taper = min(min(1.0, 0.18 + f32(i) / 3.5), 0.16 + remaining / 5.0);
  return max(0.55, params.baseSize * pressureWeight * speedWeight * taper);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  let k = id.x;
  if (params.count < 2u) {
    return;
  }
  if (k >= params.count - 1u) {
    return;
  }

  let i = k + 1u;
  let a = samples[k].xy * params.dpr;
  let b = samples[i].xy * params.dpr;
  let ra = widthAt(k) * 0.5 * params.dpr;
  let rb = widthAt(i) * 0.5 * params.dpr;

  // Extend the quad a pixel past the ink on every side so antialiasing is
  // never clipped. A zero-length segment gets a square centred on its point.
  let reach = max(ra, rb) + 1.0;
  let delta = b - a;
  let len = length(delta);
  var along = vec2<f32>(1.0, 0.0);
  if (len > 1e-6) {
    along = delta / len;
  }
  let across = vec2<f32>(-along.y, along.x);
  let start = a - along * reach;
  let end = b + along * reach;

  var segment : Segment;
  segment.c0 = start - across * reach;
  segment.c1 = start + across * reach;
  segment.c2 = end - across * reach;
  segment.c3 = end + across * reach;
  segment.a = a;
  segment.b = b;
  segment.ra = ra;
  segment.rb = rb;
  segment._pad = vec2<f32>(0.0, 0.0);
  segments[k] = segment;
}
`;

  // Step 3: one instanced quad per segment. Each fragment measures its distance
  // to a capsule whose radius varies from ra to rb along the segment. That is
  // close to a true round cone for the small radius change between neighbouring
  // samples, and the round caps close every joint with no extra geometry.
  const STROKE = PARAMS + SEGMENT + /* wgsl */ `
@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(2) var<storage, read> segments : array<Segment>;

struct VertexOut {
  @builtin(position) position : vec4<f32>,
  @location(0) @interpolate(flat) segment : u32,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertex : u32, @builtin(instance_index) instance : u32) -> VertexOut {
  let s = segments[instance];
  var corner : vec2<f32>;
  switch vertex {
    case 0u: { corner = s.c0; }
    case 1u: { corner = s.c1; }
    case 2u: { corner = s.c2; }
    default: { corner = s.c3; }
  }
  // Device px, y down, to clip space.
  let ndc = vec2<f32>(
    corner.x / params.viewport.x * 2.0 - 1.0,
    1.0 - corner.y / params.viewport.y * 2.0
  );
  var out : VertexOut;
  out.position = vec4<f32>(ndc, 0.0, 1.0);
  out.segment = instance;
  return out;
}

@fragment
fn fragmentMain(in : VertexOut) -> @location(0) vec4<f32> {
  let s = segments[in.segment];
  // The fragment's own framebuffer position: device px, y down, at the pixel's
  // centre - the same space as the segment endpoints.
  let p = in.position.xy;
  let ab = s.b - s.a;
  let lengthSquared = dot(ab, ab);
  var h = 0.0;
  if (lengthSquared > 1e-12) {
    h = clamp(dot(p - s.a, ab) / lengthSquared, 0.0, 1.0);
  }
  let d = length(p - (s.a + ab * h)) - mix(s.ra, s.rb, h);
  let coverage = clamp(0.5 - d, 0.0, 1.0);
  return params.ink * coverage;
}
`;

  // Copies the baked-strokes texture onto the canvas, pixel for pixel. The
  // texture is the canvas's own size, so it is read with textureLoad and no
  // sampler.
  const BLIT = /* wgsl */ `
@group(0) @binding(0) var baked : texture_2d<f32>;

@vertex
fn vertexMain(@builtin(vertex_index) vertex : u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(positions[vertex], 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(baked, vec2<i32>(position.xy), 0);
}
`;

  root.InkLab = root.InkLab || {};
  root.InkLab.Shaders = Object.freeze({ PARAMS, SEGMENT, TESSELLATE, STROKE, BLIT });
})(self);

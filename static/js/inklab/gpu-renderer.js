// InkLab's WebGPU renderer: the compute tessellator (spec step 2) feeding an
// instanced stroke draw over a baked-strokes texture (step 3), presented through
// the worker's OffscreenCanvas. Same interface as the Canvas2D renderer.
(function (root) {
  'use strict';

  const PARAMS_BYTES = 48;
  const SAMPLE_BYTES = 16;
  const SEGMENT_BYTES = 64;
  const FLOATS_PER_SEGMENT = SEGMENT_BYTES / 4;
  const RA_FLOAT = 12;
  const RB_FLOAT = 13;
  const WORKGROUP_SIZE = 64;
  const INITIAL_CAPACITY = 4096;
  const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

  // Compiles WGSL and fails with the compiler's own messages. createShaderModule
  // never throws on a bad shader - the error only surfaces later, and vaguely -
  // so this is checked explicitly, and before any canvas context is touched.
  async function compileModule(device, code, label) {
    const module = device.createShaderModule({ code, label });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === 'error');
    if (errors.length) {
      const detail = errors.map((m) => `line ${m.lineNum}:${m.linePos} ${m.message}`).join('; ');
      throw new Error(`The ${label} shader failed to compile: ${detail}`);
    }
    return module;
  }

  function writeParams(device, buffer, { count, baseSize, dpr, viewport, ink }) {
    const bytes = new ArrayBuffer(PARAMS_BYTES);
    const u32 = new Uint32Array(bytes);
    const f32 = new Float32Array(bytes);
    u32[0] = count;
    f32[1] = baseSize;
    f32[2] = dpr;
    f32[4] = viewport[0];
    f32[5] = viewport[1];
    f32.set(ink, 8);
    device.queue.writeBuffer(buffer, 0, bytes);
  }

  // Times go up relative to the stroke's first sample, so f32 keeps them exact
  // to well under a millisecond however long the page has been open.
  function packSamples(points) {
    const t0 = points.length ? points[0].time : 0;
    const packed = new Float32Array(points.length * 4);
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      packed[i * 4] = point.x;
      packed[i * 4 + 1] = point.y;
      packed[i * 4 + 2] = point.pressure;
      packed[i * 4 + 3] = point.time - t0;
    }
    return packed;
  }

  function create({ gpu }) {
    const { brushWidth } = root.InkLab.StrokeWidth;

    let device = null;
    let canvasFormat = null;
    let tessellatePipeline = null;
    let strokeCanvasPipeline = null;
    let strokeBakedPipeline = null;
    let blitPipeline = null;
    let ready = null;
    let lostHandler = null;
    let errorHandler = null;

    let canvas = null;
    let context = null;
    let size = null;
    let ink = [0, 0, 0, 1];
    let baseSize = 4;

    let paramsBuffer = null;
    let sampleBuffer = null;
    let segmentBuffer = null;
    let capacity = 0;
    let computeBindGroup = null;
    let strokeCanvasBindGroup = null;
    let strokeBakedBindGroup = null;
    let bakedTexture = null;
    let blitBindGroup = null;

    // Everything that can fail runs here, before any canvas is involved: an
    // OffscreenCanvas locks to the first context type it hands out, so asking
    // for 'webgpu' and then failing would leave nothing for Canvas2D to use.
    function ensureDevice() {
      if (!ready) {
        ready = (async () => {
          if (!gpu) throw new Error('This browser has no navigator.gpu');
          const adapter = await gpu.requestAdapter();
          if (!adapter) throw new Error('No WebGPU adapter is available');
          device = await adapter.requestDevice();
          device.lost.then((info) => {
            if (lostHandler) lostHandler(info);
          });
          // WebGPU validation errors never throw: they arrive here or nowhere.
          // Nobody listens until init has succeeded, because a failure before
          // then is already reported by init rejecting.
          device.addEventListener('uncapturederror', (event) => {
            if (errorHandler) errorHandler(event.error);
          });
          canvasFormat = gpu.getPreferredCanvasFormat();

          const shaders = root.InkLab.Shaders;
          const [tessellateModule, strokeModule, blitModule] = await Promise.all([
            compileModule(device, shaders.TESSELLATE, 'tessellate'),
            compileModule(device, shaders.STROKE, 'stroke'),
            compileModule(device, shaders.BLIT, 'blit'),
          ]);

          // Ink is one opaque colour, so a max blend makes overlapping capsules
          // an exact union: joints do not darken where round caps overlap.
          const maxBlend = { operation: 'max', srcFactor: 'one', dstFactor: 'one' };
          const strokePipeline = (format, label) =>
            device.createRenderPipelineAsync({
              label,
              layout: 'auto',
              vertex: { module: strokeModule, entryPoint: 'vertexMain' },
              fragment: {
                module: strokeModule,
                entryPoint: 'fragmentMain',
                targets: [{ format, blend: { color: maxBlend, alpha: maxBlend } }],
              },
              primitive: { topology: 'triangle-strip' },
            });

          [tessellatePipeline, strokeCanvasPipeline, strokeBakedPipeline, blitPipeline] = await Promise.all([
            device.createComputePipelineAsync({
              label: 'tessellate',
              layout: 'auto',
              compute: { module: tessellateModule, entryPoint: 'main' },
            }),
            strokePipeline(canvasFormat, 'stroke onto canvas'),
            strokePipeline('rgba8unorm', 'stroke onto baked texture'),
            device.createRenderPipelineAsync({
              label: 'blit',
              layout: 'auto',
              vertex: { module: blitModule, entryPoint: 'vertexMain' },
              fragment: { module: blitModule, entryPoint: 'fragmentMain', targets: [{ format: canvasFormat }] },
              primitive: { topology: 'triangle-list' },
            }),
          ]);
        })();
      }
      return ready;
    }

    // Pipelines built with layout 'auto' cannot share bind groups, so each stroke
    // pipeline gets its own over the same buffers.
    function rebuildStrokeBindGroups() {
      computeBindGroup = device.createBindGroup({
        label: 'tessellate',
        layout: tessellatePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsBuffer } },
          { binding: 1, resource: { buffer: sampleBuffer } },
          { binding: 2, resource: { buffer: segmentBuffer } },
        ],
      });
      const strokeEntries = [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 2, resource: { buffer: segmentBuffer } },
      ];
      strokeCanvasBindGroup = device.createBindGroup({
        label: 'stroke onto canvas',
        layout: strokeCanvasPipeline.getBindGroupLayout(0),
        entries: strokeEntries,
      });
      strokeBakedBindGroup = device.createBindGroup({
        label: 'stroke onto baked texture',
        layout: strokeBakedPipeline.getBindGroupLayout(0),
        entries: strokeEntries,
      });
    }

    // Starts at 4,096 samples and doubles whenever a stroke outgrows it.
    function ensureCapacity(count) {
      if (sampleBuffer && count <= capacity) return;
      let next = Math.max(capacity, INITIAL_CAPACITY);
      while (next < count) next *= 2;
      if (sampleBuffer) {
        sampleBuffer.destroy();
        segmentBuffer.destroy();
      }
      capacity = next;
      sampleBuffer = device.createBuffer({
        label: 'samples',
        size: capacity * SAMPLE_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      segmentBuffer = device.createBuffer({
        label: 'segments',
        size: capacity * SEGMENT_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      rebuildStrokeBindGroups();
    }

    function allocateSurface() {
      const width = Math.max(1, Math.round(size.width * size.dpr));
      const height = Math.max(1, Math.round(size.height * size.dpr));
      canvas.width = width;
      canvas.height = height;
      if (bakedTexture) bakedTexture.destroy();
      bakedTexture = device.createTexture({
        label: 'baked strokes',
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      blitBindGroup = device.createBindGroup({
        label: 'blit',
        layout: blitPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: bakedTexture.createView() }],
      });
    }

    // Uploads one stroke and encodes the compute pass that tessellates it.
    // queue.writeBuffer takes effect before the next submit, not at the point it
    // is called within an encoder - so each tessellation must be submitted before
    // another stroke's samples are written, or both passes would see the second.
    function encodeTessellation(encoder, points) {
      const count = points.length;
      ensureCapacity(count);
      writeParams(device, paramsBuffer, {
        count,
        baseSize,
        dpr: size.dpr,
        viewport: [canvas.width, canvas.height],
        ink,
      });
      device.queue.writeBuffer(sampleBuffer, 0, packSamples(points));
      const segmentCount = count - 1;
      const pass = encoder.beginComputePass({ label: 'tessellate' });
      pass.setPipeline(tessellatePipeline);
      pass.setBindGroup(0, computeBindGroup);
      pass.dispatchWorkgroups(Math.ceil(segmentCount / WORKGROUP_SIZE));
      pass.end();
      return segmentCount;
    }

    function drawFrame(committed, provisional) {
      const points = provisional.length ? committed.concat(provisional) : committed;
      const encoder = device.createCommandEncoder({ label: 'frame' });
      const segmentCount = points.length >= 2 ? encodeTessellation(encoder, points) : 0;

      const pass = encoder.beginRenderPass({
        label: 'frame',
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: TRANSPARENT,
        }],
      });
      pass.setPipeline(blitPipeline);
      pass.setBindGroup(0, blitBindGroup);
      pass.draw(3);
      if (segmentCount > 0) {
        pass.setPipeline(strokeCanvasPipeline);
        pass.setBindGroup(0, strokeCanvasBindGroup);
        pass.draw(4, segmentCount);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    function bake(committed) {
      if (committed.length < 2) return;
      const encoder = device.createCommandEncoder({ label: 'bake' });
      const segmentCount = encodeTessellation(encoder, committed);
      const pass = encoder.beginRenderPass({
        label: 'bake',
        colorAttachments: [{ view: bakedTexture.createView(), loadOp: 'load', storeOp: 'store' }],
      });
      pass.setPipeline(strokeBakedPipeline);
      pass.setBindGroup(0, strokeBakedBindGroup);
      pass.draw(4, segmentCount);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    function clear() {
      const encoder = device.createCommandEncoder({ label: 'clear' });
      encoder.beginRenderPass({
        label: 'clear',
        colorAttachments: [{ view: bakedTexture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: TRANSPARENT }],
      }).end();
      device.queue.submit([encoder.finish()]);
    }

    return {
      name: 'webgpu',

      async init(target, initialSize, inkColour, base) {
        await ensureDevice();
        canvas = target;
        size = initialSize;
        ink = inkColour;
        baseSize = base;
        paramsBuffer = device.createBuffer({
          label: 'params',
          size: PARAMS_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        // Only now, with the device and every pipeline built, is the canvas
        // committed to WebGPU.
        context = canvas.getContext('webgpu');
        if (!context) throw new Error('The canvas would not provide a webgpu context');
        context.configure({ device, format: canvasFormat, alphaMode: 'premultiplied' });
        allocateSurface();
      },

      resize(nextSize, finished) {
        size = nextSize;
        allocateSurface();
        for (const stroke of finished) bake(stroke);
      },

      drawFrame,
      bake,
      clear,

      async snapshot() {
        const { width, height } = bakedTexture;
        // copyTextureToBuffer requires rows padded to a multiple of 256 bytes.
        const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        const readBuffer = device.createBuffer({
          label: 'snapshot',
          size: bytesPerRow * height,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const encoder = device.createCommandEncoder({ label: 'snapshot' });
        encoder.copyTextureToBuffer({ texture: bakedTexture }, { buffer: readBuffer, bytesPerRow }, [width, height]);
        device.queue.submit([encoder.finish()]);
        await readBuffer.mapAsync(GPUMapMode.READ);

        const bytes = new Uint8Array(readBuffer.getMappedRange());
        let inked = 0;
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (let y = 0; y < height; y++) {
          const row = y * bytesPerRow;
          for (let x = 0; x < width; x++) {
            if (bytes[row + x * 4 + 3] < 8) continue;
            inked++;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
        readBuffer.unmap();
        readBuffer.destroy();
        return { inked, bbox: inked ? { left, top, right, bottom } : null };
      },

      onDeviceLost(handler) {
        lostHandler = handler;
      },

      onError(handler) {
        errorHandler = handler;
      },

      // Test seam for the WGSL width copy: runs the compute pass on `samples` in
      // buffers of its own and reads every segment's end radii back from the GPU.
      async tessellate(samples, sampleBaseSize, dpr) {
        await ensureDevice();

        const count = samples.length;
        const segmentCount = Math.max(0, count - 1);
        const segmentBytes = Math.max(SEGMENT_BYTES, segmentCount * SEGMENT_BYTES);

        const probeParams = device.createBuffer({
          size: PARAMS_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const probeSamples = device.createBuffer({
          size: Math.max(SAMPLE_BYTES, count * SAMPLE_BYTES),
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const probeSegments = device.createBuffer({
          size: segmentBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const readBuffer = device.createBuffer({
          size: segmentBytes,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        try {
          writeParams(device, probeParams, {
            count,
            baseSize: sampleBaseSize,
            dpr,
            viewport: [1, 1],
            ink: [0, 0, 0, 1],
          });
          device.queue.writeBuffer(probeSamples, 0, packSamples(samples));

          const bindGroup = device.createBindGroup({
            layout: tessellatePipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: probeParams } },
              { binding: 1, resource: { buffer: probeSamples } },
              { binding: 2, resource: { buffer: probeSegments } },
            ],
          });

          const encoder = device.createCommandEncoder({ label: 'tessellate probe' });
          if (segmentCount > 0) {
            const pass = encoder.beginComputePass({ label: 'tessellate probe' });
            pass.setPipeline(tessellatePipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(Math.ceil(segmentCount / WORKGROUP_SIZE));
            pass.end();
          }
          encoder.copyBufferToBuffer(probeSegments, 0, readBuffer, 0, segmentBytes);
          device.queue.submit([encoder.finish()]);

          await readBuffer.mapAsync(GPUMapMode.READ);
          const floats = new Float32Array(readBuffer.getMappedRange().slice(0));
          readBuffer.unmap();

          const gpuRadii = [];
          for (let k = 0; k < segmentCount; k++) {
            const at = k * FLOATS_PER_SEGMENT;
            gpuRadii.push([floats[at + RA_FLOAT], floats[at + RB_FLOAT]]);
          }
          const jsWidths = samples.map((_, i) => brushWidth(samples, i, sampleBaseSize));
          return { dpr, gpuRadii, jsWidths };
        } finally {
          probeParams.destroy();
          probeSamples.destroy();
          probeSegments.destroy();
          readBuffer.destroy();
        }
      },
    };
  }

  root.InkLab = root.InkLab || {};
  root.InkLab.GpuRenderer = Object.freeze({ create });
})(self);

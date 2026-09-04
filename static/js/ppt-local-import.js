(function () {
  "use strict";

  const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const PPT_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const EMU_WIDE = 12192000;
  const EMU_HIGH = 6858000;
  const EMU_PER_INCH = 914400;
  const CSS_PIXELS_PER_INCH = 96;
  // A deck rasterised at its native CSS size lands at exactly 1 device pixel
  // per CSS pixel, which is soft on any modern display. Supersampling is what
  // makes slide text readable without zooming.
  const RENDER_SUPERSAMPLE = 2;
  const MAX_RENDER_SIDE = 4096;
  const MAX_RENDER_PIXELS = 12 * 1024 * 1024;

  const DEFAULT_THEME = {
    tx1: [0, 0, 0],
    tx2: [31, 41, 55],
    bg1: [255, 255, 255],
    bg2: [248, 250, 252],
    accent1: [79, 70, 229],
    accent2: [22, 163, 74],
    accent3: [234, 88, 12],
    accent4: [220, 38, 38],
    accent5: [6, 182, 212],
    accent6: [168, 85, 247],
    hlink: [37, 99, 235],
    folHlink: [124, 58, 237]
  };

  function get16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function get32(bytes, offset) {
    return (
      bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)
    ) >>> 0;
  }

  function decodeUtf8(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  function decodeLatin1(bytes) {
    let value = "";
    for (let index = 0; index < bytes.length; index += 1) {
      value += String.fromCharCode(bytes[index]);
    }
    return value;
  }

  function findEndOfCentralDirectory(bytes) {
    const min = Math.max(0, bytes.length - 66000);
    for (let offset = bytes.length - 22; offset >= min; offset -= 1) {
      if (get32(bytes, offset) === 0x06054b50) return offset;
    }
    throw new Error("This PPTX zip file is missing its directory.");
  }

  function normalizePath(path) {
    const parts = [];
    path.split("/").forEach((part) => {
      if (!part || part === ".") return;
      if (part === "..") parts.pop();
      else parts.push(part);
    });
    return parts.join("/");
  }

  function dirname(path) {
    const index = path.lastIndexOf("/");
    return index === -1 ? "" : path.slice(0, index);
  }

  function basename(path) {
    const index = path.lastIndexOf("/");
    return index === -1 ? path : path.slice(index + 1);
  }

  function resolveTarget(partName, target) {
    if (!target) return "";
    if (target.startsWith("/")) return normalizePath(target.slice(1));
    return normalizePath(`${dirname(partName)}/${target}`);
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Fast local PPTX import needs a modern browser with zip decompression.");
    }

    const formats = ["deflate-raw", "deflate"];
    let lastError = null;
    for (const format of formats) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Could not decompress this PPTX.");
  }

  async function openZip(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const eocd = findEndOfCentralDirectory(bytes);
    const entryCount = get16(bytes, eocd + 10);
    let pointer = get32(bytes, eocd + 16);
    const entries = new Map();

    for (let index = 0; index < entryCount; index += 1) {
      if (get32(bytes, pointer) !== 0x02014b50) {
        throw new Error("This PPTX zip directory is corrupted.");
      }

      const method = get16(bytes, pointer + 10);
      const compressedSize = get32(bytes, pointer + 20);
      const uncompressedSize = get32(bytes, pointer + 24);
      const nameLength = get16(bytes, pointer + 28);
      const extraLength = get16(bytes, pointer + 30);
      const commentLength = get16(bytes, pointer + 32);
      const localOffset = get32(bytes, pointer + 42);
      const flags = get16(bytes, pointer + 8);
      const nameBytes = bytes.slice(pointer + 46, pointer + 46 + nameLength);
      const name = flags & 0x0800 ? decodeUtf8(nameBytes) : decodeLatin1(nameBytes);

      entries.set(name, {
        name,
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
        data: null
      });
      pointer += 46 + nameLength + extraLength + commentLength;
    }

    async function entryBytes(name) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`Missing ${name} in this PPTX.`);
      if (entry.data) return entry.data;

      if (get32(bytes, entry.localOffset) !== 0x04034b50) {
        throw new Error(`The ${name} zip entry is corrupted.`);
      }

      const nameLength = get16(bytes, entry.localOffset + 26);
      const extraLength = get16(bytes, entry.localOffset + 28);
      const start = entry.localOffset + 30 + nameLength + extraLength;
      const compressed = bytes.slice(start, start + entry.compressedSize);

      if (entry.method === 0) {
        entry.data = compressed;
      } else if (entry.method === 8) {
        entry.data = await inflateRaw(compressed);
      } else {
        throw new Error("This PPTX uses a zip compression method the browser cannot read.");
      }

      if (entry.uncompressedSize && entry.data.length !== entry.uncompressedSize) {
        throw new Error(`The ${name} zip entry did not decompress correctly.`);
      }
      return entry.data;
    }

    return {
      has: (name) => entries.has(name),
      list: () => Array.from(entries.keys()),
      bytes: entryBytes,
      text: async (name) => decodeUtf8(await entryBytes(name))
    };
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const error = doc.getElementsByTagName("parsererror")[0];
    if (error) throw new Error("Could not parse PPTX XML.");
    return doc;
  }

  function child(node, localName) {
    if (!node) return null;
    return Array.from(node.children || []).find((item) => item.localName === localName) || null;
  }

  function descendants(node, localName) {
    if (!node) return [];
    return Array.from(node.getElementsByTagNameNS("*", localName));
  }

  function firstDesc(node, localName) {
    return descendants(node, localName)[0] || null;
  }

  function attrNumber(node, name, fallback = 0) {
    if (!node || !node.hasAttribute(name)) return fallback;
    const value = Number(node.getAttribute(name));
    return Number.isFinite(value) ? value : fallback;
  }

  function relId(node) {
    if (!node) return "";
    return node.getAttributeNS(R_NS, "id") || node.getAttributeNS(R_NS, "embed") || node.getAttribute("r:id") || node.getAttribute("r:embed") || "";
  }

  function hexToRgb(value, fallback = [31, 41, 55]) {
    if (!value || !/^[0-9a-f]{6}$/i.test(value)) return fallback;
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16)
    ];
  }

  function clampColor(channel) {
    return Math.max(0, Math.min(255, Math.round(channel)));
  }

  function applyColorAdjustments(rgb, node) {
    let [r, g, b] = rgb;
    Array.from(node?.children || []).forEach((item) => {
      const value = attrNumber(item, "val", 100000) / 100000;
      if (item.localName === "lumMod" || item.localName === "shade") {
        r *= value;
        g *= value;
        b *= value;
      } else if (item.localName === "lumOff") {
        r += 255 * value;
        g += 255 * value;
        b += 255 * value;
      } else if (item.localName === "tint") {
        r += (255 - r) * value;
        g += (255 - g) * value;
        b += (255 - b) * value;
      }
    });
    return [clampColor(r), clampColor(g), clampColor(b)];
  }

  function alphaFromColorNode(node) {
    const alpha = child(node, "alpha");
    if (!alpha) return 1;
    return Math.max(0, Math.min(1, attrNumber(alpha, "val", 100000) / 100000));
  }

  function cssColor(rgb, alpha = 1) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
  }

  function colorFromFill(fillNode, theme, fallback = [31, 41, 55]) {
    if (!fillNode) return cssColor(fallback);

    const srgb = firstDesc(fillNode, "srgbClr");
    if (srgb) return cssColor(applyColorAdjustments(hexToRgb(srgb.getAttribute("val"), fallback), srgb), alphaFromColorNode(srgb));

    const sys = firstDesc(fillNode, "sysClr");
    if (sys) return cssColor(applyColorAdjustments(hexToRgb(sys.getAttribute("lastClr"), fallback), sys), alphaFromColorNode(sys));

    const scheme = firstDesc(fillNode, "schemeClr");
    if (scheme) {
      const base = theme[scheme.getAttribute("val")] || fallback;
      return cssColor(applyColorAdjustments(base, scheme), alphaFromColorNode(scheme));
    }

    return cssColor(fallback);
  }

  function fillStyle(ctx, fillNode, theme, box, fallback) {
    if (!fillNode) return null;
    if (fillNode.localName === "gradFill") {
      const stops = descendants(fillNode, "gs");
      if (stops.length >= 2) {
        const [x, y, w, h] = box;
        const gradient = ctx.createLinearGradient(x, y, x + w, y + h);
        stops.forEach((stop) => {
          gradient.addColorStop(Math.max(0, Math.min(1, attrNumber(stop, "pos", 0) / 100000)), colorFromFill(stop, theme, fallback));
        });
        return gradient;
      }
    }
    return colorFromFill(fillNode, theme, fallback);
  }

  function mediaType(path) {
    const ext = path.split(".").pop().toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "gif") return "image/gif";
    if (ext === "svg") return "image/svg+xml";
    if (ext === "webp") return "image/webp";
    return "image/png";
  }

  async function loadMediaImage(context, path) {
    if (context.imageCache.has(path)) return context.imageCache.get(path);

    const promise = (async () => {
      const bytes = await context.package.bytes(path);
      const image = new Image();
      const url = URL.createObjectURL(new Blob([bytes], { type: mediaType(path) }));
      try {
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
          image.src = url;
        });
        return image;
      } finally {
        URL.revokeObjectURL(url);
      }
    })();

    context.imageCache.set(path, promise);
    return promise;
  }

  function cropSourceRect(element, image) {
    const srcRect = firstDesc(element, "srcRect");
    if (!srcRect) return [0, 0, image.naturalWidth || image.width, image.naturalHeight || image.height];

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const left = width * attrNumber(srcRect, "l", 0) / 100000;
    const top = height * attrNumber(srcRect, "t", 0) / 100000;
    const right = width * (1 - attrNumber(srcRect, "r", 0) / 100000);
    const bottom = height * (1 - attrNumber(srcRect, "b", 0) / 100000);
    return [left, top, Math.max(1, right - left), Math.max(1, bottom - top)];
  }

  function blipFillFor(element) {
    return child(element, "blipFill") || firstDesc(child(element, "spPr"), "blipFill") || firstDesc(element, "blipFill");
  }

  function destinationRectForImage(element, box) {
    const fillRect = firstDesc(blipFillFor(element), "fillRect");
    if (!fillRect) return box;

    const [x, y, w, h] = box;
    const left = attrNumber(fillRect, "l", 0) / 100000;
    const top = attrNumber(fillRect, "t", 0) / 100000;
    const right = attrNumber(fillRect, "r", 0) / 100000;
    const bottom = attrNumber(fillRect, "b", 0) / 100000;

    return [
      x + w * left,
      y + h * top,
      Math.max(1, w * (1 - left - right)),
      Math.max(1, h * (1 - top - bottom))
    ];
  }

  function drawBlipImage(ctx, element, image, box) {
    const source = cropSourceRect(element, image);
    const destination = destinationRectForImage(element, box);
    const hasOutset = destination[0] < box[0] ||
      destination[1] < box[1] ||
      destination[0] + destination[2] > box[0] + box[2] ||
      destination[1] + destination[3] > box[1] + box[3];

    ctx.save();
    if (!hasOutset) {
      ctx.beginPath();
      ctx.rect(box[0], box[1], box[2], box[3]);
      ctx.clip();
    }
    ctx.drawImage(
      image,
      source[0],
      source[1],
      source[2],
      source[3],
      destination[0],
      destination[1],
      destination[2],
      destination[3]
    );
    ctx.restore();
  }

  function directXfrm(element) {
    const spPr = child(element, "spPr");
    const spXfrm = child(spPr, "xfrm");
    if (spXfrm) return spXfrm;

    const grpPr = child(element, "grpSpPr");
    const grpXfrm = child(grpPr, "xfrm");
    if (grpXfrm) return grpXfrm;

    // graphicFrame (tables, charts, SmartArt) puts <p:xfrm> directly on itself.
    return child(element, "xfrm");
  }

  // Whether this element resolved a real position, as opposed to falling back
  // to the whole slide. Anything that paints an opaque background must check
  // this, or one unpositioned node wipes out the slide beneath it.
  function hasResolvedXfrm(context, element) {
    if (directXfrm(element)) return true;
    if (!context.placeholderXfrms) return false;
    return placeholderKeys(element).some((key) => context.placeholderXfrms.has(key));
  }

  function placeholderInfo(element) {
    const ph = firstDesc(element, "ph");
    if (!ph) return null;
    return {
      type: ph.getAttribute("type") || "",
      idx: ph.getAttribute("idx") || ""
    };
  }

  function placeholderKeys(element) {
    const info = placeholderInfo(element);
    if (!info) return [];
    const keys = [];
    if (info.idx) keys.push(`idx:${info.idx}`);
    if (info.type) keys.push(`type:${info.type}`);
    return keys;
  }

  async function collectPlaceholderXfrms(context, partName) {
    const map = new Map();
    if (!partName || !context.package.has(partName)) return map;

    const xml = await xmlPart(context, partName);
    const shapes = descendants(xml, "sp");

    shapes.forEach((shape) => {
      const xfrm = directXfrm(shape);
      if (!xfrm) return;

      placeholderKeys(shape).forEach((key) => {
        map.set(key, xfrm);
      });
    });

    return map;
  }

  function boxFor(context, element, transform) {
    let xfrm = directXfrm(element);

    if (!xfrm && context.placeholderXfrms) {
      for (const key of placeholderKeys(element)) {
        if (context.placeholderXfrms.has(key)) {
          xfrm = context.placeholderXfrms.get(key);
          break;
        }
      }
    }

    const off = child(xfrm, "off");
    const ext = child(xfrm, "ext");

    const x = attrNumber(off, "x", 0);
    const y = attrNumber(off, "y", 0);
    const w = attrNumber(ext, "cx", context.slideCx);
    const h = attrNumber(ext, "cy", context.slideCy);

    const slideX = transform.ox + transform.sx * x;
    const slideY = transform.oy + transform.sy * y;
    const slideW = transform.sx * w;
    const slideH = transform.sy * h;

    return [
      Math.round(slideX / context.slideCx * context.outW),
      Math.round(slideY / context.slideCy * context.outH),
      Math.max(1, Math.round(slideW / context.slideCx * context.outW)),
      Math.max(1, Math.round(slideH / context.slideCy * context.outH))
    ];
  }

  function childTransform(group, parent) {
    const xfrm = directXfrm(group);
    if (!xfrm) return parent;

    const off = child(xfrm, "off");
    const ext = child(xfrm, "ext");
    const chOff = child(xfrm, "chOff");
    const chExt = child(xfrm, "chExt");
    const x = attrNumber(off, "x", 0);
    const y = attrNumber(off, "y", 0);
    const w = Math.max(1, attrNumber(ext, "cx", 1));
    const h = Math.max(1, attrNumber(ext, "cy", 1));
    const chX = attrNumber(chOff, "x", 0);
    const chY = attrNumber(chOff, "y", 0);
    const chW = Math.max(1, attrNumber(chExt, "cx", w));
    const chH = Math.max(1, attrNumber(chExt, "cy", h));

    return {
      ox: parent.ox + parent.sx * x - parent.sx * w * chX / chW,
      oy: parent.oy + parent.sy * y - parent.sy * h * chY / chH,
      sx: parent.sx * w / chW,
      sy: parent.sy * h / chH
    };
  }

  async function relsForPart(context, partName) {
    if (!partName) return new Map();
    if (context.relsCache.has(partName)) return context.relsCache.get(partName);

    const relsPath = normalizePath(`${dirname(partName)}/_rels/${basename(partName)}.rels`);
    const rels = new Map();
    if (context.package.has(relsPath)) {
      const xml = parseXml(await context.package.text(relsPath));
      descendants(xml, "Relationship").forEach((rel) => {
        rels.set(rel.getAttribute("Id"), resolveTarget(partName, rel.getAttribute("Target")));
      });
    }
    context.relsCache.set(partName, rels);
    return rels;
  }

  async function xmlPart(context, partName) {
    if (context.xmlCache.has(partName)) return context.xmlCache.get(partName);
    const xml = parseXml(await context.package.text(partName));
    context.xmlCache.set(partName, xml);
    return xml;
  }

  function relatedPartByPrefix(rels, prefix) {
    for (const target of rels.values()) {
      if (target.startsWith(prefix)) return target;
    }
    return "";
  }

  async function renderPicture(context, ctx, rels, element, transform) {
    const blip = firstDesc(element, "blip");
    const mediaPath = rels.get(relId(blip));
    if (!mediaPath || !context.package.has(mediaPath)) return;

    try {
      const image = await loadMediaImage(context, mediaPath);
      const box = boxFor(context, element, transform);
      drawBlipImage(ctx, element, image, box);
    } catch (error) {
      console.warn("Could not render PPTX image", mediaPath, error);
    }
  }

  function emuToPx(emu, scale) {
    return (Number(emu) || 0) / 914400 * 96 * scale;
  }

  function contextRenderScale(context) {
    return context.nativeW > 0 ? context.outW / context.nativeW : 1;
  }

  function boundedRenderSize(nativeWidth, nativeHeight) {
    const sideScale = Math.min(
      RENDER_SUPERSAMPLE,
      MAX_RENDER_SIDE / Math.max(1, nativeWidth),
      MAX_RENDER_SIDE / Math.max(1, nativeHeight)
    );
    const pixelScale = Math.min(
      RENDER_SUPERSAMPLE,
      Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, nativeWidth * nativeHeight))
    );
    const scale = Math.max(1, Math.min(sideScale, pixelScale));
    return {
      width: Math.max(1, Math.round(nativeWidth * scale)),
      height: Math.max(1, Math.round(nativeHeight * scale))
    };
  }

  // Title/body placeholders usually inherit their font size from the slide
  // layout/master, which this renderer does not walk. When a run carries no
  // explicit size we fall back to a sensible default for its placeholder role.
  function placeholderType(shape) {
    const nvSpPr = child(shape, "nvSpPr");
    const nvPr = nvSpPr ? child(nvSpPr, "nvPr") : null;
    const ph = nvPr ? child(nvPr, "ph") : null;
    return ph ? (ph.getAttribute("type") || "body") : "";
  }

  function defaultSizeForPlaceholder(type) {
    if (type === "ctrTitle" || type === "title") return 4400;
    if (type === "subTitle") return 2000;
    return 1800;
  }

  function readBodyPr(shape, scale) {
    const txBody = child(shape, "txBody");
    const bodyPr = txBody ? child(txBody, "bodyPr") : null;
    return {
      anchor: (bodyPr && bodyPr.getAttribute("anchor")) || "t",
      lIns: emuToPx(bodyPr ? attrNumber(bodyPr, "lIns", 91440) : 91440, scale),
      tIns: emuToPx(bodyPr ? attrNumber(bodyPr, "tIns", 45720) : 45720, scale),
      rIns: emuToPx(bodyPr ? attrNumber(bodyPr, "rIns", 91440) : 91440, scale),
      bIns: emuToPx(bodyPr ? attrNumber(bodyPr, "bIns", 45720) : 45720, scale)
    };
  }

  function isOn(value) {
    return value === "1" || value === "true";
  }

  // Each paragraph becomes one styled block. Mixed formatting *within* a
  // paragraph (e.g. one bold word) is approximated using the first run's style.
  function paragraphStyles(shape, context, fallbackSize) {
    const txBody = child(shape, "txBody");
    if (!txBody) return [];
    const scale = contextRenderScale(context);

    return Array.from(txBody.children)
      .filter((node) => node.localName === "p")
      .map((p) => {
        const pPr = child(p, "pPr");

        let text = "";
        Array.from(p.children).forEach((node) => {
          if (node.localName === "r" || node.localName === "fld") {
            const t = child(node, "t");
            if (t) text += t.textContent || "";
          } else if (node.localName === "br") {
            text += "\n";
          }
        });

        const firstRun = Array.from(p.children).find((node) => node.localName === "r");
        const rPr = firstRun ? child(firstRun, "rPr") : (pPr ? child(pPr, "defRPr") : null);
        const sizePt = rPr ? attrNumber(rPr, "sz", fallbackSize) : fallbackSize;

        let fill = rPr ? child(rPr, "solidFill") : null;
        if (!fill) {
          const endPara = child(p, "endParaRPr");
          fill = endPara ? child(endPara, "solidFill") : null;
        }
        const color = fill
          ? colorFromFill(fill, context.theme, DEFAULT_THEME.tx1)
          : cssColor(DEFAULT_THEME.tx1);

        const latin = rPr ? firstDesc(rPr, "latin") : null;

        let bullet = "";
        if (pPr && !child(pPr, "buNone")) {
          const buChar = child(pPr, "buChar");
          const buAutoNum = child(pPr, "buAutoNum");
          const buFont = child(pPr, "buFont");
          const buFontFace = buFont ? (buFont.getAttribute("typeface") || "") : "";
          // Symbol-font bullets (Wingdings "Ø", Symbol, etc.) have no sane glyph
          // in the web fallback fonts, so normalise them to a standard bullet.
          const symbolFont = /wingding|webding|symbol|monotype sorts|marlett/i.test(buFontFace);
          if (buChar) bullet = symbolFont ? "•" : (buChar.getAttribute("char") || "•");
          else if (buAutoNum) bullet = "•";
        }

        return {
          text,
          align: (pPr && pPr.getAttribute("algn")) || "l",
          sizePx: Math.max(6, Math.round(sizePt / 100 * 96 / 72 * scale)),
          bold: rPr ? isOn(rPr.getAttribute("b")) : false,
          italic: rPr ? isOn(rPr.getAttribute("i")) : false,
          color,
          fontFace: (latin && latin.getAttribute("typeface")) || "Georgia",
          level: pPr ? attrNumber(pPr, "lvl", 0) : 0,
          bullet
        };
      })
      .filter((para) => para.text.trim() || para.bullet);
  }

  function fontStringFor(style, shrink) {
    const size = Math.max(6, Math.round(style.sizePx * shrink));
    return `${style.italic ? "italic " : ""}${style.bold ? "700 " : ""}${size}px ${style.fontFace}, "Times New Roman", Aptos, Calibri, Arial, sans-serif`;
  }

  function layoutTextBody(ctx, paras, innerW, scale, shrink) {
    const lines = [];
    let totalHeight = 0;

    paras.forEach((para) => {
      const size = Math.max(6, para.sizePx * shrink);
      const lineHeight = Math.max(10, size * 1.2);
      const bulletGap = para.bullet ? Math.max(12, size * 0.9) : 0;
      const indent = para.level * Math.max(10, 18 * scale) + bulletGap;
      const avail = Math.max(20, innerW - indent);
      const font = fontStringFor(para, shrink);
      ctx.font = font;

      let firstLine = true;
      para.text.replace(/\r/g, "").split("\n").forEach((segment) => {
        const wrapped = [];
        let line = "";
        segment.split(/\s+/).filter(Boolean).forEach((word) => {
          const test = line ? `${line} ${word}` : word;
          if (!line || ctx.measureText(test).width <= avail) {
            line = test;
          } else {
            wrapped.push(line);
            line = word;
          }
        });
        wrapped.push(line);

        wrapped.forEach((textLine) => {
          lines.push({
            text: textLine,
            align: para.align,
            font,
            color: para.color,
            height: lineHeight,
            size,
            indent,
            bulletGap,
            bullet: firstLine ? para.bullet : ""
          });
          totalHeight += lineHeight;
          firstLine = false;
        });
      });
    });

    return { lines, totalHeight };
  }

  // Plain-text helper for cases without a full <txBody> (table cells, chart /
  // SmartArt fallback boxes). Shape text goes through drawTextBody instead.
  function drawWrappedText(ctx, text, x, y, w, h, color, sizePx, bold, align = "l", fontFace = "Georgia") {
    if (!text) return;

    let fontSize = Math.max(8, Math.min(120, sizePx));
    let lineHeight = Math.max(12, fontSize * 1.18);

    function buildLines() {
      ctx.font = `${bold ? "700 " : ""}${fontSize}px ${fontFace}, "Times New Roman", Aptos, Calibri, Arial, sans-serif`;
      const lines = [];
      text.split(/\n+/).forEach((paragraph) => {
        let line = "";
        paragraph.split(/\s+/).filter(Boolean).forEach((word) => {
          const test = `${line} ${word}`.trim();
          if (!line || ctx.measureText(test).width <= w) {
            line = test;
          } else {
            lines.push(line);
            line = word;
          }
        });
        if (line) lines.push(line);
      });
      return lines;
    }

    let lines = buildLines();
    while (lines.length * lineHeight > h && fontSize > 8) {
      fontSize -= 1;
      lineHeight = Math.max(12, fontSize * 1.18);
      lines = buildLines();
    }

    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `${bold ? "700 " : ""}${fontSize}px ${fontFace}, "Times New Roman", Aptos, Calibri, Arial, sans-serif`;
    ctx.textBaseline = "top";

    let drawX = x;
    if (align === "ctr" || align === "center") {
      ctx.textAlign = "center";
      drawX = x + w / 2;
    } else if (align === "r" || align === "right") {
      ctx.textAlign = "right";
      drawX = x + w;
    } else {
      ctx.textAlign = "left";
    }

    lines.forEach((line, index) => {
      const yy = y + index * lineHeight;
      if (yy + lineHeight <= y + h + 2) {
        ctx.fillText(line, drawX, yy);
      }
    });

    ctx.restore();
  }

  function drawTextBody(ctx, shape, box, context) {
    const [x, y, w, h] = box;
    const scale = contextRenderScale(context);
    const fallbackSize = defaultSizeForPlaceholder(placeholderType(shape));
    const paras = paragraphStyles(shape, context, fallbackSize);
    if (!paras.length) return;

    const body = readBodyPr(shape, scale);
    const innerX = x + body.lIns;
    const innerY = y + body.tIns;
    const innerW = Math.max(1, w - body.lIns - body.rIns);
    const innerH = Math.max(1, h - body.tIns - body.bIns);

    // Approximate PowerPoint "shrink text on overflow" by scaling the whole
    // block down until it fits (or we hit a readable floor).
    let shrink = 1;
    let layout = layoutTextBody(ctx, paras, innerW, scale, shrink);
    let guard = 0;
    while (layout.totalHeight > innerH && shrink > 0.55 && guard < 10) {
      shrink -= 0.07;
      layout = layoutTextBody(ctx, paras, innerW, scale, shrink);
      guard += 1;
    }

    let cursorY = innerY;
    if (body.anchor === "ctr") {
      cursorY += Math.max(0, (innerH - layout.totalHeight) / 2);
    } else if (body.anchor === "b") {
      cursorY += Math.max(0, innerH - layout.totalHeight);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 1, y - 1, w + 2, h + 2);
    ctx.clip();
    ctx.textBaseline = "top";

    layout.lines.forEach((line) => {
      const avail = Math.max(1, innerW - line.indent);
      ctx.font = line.font;
      ctx.fillStyle = line.color;

      let drawX = innerX + line.indent;
      if (line.align === "ctr" || line.align === "center") {
        ctx.textAlign = "center";
        drawX = innerX + line.indent + avail / 2;
      } else if (line.align === "r" || line.align === "right") {
        ctx.textAlign = "right";
        drawX = innerX + line.indent + avail;
      } else {
        ctx.textAlign = "left";
      }

      if (line.bullet) {
        ctx.save();
        ctx.textAlign = "left";
        ctx.fillText(line.bullet, innerX + line.indent - line.bulletGap, cursorY);
        ctx.restore();
      }

      ctx.fillText(line.text, drawX, cursorY);
      cursorY += line.height;
    });

    ctx.restore();
  }

  function textFromShape(shape) {
    const paragraphs = descendants(shape, "p").map((paragraph) => {
      const parts = [];

      descendants(paragraph, "t").forEach((node) => {
        parts.push(node.textContent || "");
      });

      // Office math fallback
      descendants(paragraph, "oMath").forEach((math) => {
        const value = (math.textContent || "").trim();
        if (value) parts.push(value);
      });

      return parts.join("");
    });

    return paragraphs.filter(Boolean).join("\n").trim();
  }

  const POLYGON_GEOMETRY = { pentagon: 5, hexagon: 6, heptagon: 7, octagon: 8, decagon: 10 };
  const STAR_GEOMETRY = { star4: 4, star5: 5, star6: 6, star7: 7, star8: 8, star10: 10, star12: 12 };

  function drawRegularPolygon(ctx, x, y, w, h, sides) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    for (let index = 0; index < sides; index += 1) {
      const angle = -Math.PI / 2 + (index / sides) * Math.PI * 2;
      const px = cx + Math.cos(angle) * w / 2;
      const py = cy + Math.sin(angle) * h / 2;
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function drawStar(ctx, x, y, w, h, points) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const inner = 0.42;
    for (let index = 0; index < points * 2; index += 1) {
      const angle = -Math.PI / 2 + (index / (points * 2)) * Math.PI * 2;
      const radius = index % 2 === 0 ? 1 : inner;
      const px = cx + Math.cos(angle) * (w / 2) * radius;
      const py = cy + Math.sin(angle) * (h / 2) * radius;
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  async function renderShape(context, ctx, rels, shape, transform) {
    const spPr = child(shape, "spPr");
    const text = textFromShape(shape);
    const box = boxFor(context, shape, transform);
    const [x, y, w, h] = box;

    if (spPr) {
      const imageBlip = firstDesc(spPr, "blip");
      const mediaPath = rels.get(relId(imageBlip));
      if (mediaPath && context.package.has(mediaPath)) {
        try {
          const image = await loadMediaImage(context, mediaPath);
          drawBlipImage(ctx, shape, image, box);
        } catch (error) {
          console.warn("Could not render PPTX shape image", mediaPath, error);
        }
      }

      const noFill = !!child(spPr, "noFill");
      const solidFill = child(spPr, "solidFill");
      const gradFill = child(spPr, "gradFill");
      const fillNode = gradFill || solidFill;
      const ln = child(spPr, "ln");
      const noLine = ln && child(ln, "noFill");
      const lineFill = child(ln, "solidFill");
      const fill = !noFill ? fillStyle(ctx, fillNode, context.theme, box, DEFAULT_THEME.bg2) : null;
      const outline = !noLine && lineFill ? colorFromFill(lineFill, context.theme, DEFAULT_THEME.accent1) : null;
      const lineWidth = !noLine && ln ? Math.max(1, Math.round(attrNumber(ln, "w", 12700) / 12700)) : 1;
      const geom = firstDesc(spPr, "prstGeom")?.getAttribute("prst") || "rect";

      if (fill || outline) {
        ctx.save();
        ctx.fillStyle = fill || "transparent";
        ctx.strokeStyle = outline || "transparent";
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        if (geom === "ellipse" || geom === "arc") {
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        } else if (geom === "triangle" || geom === "rtTriangle") {
          ctx.moveTo(x + w / 2, y);
          ctx.lineTo(x + w, y + h);
          ctx.lineTo(x, y + h);
          ctx.closePath();
        } else if (geom === "line") {
          ctx.moveTo(x, y);
          ctx.lineTo(x + w, y + h);
        } else if (geom === "roundRect" || geom === "round1Rect" || geom === "round2SameRect") {
          const radius = Math.max(4, Math.min(w, h) / 14);
          ctx.roundRect(x, y, w, h, radius);
        } else if (geom === "diamond") {
          ctx.moveTo(x + w / 2, y);
          ctx.lineTo(x + w, y + h / 2);
          ctx.lineTo(x + w / 2, y + h);
          ctx.lineTo(x, y + h / 2);
          ctx.closePath();
        } else if (geom === "parallelogram") {
          const inset = w * 0.22;
          ctx.moveTo(x + inset, y);
          ctx.lineTo(x + w, y);
          ctx.lineTo(x + w - inset, y + h);
          ctx.lineTo(x, y + h);
          ctx.closePath();
        } else if (geom === "trapezoid") {
          const inset = w * 0.22;
          ctx.moveTo(x + inset, y);
          ctx.lineTo(x + w - inset, y);
          ctx.lineTo(x + w, y + h);
          ctx.lineTo(x, y + h);
          ctx.closePath();
        } else if (geom === "rightArrow") {
          const headW = w * 0.36;
          const shaft = h * 0.28;
          ctx.moveTo(x, y + h / 2 - shaft);
          ctx.lineTo(x + w - headW, y + h / 2 - shaft);
          ctx.lineTo(x + w - headW, y);
          ctx.lineTo(x + w, y + h / 2);
          ctx.lineTo(x + w - headW, y + h);
          ctx.lineTo(x + w - headW, y + h / 2 + shaft);
          ctx.lineTo(x, y + h / 2 + shaft);
          ctx.closePath();
        } else if (POLYGON_GEOMETRY[geom]) {
          drawRegularPolygon(ctx, x, y, w, h, POLYGON_GEOMETRY[geom]);
        } else if (STAR_GEOMETRY[geom]) {
          drawStar(ctx, x, y, w, h, STAR_GEOMETRY[geom]);
        } else {
          ctx.rect(x, y, w, h);
        }
        if (fill && geom !== "line") ctx.fill();
        if (outline || geom === "line") ctx.stroke();
        ctx.restore();
      }
    }

    if (text) {
      drawTextBody(ctx, shape, box, context);
    }
  }

  async function renderBackground(context, ctx, rels, root, fillDefault) {
    const bg = child(child(root, "cSld"), "bg");
    if (!bg) {
      if (fillDefault) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, context.outW, context.outH);
      }
      return;
    }

    const solid = firstDesc(bg, "solidFill");
    if (solid) {
      ctx.fillStyle = colorFromFill(solid, context.theme, DEFAULT_THEME.bg1);
      ctx.fillRect(0, 0, context.outW, context.outH);
    }

    const blip = firstDesc(bg, "blip");
    const mediaPath = rels.get(relId(blip));
    if (mediaPath && context.package.has(mediaPath)) {
      try {
        const image = await loadMediaImage(context, mediaPath);
        drawBlipImage(ctx, bg, image, [0, 0, context.outW, context.outH]);
      } catch (error) {
        console.warn("Could not render PPTX background image", mediaPath, error);
      }
    }
  }

  async function renderGraphicFrame(context, ctx, rels, node, transform) {
    const box = boxFor(context, node, transform);
    const [x, y, w, h] = box;

    const table = firstDesc(node, "tbl");
    if (table) {
      const rows = descendants(table, "tr");
      if (!rows.length) return;
      // Without a real box this would be slide-sized; skip rather than paint
      // over everything else on the slide.
      if (!hasResolvedXfrm(context, node)) return;

      const scale = contextRenderScale(context);
      // Column widths come from the grid, row heights from each row. Both are
      // proportional, so a table always fills exactly its own frame.
      const gridCols = descendants(firstDesc(table, "tblGrid"), "gridCol");
      const rawCols = gridCols.map((col) => Math.max(1, attrNumber(col, "w", 0)));
      const colTotal = rawCols.reduce((sum, value) => sum + value, 0);
      const colWidths = colTotal > 0 ? rawCols.map((value) => value / colTotal * w) : null;

      const rawRows = rows.map((row) => Math.max(1, attrNumber(row, "h", 0)));
      const rowTotal = rawRows.reduce((sum, value) => sum + value, 0);
      const rowHeights = rowTotal > 0
        ? rawRows.map((value) => value / rowTotal * h)
        : rows.map(() => h / rows.length);

      ctx.save();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.35)";
      ctx.lineWidth = Math.max(1, scale);

      let cy = y;
      rows.forEach((row, r) => {
        const cells = descendants(row, "tc");
        const rowH = rowHeights[r];
        const widths = colWidths && colWidths.length >= cells.length
          ? colWidths
          : cells.map(() => w / Math.max(1, cells.length));

        let cx = x;
        cells.forEach((cell, c) => {
          const colW = widths[c] != null ? widths[c] : (w / Math.max(1, cells.length));

          // Only fill when the cell actually asks for one.
          const cellFill = child(child(cell, "tcPr"), "solidFill");
          if (cellFill) {
            ctx.fillStyle = cssColor(
              colorFromFill(cellFill, context.theme, DEFAULT_THEME.bg2),
              alphaFromColorNode(cellFill)
            );
            ctx.fillRect(cx, cy, colW, rowH);
          }
          ctx.strokeRect(cx, cy, colW, rowH);

          const text = descendants(cell, "t")
            .map(t => t.textContent || "")
            .join("")
            .trim();

          if (text) {
            const sizeNode = firstDesc(cell, "rPr");
            const sizePx = (attrNumber(sizeNode, "sz", 1800) / 100) * (96 / 72) * scale;
            drawWrappedText(
              ctx,
              text,
              cx + 6 * scale,
              cy + 5 * scale,
              Math.max(1, colW - 12 * scale),
              Math.max(1, rowH - 10 * scale),
              cssColor(DEFAULT_THEME.tx1),
              sizePx,
              false
            );
          }
          cx += colW;
        });
        cy += rowH;
      });

      ctx.restore();
      return;
    }

    // Chart / SmartArt fallback box
    const fallbackText = descendants(node, "t")
      .map(t => t.textContent || "")
      .join(" ")
      .trim();

    if (fallbackText) {
      drawWrappedText(
        ctx,
        fallbackText,
        x + 8,
        y + 8,
        Math.max(1, w - 16),
        Math.max(1, h - 16),
        cssColor(DEFAULT_THEME.tx1),
        18,
        false
      );
    }
  }

  function isPlaceholder(node) {
    const nvSpPr = child(node, "nvSpPr");
    const nvPr = nvSpPr ? child(nvSpPr, "nvPr") : null;
    return !!(nvPr && child(nvPr, "ph"));
  }

  async function renderTree(context, ctx, rels, parent, transform, skipPlaceholders = false) {
    for (const node of Array.from(parent?.children || [])) {
      if (node.localName === "pic") {
        await renderPicture(context, ctx, rels, node, transform);
      } else if (node.localName === "sp") {
        // Master/layout placeholders only define formatting; their prompt text
        // ("Click to edit Master title style") must never paint onto a slide.
        if (skipPlaceholders && isPlaceholder(node)) continue;
        await renderShape(context, ctx, rels, node, transform);
      } else if (node.localName === "grpSp") {
        await renderTree(context, ctx, rels, node, childTransform(node, transform), skipPlaceholders);
      } else if (node.localName === "AlternateContent") {
        const fallback = child(node, "Fallback");
        const choice = child(node, "Choice");
        await renderTree(context, ctx, rels, fallback || choice, transform, skipPlaceholders);
      } else if (node.localName === "graphicFrame") {
        await renderGraphicFrame(context, ctx, rels, node, transform);
      } else if (node.localName === "cxnSp") {
        await renderShape(context, ctx, rels, node, transform);
      } else if (
        node.localName === "nvGrpSpPr" ||
        node.localName === "grpSpPr" ||
        node.localName === "nvSpPr" ||
        node.localName === "nvPicPr" ||
        node.localName === "nvCxnSpPr" ||
        node.localName === "nvGraphicFramePr"
      ) {
        continue;
      } else {
        console.warn("Unsupported PPTX node:", node.localName, node);
      }
    }
  }

  async function renderPart(context, ctx, partName, fillDefault = false, skipPlaceholders = false) {
    if (!partName || !context.package.has(partName)) return;
    const xml = await xmlPart(context, partName);
    const root = xml.documentElement;
    const rels = await relsForPart(context, partName);
    await renderBackground(context, ctx, rels, root, fillDefault);
    await renderTree(context, ctx, rels, child(child(root, "cSld"), "spTree"), { ox: 0, oy: 0, sx: 1, sy: 1 }, skipPlaceholders);
  }

  async function themePalette(packageFile) {
    const palette = { ...DEFAULT_THEME };
    const themeName = packageFile.list().find((name) => name.startsWith("ppt/theme/") && name.endsWith(".xml"));
    if (!themeName) return palette;

    try {
      const xml = parseXml(await packageFile.text(themeName));
      const clrScheme = firstDesc(xml, "clrScheme");
      Array.from(clrScheme?.children || []).forEach((item) => {
        const srgb = child(item, "srgbClr");
        const sys = child(item, "sysClr");
        if (srgb) palette[item.localName] = hexToRgb(srgb.getAttribute("val"), palette[item.localName] || DEFAULT_THEME.tx1);
        else if (sys) palette[item.localName] = hexToRgb(sys.getAttribute("lastClr"), palette[item.localName] || DEFAULT_THEME.tx1);
      });
    } catch (error) {
      console.warn("Could not read PPTX theme", error);
    }
    return palette;
  }

  async function createContext(packageFile) {
    if (!packageFile.has("ppt/presentation.xml")) {
      throw new Error("This PPTX is missing presentation.xml.");
    }

    const presentation = parseXml(await packageFile.text("ppt/presentation.xml"));
    const size = firstDesc(presentation, "sldSz");
    const slideCx = attrNumber(size, "cx", EMU_WIDE);
    const slideCy = attrNumber(size, "cy", EMU_HIGH);
    // PPTX stores the actual deck size in English Metric Units. Keep the
    // annotation coordinate system at its native 96-CSS-pixel size, while the
    // backing raster is capped below so huge custom pages cannot exhaust RAM.
    const nativeW = Math.max(1, slideCx / EMU_PER_INCH * CSS_PIXELS_PER_INCH);
    const nativeH = Math.max(1, slideCy / EMU_PER_INCH * CSS_PIXELS_PER_INCH);
    const renderSize = boundedRenderSize(nativeW, nativeH);
    const outW = renderSize.width;
    const outH = renderSize.height;
    const theme = await themePalette(packageFile);

    return {
      package: packageFile,
      presentation,
      slideCx,
      slideCy,
      nativeW,
      nativeH,
      outW,
      outH,
      theme,
      relsCache: new Map(),
      xmlCache: new Map(),
      imageCache: new Map()
    };
  }

  async function slideParts(context) {
    const presRels = await relsForPart(context, "ppt/presentation.xml");
    const ids = descendants(context.presentation, "sldId");
    const parts = ids.map((id) => presRels.get(relId(id))).filter(Boolean);
    if (parts.length) return parts;

    return context.package.list()
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  }

  function placeholderSlide(context, index) {
    const canvas = document.createElement("canvas");
    canvas.width = context.outW;
    canvas.height = context.outH;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.14)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    ctx.fillStyle = "#64748b";
    ctx.font = "600 30px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Rendering slide ${index + 1}...`, canvas.width / 2, canvas.height / 2);
    return {
      index,
      width: context.nativeW,
      height: context.nativeH,
      sourceWidthEmu: context.slideCx,
      sourceHeightEmu: context.slideCy,
      image: canvas.toDataURL("image/png"),
      paths: []
    };
  }

  async function renderSlide(context, partName, index) {
    const canvas = document.createElement("canvas");
    canvas.width = context.outW;
    canvas.height = context.outH;
    
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, context.outW, context.outH);
    
    const slideRels = await relsForPart(context, partName);
    const layoutPart = relatedPartByPrefix(slideRels, "ppt/slideLayouts/");
    const layoutRels = layoutPart ? await relsForPart(context, layoutPart) : new Map();
    const masterPart = relatedPartByPrefix(layoutRels, "ppt/slideMasters/");
    
    const masterPlaceholders = await collectPlaceholderXfrms(context, masterPart);
    const layoutPlaceholders = await collectPlaceholderXfrms(context, layoutPart);
    
    context.placeholderXfrms = new Map([
      ...masterPlaceholders,
      ...layoutPlaceholders
    ]);
  
    await renderPart(context, ctx, masterPart, false, true);
    await renderPart(context, ctx, layoutPart, false, true);
    await renderPart(context, ctx, partName, false);
  
    context.placeholderXfrms = null;
  
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    if (pixel[3] === 0) {
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, context.outW, context.outH);
      ctx.globalCompositeOperation = "source-over";
    }
  
    return {
      index,
      width: context.nativeW,
      height: context.nativeH,
      sourceWidthEmu: context.slideCx,
      sourceHeightEmu: context.slideCy,
      image: canvas.toDataURL("image/jpeg", 0.92),
      paths: []
    };
  }

  function yieldToUi() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  async function importPptxLocally(file, callbacks = {}) {
    if (!file?.name?.toLowerCase().endsWith(".pptx")) {
      throw new Error("Fast local import supports .pptx files.");
    }

    const packageFile = await openZip(file);
    const context = await createContext(packageFile);
    const parts = await slideParts(context);
    if (!parts.length) throw new Error("No slides were found in this PPTX.");

    const slides = parts.map((_, index) => placeholderSlide(context, index));
    let deckActivated = false;

    for (let index = 0; index < parts.length; index += 1) {
      const slide = await renderSlide(context, parts[index], index);
      slides[index] = slide;

      if (!deckActivated) {
        deckActivated = true;
        callbacks.onDeckReady?.({
          active: true,
          name: file.name,
          renderMode: "local",
          slides,
          currentSlide: 0
        });
      }

      callbacks.onSlideRendered?.(index, slide, parts.length);
      callbacks.onProgress?.(index + 1, parts.length);
      await yieldToUi();
    }

    return {
      active: true,
      name: file.name,
      renderMode: "local",
      slides,
      currentSlide: 0
    };
  }

  window.importPptxLocally = importPptxLocally;
})();

import base64
import gzip
import io
import json
import logging
import math
import os
import posixpath
import re
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
import zlib
from pathlib import Path
from xml.etree import ElementTree as ET

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename

try:
    # Hardened parser that rejects entity expansion / external entity tricks
    # in untrusted PPTX XML parts.
    from defusedxml.ElementTree import fromstring as _xml_fromstring
except Exception:  # pragma: no cover - defusedxml is optional
    _xml_fromstring = ET.fromstring

logger = logging.getLogger(__name__)

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:  # pragma: no cover - handled at runtime
    Image = None
    ImageDraw = None
    ImageFont = None

try:
    import fitz as _pymupdf  # PyMuPDF
except Exception:  # pragma: no cover - handled at runtime
    _pymupdf = None

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 120 * 1024 * 1024

# Every static URL in the templates carries a `v=` cache-busting parameter, so
# a stale copy is impossible: changing an asset changes its URL. Without this
# the default is 12 hours, which makes returning visitors re-download the whole
# editor - roughly 1.5 MB of JavaScript and CSS - twice a day for nothing.
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 31536000  # one year


# A one-year cache is only safe if the URL changes whenever the file does.
# The templates carry hand-written `v=` strings, which means a stale asset is
# one forgotten edit away - and with a year-long max-age that stale copy sticks
# for a year. Deriving the parameter from the file itself removes the chance to
# forget: every `url_for('static', ...)` gets a token computed from the file's
# size and modification time, overriding whatever the template asked for.
_STATIC_VERSIONS = {}


def _static_version(filename):
    cached = _STATIC_VERSIONS.get(filename)
    try:
        stat = os.stat(os.path.join(app.static_folder, filename))
    except OSError:
        # Missing file: let the URL through unversioned rather than break the page.
        return cached[1] if cached else None

    key = (stat.st_mtime_ns, stat.st_size)
    if cached and cached[0] == key:
        return cached[1]

    token = format(zlib.crc32(f"{stat.st_mtime_ns}:{stat.st_size}".encode()), "08x")
    _STATIC_VERSIONS[filename] = (key, token)
    return token


@app.url_defaults
def add_static_version(endpoint, values):
    if endpoint != "static" or "filename" not in values:
        return
    token = _static_version(values["filename"])
    if token:
        values["v"] = token

app.config["SECRET_KEY"] = os.environ.get(
    "SECRET_KEY",
    os.urandom(32).hex()
)

# Abuse limits: requests are already capped by MAX_CONTENT_LENGTH, but a small
# upload can still expand into something enormous (zip bombs, thousand-page
# PDFs, huge base64 payloads). These caps keep one request from exhausting the
# server.
MAX_PPTX_UNCOMPRESSED_BYTES = 400 * 1024 * 1024
MAX_PDF_PAGES = 300
MAX_EXPORT_SLIDES = 300
MAX_SLIDE_IMAGE_BYTES = 30 * 1024 * 1024
MAX_YOUTUBE_QUERY_CHARS = 200
MAX_YOUTUBE_SEARCH_RESULTS = 20
YOUTUBE_SEARCH_CACHE_TTL_SECONDS = 10 * 60
YOUTUBE_SEARCH_CACHE = {}

EMU_WIDE = 12192000
EMU_HIGH = 6858000
EMU_PER_INCH = 914400
CSS_PIXELS_PER_INCH = 96
MAX_PPT_RENDER_SIDE = 2048
MAX_PPT_RENDER_PIXELS = 4 * 1024 * 1024
PPT_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def natural_key(path):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def bounded_ppt_render_size(native_width, native_height):
    native_width = max(1, float(native_width))
    native_height = max(1, float(native_height))
    side_scale = min(
        1,
        MAX_PPT_RENDER_SIDE / native_width,
        MAX_PPT_RENDER_SIDE / native_height
    )
    pixel_scale = min(
        1,
        math.sqrt(MAX_PPT_RENDER_PIXELS / (native_width * native_height))
    )
    scale = min(side_scale, pixel_scale)
    return (
        max(1, round(native_width * scale)),
        max(1, round(native_height * scale))
    )


def data_url_from_image(path):
    raw = path.read_bytes()
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def pptx_tag(namespace, name):
    return f"{{{namespace}}}{name}"


def parse_xml(data):
    return _xml_fromstring(data)


def rels_for_part(package, part_name):
    base = posixpath.dirname(part_name)
    rels_name = posixpath.join(base, "_rels", posixpath.basename(part_name) + ".rels")
    if rels_name not in package.namelist():
        return {}

    root = parse_xml(package.read(rels_name))
    rels = {}
    for rel in root:
        rel_id = rel.attrib.get("Id")
        target = rel.attrib.get("Target")
        if not rel_id or not target:
            continue
        if target.startswith("/"):
            resolved = target.lstrip("/")
        else:
            resolved = posixpath.normpath(posixpath.join(base, target))
        rels[rel_id] = resolved
    return rels


def emu_value(node, attr, default=0):
    if node is None:
        return default
    try:
        return int(float(node.attrib.get(attr, default)))
    except Exception:
        return default


def xml_local_name(tag):
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


DEFAULT_PPTX_THEME = {
    "tx1": (17, 24, 39),
    "tx2": (31, 41, 55),
    "bg1": (255, 255, 255),
    "bg2": (248, 250, 252),
    "accent1": (79, 70, 229),
    "accent2": (22, 163, 74),
    "accent3": (234, 88, 12),
    "accent4": (220, 38, 38),
    "accent5": (8, 145, 178),
    "accent6": (147, 51, 234),
    "hlink": (37, 99, 235),
    "folHlink": (124, 58, 237),
}


def color_from_hex(value, fallback):
    if value and re.fullmatch(r"[0-9a-fA-F]{6}", value):
        return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
    return fallback


def apply_color_adjustments(rgb, color_node):
    if color_node is None:
        return rgb

    r, g, b = rgb
    for child in list(color_node):
        name = xml_local_name(child.tag)
        try:
            value = int(child.attrib.get("val", "100000"))
        except Exception:
            continue

        if name in {"shade", "lumMod"}:
            factor = value / 100000
            r, g, b = r * factor, g * factor, b * factor
        elif name in {"tint", "lumOff"}:
            factor = value / 100000
            r, g, b = (
                r + (255 - r) * factor,
                g + (255 - g) * factor,
                b + (255 - b) * factor,
            )

    return tuple(max(0, min(255, round(channel))) for channel in (r, g, b))


def pptx_theme_palette(package, names):
    palette = dict(DEFAULT_PPTX_THEME)
    theme_parts = sorted(name for name in names if name.startswith("ppt/theme/") and name.endswith(".xml"))
    if not theme_parts:
        return palette

    try:
        theme = parse_xml(package.read(theme_parts[0]))
    except Exception:
        return palette

    clr_scheme = theme.find(".//" + pptx_tag(A_NS, "clrScheme"))
    if clr_scheme is None:
        return palette

    for item in list(clr_scheme):
        key = xml_local_name(item.tag)
        srgb = item.find(pptx_tag(A_NS, "srgbClr"))
        sysclr = item.find(pptx_tag(A_NS, "sysClr"))
        if srgb is not None:
            palette[key] = color_from_hex(srgb.attrib.get("val"), palette.get(key, (31, 41, 55)))
        elif sysclr is not None:
            palette[key] = color_from_hex(sysclr.attrib.get("lastClr"), palette.get(key, (31, 41, 55)))

    return palette


def pptx_color_from_solid_fill(node, theme=None, fallback=(31, 41, 55)):
    if node is None:
        return fallback
    theme = theme or DEFAULT_PPTX_THEME

    srgb = node.find(".//" + pptx_tag(A_NS, "srgbClr"))
    if srgb is not None:
        return apply_color_adjustments(color_from_hex(srgb.attrib.get("val"), fallback), srgb)

    sysclr = node.find(".//" + pptx_tag(A_NS, "sysClr"))
    if sysclr is not None:
        return apply_color_adjustments(color_from_hex(sysclr.attrib.get("lastClr"), fallback), sysclr)

    scheme = node.find(".//" + pptx_tag(A_NS, "schemeClr"))
    if scheme is not None:
        base = theme.get(scheme.attrib.get("val"), fallback)
        return apply_color_adjustments(base, scheme)

    return fallback


def direct_xfrm(element):
    sp_pr = element.find(pptx_tag(PPT_NS, "spPr"))
    if sp_pr is not None:
        xfrm = sp_pr.find(pptx_tag(A_NS, "xfrm"))
        if xfrm is not None:
            return xfrm

    grp_pr = element.find(pptx_tag(PPT_NS, "grpSpPr"))
    if grp_pr is not None:
        return grp_pr.find(pptx_tag(A_NS, "xfrm"))

    return None


def pptx_box(element, transform, slide_cx, slide_cy, out_w, out_h):
    xfrm = direct_xfrm(element)
    off = xfrm.find(pptx_tag(A_NS, "off")) if xfrm is not None else None
    ext = xfrm.find(pptx_tag(A_NS, "ext")) if xfrm is not None else None
    x = emu_value(off, "x")
    y = emu_value(off, "y")
    w = emu_value(ext, "cx", slide_cx)
    h = emu_value(ext, "cy", slide_cy)

    slide_x = transform["ox"] + transform["sx"] * x
    slide_y = transform["oy"] + transform["sy"] * y
    slide_w = transform["sx"] * w
    slide_h = transform["sy"] * h

    return (
        round(slide_x / slide_cx * out_w),
        round(slide_y / slide_cy * out_h),
        max(1, round(slide_w / slide_cx * out_w)),
        max(1, round(slide_h / slide_cy * out_h)),
    )


def pptx_child_transform(group, parent):
    xfrm = direct_xfrm(group)
    if xfrm is None:
        return parent

    off = xfrm.find(pptx_tag(A_NS, "off"))
    ext = xfrm.find(pptx_tag(A_NS, "ext"))
    ch_off = xfrm.find(pptx_tag(A_NS, "chOff"))
    ch_ext = xfrm.find(pptx_tag(A_NS, "chExt"))

    x = emu_value(off, "x")
    y = emu_value(off, "y")
    w = max(1, emu_value(ext, "cx", 1))
    h = max(1, emu_value(ext, "cy", 1))
    ch_x = emu_value(ch_off, "x")
    ch_y = emu_value(ch_off, "y")
    ch_w = max(1, emu_value(ch_ext, "cx", w))
    ch_h = max(1, emu_value(ch_ext, "cy", h))

    sx = parent["sx"] * w / ch_w
    sy = parent["sy"] * h / ch_h

    return {
        "ox": parent["ox"] + parent["sx"] * x - sx * ch_x,
        "oy": parent["oy"] + parent["sy"] * y - sy * ch_y,
        "sx": sx,
        "sy": sy,
    }


def pptx_font(size_px):
    candidates = [
        r"C:\Windows\Fonts\aptos.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\calibri.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size_px)
            except Exception:
                pass
    return ImageFont.load_default()


def draw_wrapped_text(draw, box, text, fill, font):
    x, y, w, h = box
    words = text.replace("\r", "").split()
    if not words:
        return

    lines = []
    line = ""
    for word in words:
        test = f"{line} {word}".strip()
        bbox = draw.textbbox((0, 0), test, font=font)
        if bbox[2] - bbox[0] <= max(20, w) or not line:
            line = test
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)

    line_h = max(12, draw.textbbox((0, 0), "Ag", font=font)[3] + 4)
    max_lines = max(1, h // line_h)
    draw.multiline_text((x, y), "\n".join(lines[:max_lines]), fill=fill, font=font, spacing=4)


def crop_pptx_image(media, element):
    src_rect = element.find(".//" + pptx_tag(A_NS, "srcRect"))
    if src_rect is None:
        return media

    width, height = media.size
    left = int(width * int(src_rect.attrib.get("l", "0")) / 100000)
    top = int(height * int(src_rect.attrib.get("t", "0")) / 100000)
    right = int(width * (1 - int(src_rect.attrib.get("r", "0")) / 100000))
    bottom = int(height * (1 - int(src_rect.attrib.get("b", "0")) / 100000))

    if right <= left or bottom <= top:
        return media

    return media.crop((left, top, right, bottom))


def paste_pptx_image(canvas, media, box):
    x, y, w, h = box
    if w <= 0 or h <= 0:
        return

    media = media.resize((w, h), Image.LANCZOS)
    if media.mode in {"RGBA", "LA"}:
        canvas.paste(media, (x, y), media)
    else:
        canvas.paste(media.convert("RGB"), (x, y))


def render_pptx_picture(package, names, rels, element, canvas, transform, slide_cx, slide_cy, out_w, out_h):
    blip = element.find(".//" + pptx_tag(A_NS, "blip"))
    rel_id = blip.attrib.get(pptx_tag(R_NS, "embed")) if blip is not None else None
    media_path = rels.get(rel_id)
    if not media_path or media_path not in names:
        return

    try:
        with Image.open(io.BytesIO(package.read(media_path))) as media:
            media = crop_pptx_image(media, element).convert("RGBA")
            paste_pptx_image(canvas, media, pptx_box(element, transform, slide_cx, slide_cy, out_w, out_h))
    except Exception:
        return


def text_from_shape(shape):
    lines = []
    for paragraph in shape.findall(".//" + pptx_tag(A_NS, "p")):
        parts = [node.text for node in paragraph.findall(".//" + pptx_tag(A_NS, "t")) if node.text]
        if parts:
            lines.append("".join(parts))
    return "\n".join(lines).strip()


def text_color_from_shape(shape, theme):
    for rpr in shape.findall(".//" + pptx_tag(A_NS, "rPr")):
        solid = rpr.find(pptx_tag(A_NS, "solidFill"))
        if solid is not None:
            return pptx_color_from_solid_fill(solid, theme, (17, 24, 39))
    return (17, 24, 39)


def render_pptx_shape(package, names, rels, canvas, draw, shape, theme, transform, slide_cx, slide_cy, out_w, out_h):
    x, y, w, h = pptx_box(shape, transform, slide_cx, slide_cy, out_w, out_h)
    sp_pr = shape.find(pptx_tag(PPT_NS, "spPr"))
    text = text_from_shape(shape)

    if sp_pr is not None:
        blip = sp_pr.find(".//" + pptx_tag(A_NS, "blip"))
        rel_id = blip.attrib.get(pptx_tag(R_NS, "embed")) if blip is not None else None
        media_path = rels.get(rel_id)
        if media_path and media_path in names:
            try:
                with Image.open(io.BytesIO(package.read(media_path))) as media:
                    media = crop_pptx_image(media, shape).convert("RGBA")
                    paste_pptx_image(canvas, media, (x, y, w, h))
            except Exception:
                pass

        geom = sp_pr.find(".//" + pptx_tag(A_NS, "prstGeom"))
        geom_type = geom.attrib.get("prst", "rect") if geom is not None else "rect"
        fill_node = sp_pr.find(pptx_tag(A_NS, "solidFill")) or sp_pr.find(pptx_tag(A_NS, "gradFill"))
        no_fill = sp_pr.find(pptx_tag(A_NS, "noFill")) is not None
        line_node = sp_pr.find(pptx_tag(A_NS, "ln"))
        line_fill = line_node.find(pptx_tag(A_NS, "solidFill")) if line_node is not None else None
        no_line = line_node is not None and line_node.find(pptx_tag(A_NS, "noFill")) is not None

        fill = pptx_color_from_solid_fill(fill_node, theme, (248, 250, 252)) if fill_node is not None and not no_fill else None
        outline = pptx_color_from_solid_fill(line_fill, theme, (79, 70, 229)) if line_fill is not None and not no_line else None
        line_w = max(1, round(emu_value(line_node, "w", 12700) / 12700)) if line_node is not None and not no_line else 1

        if fill or outline:
            box = (x, y, x + w, y + h)
            if geom_type in {"ellipse", "arc"}:
                draw.ellipse(box, fill=fill, outline=outline, width=line_w)
            elif geom_type in {"triangle", "rtTriangle"}:
                draw.polygon([(x + w / 2, y), (x + w, y + h), (x, y + h)], fill=fill, outline=outline)
            elif geom_type in {"line"}:
                draw.line((x, y, x + w, y + h), fill=outline or fill or (31, 41, 55), width=line_w)
            else:
                radius = 0 if geom_type not in {"roundRect"} else max(0, min(w, h) // 14)
                draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=line_w)

    if text:
        rpr = shape.find(".//" + pptx_tag(A_NS, "rPr"))
        raw_size = emu_value(rpr, "sz", 2600)
        font_size = max(12, min(120, round(raw_size / 100 * 96 / 72)))
        font = pptx_font(font_size)
        draw_wrapped_text(
            draw,
            (x + 12, y + 10, max(1, w - 24), max(1, h - 20)),
            text,
            text_color_from_shape(shape, theme),
            font
        )


def render_pptx_background(package, names, rels, slide, canvas, draw, theme, out_w, out_h, fill_default=False):
    bg = slide.find("./" + pptx_tag(PPT_NS, "cSld") + "/" + pptx_tag(PPT_NS, "bg"))
    if bg is None:
        if fill_default:
            draw.rectangle((0, 0, out_w, out_h), fill=theme.get("bg1", (255, 255, 255)))
        return

    bg_pr = bg.find(pptx_tag(PPT_NS, "bgPr"))
    solid = bg.find(".//" + pptx_tag(A_NS, "solidFill"))
    if solid is not None:
        draw.rectangle((0, 0, out_w, out_h), fill=pptx_color_from_solid_fill(solid, theme, (255, 255, 255)))

    blip = bg.find(".//" + pptx_tag(A_NS, "blip"))
    rel_id = blip.attrib.get(pptx_tag(R_NS, "embed")) if blip is not None else None
    media_path = rels.get(rel_id)
    if media_path and media_path in names:
        try:
            with Image.open(io.BytesIO(package.read(media_path))) as media:
                paste_pptx_image(canvas, media.convert("RGBA"), (0, 0, out_w, out_h))
        except Exception:
            pass


def render_pptx_tree(package, names, rels, parent, canvas, draw, theme, transform, slide_cx, slide_cy, out_w, out_h):
    for child in list(parent):
        name = xml_local_name(child.tag)
        if name == "pic":
            render_pptx_picture(package, names, rels, child, canvas, transform, slide_cx, slide_cy, out_w, out_h)
        elif name == "sp":
            render_pptx_shape(package, names, rels, canvas, draw, child, theme, transform, slide_cx, slide_cy, out_w, out_h)
        elif name == "grpSp":
            render_pptx_tree(
                package,
                names,
                rels,
                child,
                canvas,
                draw,
                theme,
                pptx_child_transform(child, transform),
                slide_cx,
                slide_cy,
                out_w,
                out_h
            )


def related_part_by_prefix(rels, prefix):
    for target in rels.values():
        if target.startswith(prefix):
            return target
    return None


def render_pptx_part(package, names, part_name, canvas, draw, theme, slide_cx, slide_cy, out_w, out_h):
    if not part_name or part_name not in names:
        return

    try:
        part = parse_xml(package.read(part_name))
    except Exception:
        return

    rels = rels_for_part(package, part_name)
    render_pptx_background(package, names, rels, part, canvas, draw, theme, out_w, out_h)
    sp_tree = part.find("./" + pptx_tag(PPT_NS, "cSld") + "/" + pptx_tag(PPT_NS, "spTree"))
    if sp_tree is not None:
        render_pptx_tree(
            package,
            names,
            rels,
            sp_tree,
            canvas,
            draw,
            theme,
            {"ox": 0, "oy": 0, "sx": 1, "sy": 1},
            slide_cx,
            slide_cy,
            out_w,
            out_h
        )


def convert_pptx_basic(source_path, output_dir):
    if Image is None:
        raise RuntimeError("Basic PPTX import needs Pillow installed.")

    with zipfile.ZipFile(source_path) as package:
        total_uncompressed = sum(info.file_size for info in package.infolist())
        if total_uncompressed > MAX_PPTX_UNCOMPRESSED_BYTES:
            raise RuntimeError("This PPTX expands to too much data to import safely.")

        names = set(package.namelist())
        if "ppt/presentation.xml" not in names:
            raise RuntimeError("This PPTX file is missing presentation.xml.")

        presentation = parse_xml(package.read("ppt/presentation.xml"))
        size_node = presentation.find(".//" + pptx_tag(PPT_NS, "sldSz"))
        slide_cx = emu_value(size_node, "cx", EMU_WIDE)
        slide_cy = emu_value(size_node, "cy", EMU_HIGH)
        native_width = slide_cx / EMU_PER_INCH * CSS_PIXELS_PER_INCH
        native_height = slide_cy / EMU_PER_INCH * CSS_PIXELS_PER_INCH
        out_w, out_h = bounded_ppt_render_size(native_width, native_height)
        theme = pptx_theme_palette(package, names)

        pres_rels = rels_for_part(package, "ppt/presentation.xml")
        slide_ids = presentation.findall(".//" + pptx_tag(PPT_NS, "sldId"))
        slide_parts = []
        for slide_id in slide_ids:
            rel_id = slide_id.attrib.get(pptx_tag(R_NS, "id"))
            target = pres_rels.get(rel_id)
            if target and target in names:
                slide_parts.append(target)

        if not slide_parts:
            slide_parts = sorted(
                [name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)],
                key=lambda item: natural_key(Path(item))
            )

        output_paths = []
        for index, slide_part in enumerate(slide_parts, start=1):
            slide = parse_xml(package.read(slide_part))
            rels = rels_for_part(package, slide_part)
            image = Image.new("RGB", (out_w, out_h), "white")
            draw = ImageDraw.Draw(image)

            layout_part = related_part_by_prefix(rels, "ppt/slideLayouts/")
            layout_rels = rels_for_part(package, layout_part) if layout_part else {}
            master_part = related_part_by_prefix(layout_rels, "ppt/slideMasters/")

            render_pptx_part(package, names, master_part, image, draw, theme, slide_cx, slide_cy, out_w, out_h)
            render_pptx_part(package, names, layout_part, image, draw, theme, slide_cx, slide_cy, out_w, out_h)
            render_pptx_background(package, names, rels, slide, image, draw, theme, out_w, out_h)

            sp_tree = slide.find("./" + pptx_tag(PPT_NS, "cSld") + "/" + pptx_tag(PPT_NS, "spTree"))
            if sp_tree is not None:
                render_pptx_tree(
                    package,
                    names,
                    rels,
                    sp_tree,
                    image,
                    draw,
                    theme,
                    {"ox": 0, "oy": 0, "sx": 1, "sy": 1},
                    slide_cx,
                    slide_cy,
                    out_w,
                    out_h
                )

            output_path = output_dir / f"slide{index}.png"
            image.save(output_path, "PNG")
            output_paths.append(output_path)

    if not output_paths:
        raise RuntimeError("No slides could be rendered from this PPTX.")

    return output_paths, slide_cx, slide_cy


def decode_image_data(data_url):
    if not isinstance(data_url, str) or "," not in data_url:
        raise ValueError("Invalid slide image data")
    _, payload = data_url.split(",", 1)
    # base64 inflates by ~4/3, so cap the encoded payload accordingly.
    if len(payload) > MAX_SLIDE_IMAGE_BYTES * 4 // 3 + 4:
        raise ValueError("Slide image is too large")
    return base64.b64decode(payload)


def normalize_export_slide(slide_data):
    descriptor = slide_data if isinstance(slide_data, dict) else {}
    data_url = descriptor.get("image") if descriptor else slide_data
    image_bytes = decode_image_data(data_url)

    width = descriptor.get("width")
    height = descriptor.get("height")
    try:
        width = float(width)
        height = float(height)
    except (TypeError, ValueError):
        width = 0
        height = 0

    if not math.isfinite(width) or width <= 0:
        width = 0
    if not math.isfinite(height) or height <= 0:
        height = 0

    source_width_emu = descriptor.get("sourceWidthEmu")
    source_height_emu = descriptor.get("sourceHeightEmu")
    try:
        source_width_emu = float(source_width_emu)
        source_height_emu = float(source_height_emu)
    except (TypeError, ValueError):
        source_width_emu = 0
        source_height_emu = 0

    if not math.isfinite(source_width_emu) or source_width_emu <= 0:
        source_width_emu = 0
    if not math.isfinite(source_height_emu) or source_height_emu <= 0:
        source_height_emu = 0

    return {
        "image": image_bytes,
        "width": width,
        "height": height,
        "unit": "pt" if descriptor.get("unit") == "pt" else "px",
        "source_width_emu": source_width_emu,
        "source_height_emu": source_height_emu
    }


def convert_ppt_with_powerpoint(source_path, output_dir):
    try:
        import pythoncom
        import win32com.client
    except Exception as exc:
        raise RuntimeError("PowerPoint automation is not available on this machine.") from exc

    pythoncom.CoInitialize()
    app_obj = None
    presentation = None

    try:
        app_obj = win32com.client.DispatchEx("PowerPoint.Application")
        app_obj.DisplayAlerts = 0
        try:
            # msoAutomationSecurityForceDisable: never run macros in untrusted uploads.
            app_obj.AutomationSecurity = 3
        except Exception:
            logger.warning("Could not force-disable PowerPoint macro execution.")
        presentation = app_obj.Presentations.Open(
            str(source_path),
            ReadOnly=True,
            Untitled=False,
            WithWindow=False
        )

        slide_width = float(presentation.PageSetup.SlideWidth)
        slide_height = float(presentation.PageSetup.SlideHeight)
        # PowerPoint exposes the native page size in points. Export at 96 DPI
        # so the browser and server import paths use the same coordinates.
        native_width = slide_width / 72 * CSS_PIXELS_PER_INCH
        native_height = slide_height / 72 * CSS_PIXELS_PER_INCH
        export_width, export_height = bounded_ppt_render_size(native_width, native_height)
        presentation.Export(str(output_dir), "PNG", export_width, export_height)
    finally:
        if presentation is not None:
            presentation.Close()
        if app_obj is not None:
            app_obj.Quit()
        pythoncom.CoUninitialize()

    slide_paths = sorted(output_dir.glob("*.PNG"), key=natural_key)
    if not slide_paths:
        slide_paths = sorted(output_dir.glob("*.png"), key=natural_key)
    if not slide_paths:
        raise RuntimeError("PowerPoint did not export any slide images.")

    return (
        slide_paths,
        round(slide_width * EMU_PER_INCH / 72),
        round(slide_height * EMU_PER_INCH / 72)
    )


def simple_xml_header():
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'


def build_content_types(slide_count):
    slide_overrides = "".join(
        f'<Override PartName="/ppt/slides/slide{i}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for i in range(1, slide_count + 1)
    )
    return (
        simple_xml_header() +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        f'{slide_overrides}'
        '</Types>'
    )


def build_root_rels():
    return (
        simple_xml_header() +
        f'<Relationships xmlns="{PKG_REL_NS}">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        '</Relationships>'
    )


def build_presentation_xml(slide_count, slide_size):
    slide_ids = "".join(
        f'<p:sldId id="{255 + i}" r:id="rId{i}"/>' for i in range(1, slide_count + 1)
    )
    return (
        simple_xml_header() +
        f'<p:presentation xmlns:a="{A_NS}" xmlns:r="{R_NS}" xmlns:p="{PPT_NS}">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>'
        f'<p:sldIdLst>{slide_ids}</p:sldIdLst>'
        f'<p:sldSz cx="{slide_size["width"]}" cy="{slide_size["height"]}" type="custom"/>'
        '<p:notesSz cx="6858000" cy="9144000"/>'
        '</p:presentation>'
    )


def build_presentation_rels(slide_count):
    slide_rels = "".join(
        f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>'
        for i in range(1, slide_count + 1)
    )
    return (
        simple_xml_header() +
        f'<Relationships xmlns="{PKG_REL_NS}">'
        f'{slide_rels}'
        '<Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
        '</Relationships>'
    )


def build_slide_xml(index, placement):
    return (
        simple_xml_header() +
        f'<p:sld xmlns:a="{A_NS}" xmlns:r="{R_NS}" xmlns:p="{PPT_NS}">'
        '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>'
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        '<p:pic>'
        f'<p:nvPicPr><p:cNvPr id="2" name="Inkyscib slide {index}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
        '<p:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        f'<p:spPr><a:xfrm><a:off x="{placement["x"]}" y="{placement["y"]}"/>'
        f'<a:ext cx="{placement["width"]}" cy="{placement["height"]}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        '</p:pic>'
        '</p:spTree></p:cSld>'
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
        '</p:sld>'
    )


def build_slide_rels(index):
    return (
        simple_xml_header() +
        f'<Relationships xmlns="{PKG_REL_NS}">'
        f'<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image{index}.png"/>'
        '<Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
        '</Relationships>'
    )


def build_slide_master_xml():
    return (
        simple_xml_header() +
        f'<p:sldMaster xmlns:a="{A_NS}" xmlns:r="{R_NS}" xmlns:p="{PPT_NS}">'
        '<p:cSld><p:spTree>'
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        '</p:spTree></p:cSld>'
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout"/></p:sldLayoutIdLst>'
        '</p:sldMaster>'
    )


def build_slide_master_rels():
    return (
        simple_xml_header() +
        f'<Relationships xmlns="{PKG_REL_NS}">'
        '<Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
        '<Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>'
        '</Relationships>'
    )


def build_slide_layout_xml():
    return (
        simple_xml_header() +
        f'<p:sldLayout xmlns:a="{A_NS}" xmlns:r="{R_NS}" xmlns:p="{PPT_NS}" type="blank" preserve="1">'
        '<p:cSld name="Blank"><p:spTree>'
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        '</p:spTree></p:cSld>'
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
        '</p:sldLayout>'
    )


def build_slide_layout_rels():
    return (
        simple_xml_header() +
        f'<Relationships xmlns="{PKG_REL_NS}">'
        '<Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
        '</Relationships>'
    )


def build_theme_xml():
    return (
        simple_xml_header() +
        f'<a:theme xmlns:a="{A_NS}" name="Inkyscib">'
        '<a:themeElements><a:clrScheme name="Inkyscib">'
        '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
        '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
        '<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>'
        '<a:accent1><a:srgbClr val="5A5AFF"/></a:accent1><a:accent2><a:srgbClr val="22C55E"/></a:accent2>'
        '<a:accent3><a:srgbClr val="F59E0B"/></a:accent3><a:accent4><a:srgbClr val="EF4444"/></a:accent4>'
        '<a:accent5><a:srgbClr val="06B6D4"/></a:accent5><a:accent6><a:srgbClr val="A855F7"/></a:accent6>'
        '<a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>'
        '</a:clrScheme><a:fontScheme name="Inkyscib"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme>'
        '<a:fmtScheme name="Inkyscib"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
        '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
        '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
        '</a:themeElements></a:theme>'
    )


def build_doc_props(slide_count):
    app_xml = (
        simple_xml_header() +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        '<Application>Inkyscib</Application>'
        f'<Slides>{slide_count}</Slides>'
        '</Properties>'
    )
    core_xml = (
        simple_xml_header() +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<dc:title>Inkyscib annotated presentation</dc:title>'
        '<dc:creator>Inkyscib</dc:creator>'
        '</cp:coreProperties>'
    )
    return app_xml, core_xml


def export_slide_dimensions(slide):
    width = slide.get("width") or 0
    height = slide.get("height") or 0
    if width > 0 and height > 0:
        return width, height

    if Image is not None:
        with Image.open(io.BytesIO(slide["image"])) as image:
            return max(1, image.width), max(1, image.height)
    return 1920, 1080


def pptx_slide_size(slide):
    if slide.get("source_width_emu", 0) > 0 and slide.get("source_height_emu", 0) > 0:
        return {
            "width": round(slide["source_width_emu"]),
            "height": round(slide["source_height_emu"])
        }
    width, height = export_slide_dimensions(slide)
    emu_per_unit = EMU_PER_INCH / (72 if slide.get("unit") == "pt" else CSS_PIXELS_PER_INCH)
    return {
        "width": max(1, round(width * emu_per_unit)),
        "height": max(1, round(height * emu_per_unit))
    }


def pptx_image_placement(slide, slide_size):
    if slide.get("source_width_emu", 0) > 0 and slide.get("source_height_emu", 0) > 0:
        return {
            "x": 0,
            "y": 0,
            "width": slide_size["width"],
            "height": slide_size["height"]
        }
    width, height = export_slide_dimensions(slide)
    image_aspect = width / height
    slide_aspect = slide_size["width"] / slide_size["height"]

    if image_aspect >= slide_aspect:
        placed_width = slide_size["width"]
        placed_height = max(1, round(placed_width / image_aspect))
    else:
        placed_height = slide_size["height"]
        placed_width = max(1, round(placed_height * image_aspect))

    return {
        "x": round((slide_size["width"] - placed_width) / 2),
        "y": round((slide_size["height"] - placed_height) / 2),
        "width": placed_width,
        "height": placed_height
    }


def build_image_pptx(slides):
    output = io.BytesIO()
    slide_size = pptx_slide_size(slides[0])
    app_xml, core_xml = build_doc_props(len(slides))

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", build_content_types(len(slides)))
        package.writestr("_rels/.rels", build_root_rels())
        package.writestr("docProps/app.xml", app_xml)
        package.writestr("docProps/core.xml", core_xml)
        package.writestr("ppt/presentation.xml", build_presentation_xml(len(slides), slide_size))
        package.writestr("ppt/_rels/presentation.xml.rels", build_presentation_rels(len(slides)))
        package.writestr("ppt/slideMasters/slideMaster1.xml", build_slide_master_xml())
        package.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", build_slide_master_rels())
        package.writestr("ppt/slideLayouts/slideLayout1.xml", build_slide_layout_xml())
        package.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", build_slide_layout_rels())
        package.writestr("ppt/theme/theme1.xml", build_theme_xml())

        for index, slide in enumerate(slides, start=1):
            placement = pptx_image_placement(slide, slide_size)
            package.writestr(f"ppt/slides/slide{index}.xml", build_slide_xml(index, placement))
            package.writestr(f"ppt/slides/_rels/slide{index}.xml.rels", build_slide_rels(index))
            package.writestr(f"ppt/media/image{index}.png", slide["image"])

    output.seek(0)
    return output


def clean_download_name(name, suffix):
    stem = secure_filename(Path(name or "inkyscib-presentation").stem) or "inkyscib-presentation"
    return f"{stem}{suffix}"


# Every external origin the app legitimately talks to. Tighten here if a
# feature (analytics, AR hand tracking, YouTube player) is ever removed.
CONTENT_SECURITY_POLICY = "; ".join([
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    # 'unsafe-inline' is required by the inline scripts in the templates;
    # 'wasm-unsafe-eval' is required by MediaPipe Hands (AR) and PDF.js.
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' "
    "https://*.googletagmanager.com https://cdn.jsdelivr.net https://www.youtube.com",
    # The homepage sets its type in Inter, served from Google Fonts; the font
    # files themselves come from the gstatic origin allowed in font-src.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    # data: covers imported slide images; the rest are YouTube thumbnails,
    # the icons8 brand mark, and analytics pixels.
    "img-src 'self' data: blob: https://img.icons8.com https://*.ytimg.com "
    "https://img.youtube.com https://*.google-analytics.com https://*.googletagmanager.com",
    # GA4 can post collection events to the bare analytics.google.com origin.
    # A CSP subdomain wildcard does not cover the bare origin itself.
    "connect-src 'self' https://*.google-analytics.com https://analytics.google.com "
    "https://*.analytics.google.com https://*.googletagmanager.com https://cdn.jsdelivr.net",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    # data: covers the pomodoro alarm chime.
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    # Intentionally permissive: Inkyscib is meant to be embeddable on any
    # site. The trade-off is clickjacking exposure, accepted by design since
    # the app holds no user accounts or sensitive state.
    "frame-ancestors *",
])


# Text assets dominate the first load: the editor ships about 1.2 MB of
# JavaScript and 175 KB of CSS, and none of it was compressed on the way out.
# gzip takes that to roughly a fifth. Flask has no built-in compression and the
# app has no reverse proxy guaranteed in front of it, so it is done here.
COMPRESSIBLE_MIMETYPES = frozenset([
    "text/html",
    "text/css",
    "text/plain",
    "text/xml",
    "application/javascript",
    "text/javascript",
    "application/json",
    "image/svg+xml",
])
COMPRESS_MIN_BYTES = 1024
# Compressing the same 175 KB stylesheet on every request is wasted CPU: the
# static assets never change without their URL changing. Keyed by the strong
# ETag Werkzeug derives from the file's path, mtime and size, so a rebuilt file
# is a different key.
COMPRESSED_STATIC_CACHE = {}
COMPRESSED_STATIC_CACHE_MAX_ENTRIES = 64
COMPRESSED_STATIC_CACHE_MAX_BYTES = 4 * 1024 * 1024


def _should_compress(response):
    if response.status_code != 200:
        return False
    # Already encoded, either by us on an earlier pass or by something upstream.
    if response.headers.get("Content-Encoding"):
        return False
    if response.mimetype not in COMPRESSIBLE_MIMETYPES:
        return False
    if "gzip" not in request.headers.get("Accept-Encoding", "").lower():
        return False
    return response.content_length is not None and response.content_length >= COMPRESS_MIN_BYTES


def _gzip_bytes(payload):
    buffer = io.BytesIO()
    # Level 6 is the point where gzip stops buying much for the CPU it costs.
    with gzip.GzipFile(fileobj=buffer, mode="wb", compresslevel=6, mtime=0) as stream:
        stream.write(payload)
    return buffer.getvalue()


@app.after_request
def compress_response(response):
    # Announced regardless of whether this particular response was compressed,
    # so a shared cache never serves a gzipped body to a client that cannot
    # read it.
    vary = response.headers.get("Vary")
    if not vary:
        response.headers["Vary"] = "Accept-Encoding"
    elif "accept-encoding" not in vary.lower():
        response.headers["Vary"] = vary + ", Accept-Encoding"

    if not _should_compress(response):
        return response

    cache_key = response.headers.get("ETag")
    cached = COMPRESSED_STATIC_CACHE.get(cache_key) if cache_key else None
    if cached is not None:
        compressed, original_length = cached
    else:
        # Static files are sent straight from disk without buffering, so the
        # body has to be pulled into memory before it can be compressed.
        if response.direct_passthrough:
            response.direct_passthrough = False
        try:
            payload = response.get_data()
        except (RuntimeError, OSError):
            return response

        compressed = _gzip_bytes(payload)
        original_length = len(payload)

        if (cache_key
                and len(compressed) <= COMPRESSED_STATIC_CACHE_MAX_BYTES
                and len(COMPRESSED_STATIC_CACHE) < COMPRESSED_STATIC_CACHE_MAX_ENTRIES):
            COMPRESSED_STATIC_CACHE[cache_key] = (compressed, original_length)

    # Small or already-dense payloads can grow; keep the original in that case.
    if len(compressed) >= original_length:
        return response

    response.set_data(compressed)
    response.headers["Content-Encoding"] = "gzip"
    response.headers["Content-Length"] = str(len(compressed))
    # The body changed, so any strong validator computed from the original no
    # longer describes what is being sent.
    etag = response.headers.get("ETag")
    if etag and not etag.startswith("W/"):
        response.headers["ETag"] = 'W/' + etag

    return response


@app.after_request
def set_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

    # Allow camera only for Inkyscib itself, block microphone
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"

    # IMPORTANT:
    # Do NOT set X-Frame-Options, because it blocks iframe embedding.
    response.headers.pop("X-Frame-Options", None)

    response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY

    if request.is_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

    return response


@app.route("/")
def home():
    return render_template("home.html", nav_active="home")


@app.route("/features")
def features():
    return render_template("features.html", nav_active="features")


@app.route("/about")
def about():
    return render_template("about.html", nav_active="about")


@app.route("/write")
def write():
    return render_template("write.html")


@app.errorhandler(404)
def not_found(_error):
    return render_template("404.html"), 404


def _json_object_after_markers(source, markers):
    """Return the first valid JSON object following any marker.

    YouTube changes the assignment around ``ytInitialData`` regularly. A
    string-aware brace scanner is safer than a non-greedy regex because titles
    and tracking payloads can themselves contain braces.
    """
    for marker in markers:
        marker_index = source.find(marker)
        while marker_index != -1:
            start = source.find("{", marker_index + len(marker))
            if start == -1:
                break

            depth = 0
            in_string = False
            escaped = False
            for index in range(start, len(source)):
                character = source[index]
                if in_string:
                    if escaped:
                        escaped = False
                    elif character == "\\":
                        escaped = True
                    elif character == '"':
                        in_string = False
                    continue

                if character == '"':
                    in_string = True
                elif character == "{":
                    depth += 1
                elif character == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(source[start:index + 1])
                        except (TypeError, ValueError):
                            break

            marker_index = source.find(marker, marker_index + len(marker))
    return None


def _youtube_text(value, fallback=""):
    if not isinstance(value, dict):
        return fallback
    simple = value.get("simpleText")
    if isinstance(simple, str) and simple.strip():
        return simple.strip()
    runs = value.get("runs")
    if isinstance(runs, list):
        text = "".join(
            run.get("text", "") for run in runs if isinstance(run, dict)
        ).strip()
        if text:
            return text
    return fallback


def _youtube_video_renderers(value):
    if isinstance(value, dict):
        renderer = value.get("videoRenderer")
        if isinstance(renderer, dict):
            yield renderer
        for child in value.values():
            yield from _youtube_video_renderers(child)
    elif isinstance(value, list):
        for child in value:
            yield from _youtube_video_renderers(child)


def _parse_youtube_search_html(html, include_status=False):
    data = _json_object_after_markers(
        html,
        (
            'window["ytInitialData"]',
            "window['ytInitialData']",
            "var ytInitialData",
            "ytInitialData",
        ),
    )
    if not data:
        return ([], False) if include_status else []

    videos = []
    seen = set()
    for renderer in _youtube_video_renderers(data):
        video_id = renderer.get("videoId", "")
        if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            continue
        if video_id in seen:
            continue

        title = _youtube_text(renderer.get("title"))
        if not title:
            continue

        thumbnails = renderer.get("thumbnail", {}).get("thumbnails", [])
        thumbnail_url = next(
            (
                thumbnail.get("url")
                for thumbnail in reversed(thumbnails)
                if isinstance(thumbnail, dict) and thumbnail.get("url")
            ),
            None,
        )
        channel_name = _youtube_text(renderer.get("ownerText")) or _youtube_text(
            renderer.get("longBylineText")
        )
        duration = _youtube_text(renderer.get("lengthText"), "Video")
        videos.append({
            "id": video_id,
            "title": title,
            "thumbnail": thumbnail_url or f"https://img.youtube.com/vi/{video_id}/0.jpg",
            "channel": channel_name or "Unknown Channel",
            "duration": duration,
        })
        seen.add(video_id)
        if len(videos) >= MAX_YOUTUBE_SEARCH_RESULTS:
            break
    return (videos, True) if include_status else videos


def _search_youtube_result(query):
    cache_key = " ".join(query.casefold().split())
    cached = YOUTUBE_SEARCH_CACHE.get(cache_key)
    if cached and time.monotonic() - cached[0] < YOUTUBE_SEARCH_CACHE_TTL_SECONDS:
        return cached[1], True

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+410",
    }
    url = f"https://www.youtube.com/results?search_query={urllib.parse.quote_plus(query)}&hl=en"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            html = response.read().decode("utf-8", errors="replace")
    except Exception:
        logger.warning("Error fetching YouTube search results", exc_info=True)
        return (cached[1], True) if cached else ([], False)

    videos, available = _parse_youtube_search_html(html, include_status=True)
    if videos:
        YOUTUBE_SEARCH_CACHE[cache_key] = (time.monotonic(), videos)
        while len(YOUTUBE_SEARCH_CACHE) > 128:
            YOUTUBE_SEARCH_CACHE.pop(next(iter(YOUTUBE_SEARCH_CACHE)))
    return videos, available


def search_youtube(query):
    return _search_youtube_result(query)[0]


@app.route("/api/youtube/search")
def youtube_search():
    query = request.args.get("q", "").strip()[:MAX_YOUTUBE_QUERY_CHARS]
    if not query:
        return jsonify([])
    videos, available = _search_youtube_result(query)
    response = jsonify(videos)
    response.headers["X-Inkyscib-YouTube-Status"] = "ok" if available else "unavailable"
    return response


def _fetch_storyboard_spec(video_id):
    """Fetch and parse storyboard metadata from a YouTube video page.

    Returns a list of storyboard layers, each containing the URL template,
    frame dimensions, grid layout, count, and interval. The highest-resolution
    layer (last) is the most useful for frame capture.
    """
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
    }
    url = f"https://www.youtube.com/watch?v={urllib.parse.quote(video_id)}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=8) as response:
        html = response.read().decode("utf-8", errors="replace")

    # Extract ytInitialPlayerResponse which contains storyboard data.
    # We use brace-matching instead of regex because the JSON payload is large
    # and deeply nested, making non-greedy regex unreliable.
    player_response = None
    for needle in ["ytInitialPlayerResponse", 'window["ytInitialPlayerResponse"]']:
        idx = html.find(needle)
        if idx == -1:
            continue
        start = html.find("{", idx)
        if start == -1:
            continue
        depth, end = 0, -1
        for i in range(start, min(start + 500_000, len(html))):
            if html[i] == "{":
                depth += 1
            elif html[i] == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        if end == -1:
            continue
        try:
            player_response = json.loads(html[start:end])
            break
        except Exception:
            continue

    if not player_response:
        return None
    # The storyboard spec lives under storyboards.playerStoryboardSpecRenderer.spec
    # or under storyboards.playerLiveStoryboardSpecRenderer.spec (for live streams).
    storyboards = player_response.get("storyboards", {})
    spec_renderer = storyboards.get("playerStoryboardSpecRenderer", {})
    spec_string = spec_renderer.get("spec", "")
    if not spec_string:
        # Try live storyboard as fallback.
        live_renderer = storyboards.get("playerLiveStoryboardSpecRenderer", {})
        spec_string = live_renderer.get("spec", "")
    if not spec_string:
        return None

    # Parse the pipe-delimited spec string.
    # Format: baseUrl|thumbWidth#thumbHeight#count#cols#rows#interval_ms#name#sigh#quality
    # The first segment is the base URL, subsequent segments are layer configs.
    parts = spec_string.split("|")
    if len(parts) < 2:
        return None

    base_url = parts[0]
    layers = []
    for level_index, layer_spec in enumerate(parts[1:]):
        segments = layer_spec.split("#")
        if len(segments) < 8:
            continue
        try:
            thumb_w = int(segments[0])
            thumb_h = int(segments[1])
            count = int(segments[2])
            cols = int(segments[3])
            rows = int(segments[4])
            interval_ms = int(segments[5])
            name = segments[6]
            sigh = segments[7]
        except (ValueError, IndexError):
            continue

        if thumb_w <= 0 or thumb_h <= 0 or count <= 0 or cols <= 0 or rows <= 0:
            continue

        # Build the full URL template for this layer.
        # Replace $L with the level index, $N with the sprite sheet index (M0, M1, …).
        layer_url = base_url.replace("$L", str(level_index)).replace("$N", "M$M")
        # Append the sigh parameter.
        separator = "&" if "?" in layer_url else "?"
        layer_url += f"{separator}sigh={sigh}"

        layers.append({
            "url": layer_url,
            "width": thumb_w,
            "height": thumb_h,
            "count": count,
            "cols": cols,
            "rows": rows,
            "interval": interval_ms,
        })

    return layers if layers else None


@app.route("/api/youtube/storyboard")
def youtube_storyboard():
    video_id = request.args.get("v", "").strip()
    if not video_id or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return jsonify({"error": "Invalid video ID"}), 400
    try:
        layers = _fetch_storyboard_spec(video_id)
    except Exception:
        logger.warning("Error fetching storyboard for %s", video_id, exc_info=True)
        return jsonify({"error": "Could not fetch storyboard data"}), 502
    if not layers:
        return jsonify({"error": "Storyboard data not available for this video"}), 404
    return jsonify({"videoId": video_id, "layers": layers})


@app.post("/api/ppt/import")
def import_ppt():
    upload = request.files.get("ppt")
    if not upload or not upload.filename:
        return jsonify({"error": "Choose a PPT or PPTX file first."}), 400

    # Validate the extension against the original name: secure_filename() can
    # strip a non-ASCII stem entirely, which used to reject valid uploads.
    suffix = Path(upload.filename).suffix.lower()
    if suffix not in {".ppt", ".pptx"}:
        return jsonify({"error": "Inkyscib can import .ppt and .pptx files."}), 400

    filename = secure_filename(upload.filename) or f"presentation{suffix}"

    with tempfile.TemporaryDirectory(prefix="inkyscib_ppt_") as temp_dir:
        temp_path = Path(temp_dir)
        source_path = temp_path / f"upload{suffix}"
        output_dir = temp_path / "slides"
        output_dir.mkdir()
        upload.save(source_path)

        render_mode = "powerpoint"
        try:
            slide_paths, source_width_emu, source_height_emu = convert_ppt_with_powerpoint(source_path, output_dir)
        except Exception:
            logger.warning("PowerPoint conversion failed for %s", filename, exc_info=True)
            if suffix != ".pptx":
                return jsonify({
                    "error": "Legacy .ppt import needs Microsoft PowerPoint installed on this Windows machine."
                }), 503
            try:
                render_mode = "basic"
                slide_paths, source_width_emu, source_height_emu = convert_pptx_basic(source_path, output_dir)
            except Exception:
                logger.warning("Basic PPTX conversion failed for %s", filename, exc_info=True)
                return jsonify({
                    "error": "PPT import needs Microsoft PowerPoint, or a PPTX with renderable slide content."
                }), 503

        slides = []
        logical_width = source_width_emu / EMU_PER_INCH * CSS_PIXELS_PER_INCH
        logical_height = source_height_emu / EMU_PER_INCH * CSS_PIXELS_PER_INCH
        for index, slide_path in enumerate(slide_paths):
            slides.append({
                "index": index,
                "width": logical_width,
                "height": logical_height,
                "sourceWidthEmu": source_width_emu,
                "sourceHeightEmu": source_height_emu,
                "image": data_url_from_image(slide_path)
            })

    return jsonify({
        "name": filename,
        "slides": slides,
        "renderMode": render_mode
    })


@app.post("/api/pdf/import")
def import_pdf():
    if _pymupdf is None:
        return jsonify({"error": "PDF import needs PyMuPDF installed (pip install PyMuPDF)."}), 503

    upload = request.files.get("pdf")
    if not upload or not upload.filename:
        return jsonify({"error": "Choose a PDF file first."}), 400

    if not upload.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Choose a .pdf file to import."}), 400

    filename = secure_filename(upload.filename) or "document.pdf"

    with tempfile.TemporaryDirectory(prefix="inkyscib_pdf_") as temp_dir:
        source_path = Path(temp_dir) / "upload.pdf"
        upload.save(source_path)

        try:
            doc = _pymupdf.open(str(source_path))
        except Exception:
            logger.warning("Could not open uploaded PDF %s", filename, exc_info=True)
            return jsonify({"error": "Could not open this PDF."}), 400

        slides = []
        try:
            if doc.page_count > MAX_PDF_PAGES:
                return jsonify({
                    "error": f"This PDF has {doc.page_count} pages; the import limit is {MAX_PDF_PAGES}."
                }), 400
            for index, page in enumerate(doc):
                page_width = max(1, float(page.rect.width))
                page_height = max(1, float(page.rect.height))
                mat = _pymupdf.Matrix(2, 2)
                pix = page.get_pixmap(matrix=mat)
                img_data = pix.tobytes("png")
                b64 = base64.b64encode(img_data).decode("ascii")
                slides.append({
                    "index": index,
                    "width": page_width,
                    "height": page_height,
                    "image": f"data:image/png;base64,{b64}"
                })
        finally:
            doc.close()

    if not slides:
        return jsonify({"error": "No pages could be rendered from this PDF."}), 400

    return jsonify({"name": filename, "slides": slides, "renderMode": "pdf"})


@app.post("/api/ppt/export/pdf")
def export_pdf():
    if _pymupdf is None:
        return jsonify({"error": "PDF export needs PyMuPDF installed."}), 503

    payload = request.get_json(silent=True) or {}
    slide_payloads = payload.get("slides") or []
    if not slide_payloads:
        return jsonify({"error": "There are no slides to export."}), 400
    if len(slide_payloads) > MAX_EXPORT_SLIDES:
        return jsonify({"error": f"Export is limited to {MAX_EXPORT_SLIDES} slides."}), 400

    slides = []
    for slide_data in slide_payloads:
        try:
            slide = normalize_export_slide(slide_data)
            width, height = export_slide_dimensions(slide)
            dimension_scale = 1 if slide["unit"] == "pt" else 72 / CSS_PIXELS_PER_INCH
            slide["page_width"] = max(1, width * dimension_scale)
            slide["page_height"] = max(1, height * dimension_scale)
            slides.append(slide)
        except Exception:
            return jsonify({"error": "One exported slide image was invalid."}), 400

    output = io.BytesIO()
    document = _pymupdf.open()
    try:
        for slide in slides:
            page = document.new_page(width=slide["page_width"], height=slide["page_height"])
            page.insert_image(page.rect, stream=slide["image"], keep_proportion=True)
        document.save(output, garbage=4, deflate=True)
    finally:
        document.close()
    output.seek(0)

    return send_file(
        output,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=clean_download_name(payload.get("filename"), ".pdf")
    )


# --------------------------------------------------------------------------
# Lossless PDF export
# --------------------------------------------------------------------------
#
# The browser does this itself with pdf-lib; this is the fallback for when it
# cannot. Both work the same way and must keep the same promise: the uploaded
# file's pages are copied through untouched and ink is added on top as vector
# geometry, so text stays selectable and a page nobody drew on comes back
# byte-identical.

MAX_ANNOTATION_PATHS = 20000
VECTOR_TOOLS = {"pen", "highlight", "line", "shape"}


def _clamp(value, low, high):
    return max(low, min(high, value))


def parse_css_color(value):
    """CSS colour to a PyMuPDF (r, g, b) triple plus alpha, both 0..1."""
    named = {
        "black": (0.0, 0.0, 0.0),
        "white": (1.0, 1.0, 1.0),
        "red": (1.0, 0.0, 0.0),
        "green": (0.0, 0.5, 0.0),
        "blue": (0.0, 0.0, 1.0),
        "yellow": (1.0, 1.0, 0.0),
    }
    if not isinstance(value, str):
        return (0.0, 0.0, 0.0), 1.0

    text = value.strip().lower()
    if text in named:
        return named[text], 1.0

    if text.startswith("#"):
        hex_text = text[1:]
        if len(hex_text) in (3, 4):
            hex_text = "".join(character * 2 for character in hex_text)
        if len(hex_text) not in (6, 8):
            return (0.0, 0.0, 0.0), 1.0
        try:
            parts = [int(hex_text[i:i + 2], 16) / 255 for i in range(0, len(hex_text), 2)]
        except ValueError:
            return (0.0, 0.0, 0.0), 1.0
        alpha = parts[3] if len(parts) == 4 else 1.0
        return tuple(parts[:3]), alpha

    match = re.match(r"^rgba?\(([^)]+)\)$", text)
    if match:
        pieces = [piece for piece in re.split(r"[,\s/]+", match.group(1)) if piece]
        try:
            numbers = [float(piece) for piece in pieces]
        except ValueError:
            return (0.0, 0.0, 0.0), 1.0
        if len(numbers) < 3:
            return (0.0, 0.0, 0.0), 1.0
        rgb = tuple(_clamp(number / 255, 0.0, 1.0) for number in numbers[:3])
        alpha = _clamp(numbers[3], 0.0, 1.0) if len(numbers) > 3 else 1.0
        return rgb, alpha

    return (0.0, 0.0, 0.0), 1.0


def _finite_points(path):
    points = []
    for point in path.get("points") or []:
        if not isinstance(point, dict):
            continue
        x = point.get("x")
        y = point.get("y")
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            points.append(point)
    return points


def _point_pressure(points, index):
    raw = points[index].get("pressure") if 0 <= index < len(points) else None
    return _clamp(raw, 0.05, 1) if isinstance(raw, (int, float)) else 0.55


def _segment_speed(points, index):
    if index <= 0 or index >= len(points):
        return 0.0
    a, b = points[index - 1], points[index]
    distance = math.hypot(b["x"] - a["x"], b["y"] - a["y"])
    dt = max(8, (b.get("time") or 0) - (a.get("time") or 0) or 16)
    return distance / dt


def pen_segment_width(style, base_size, points, index):
    """A transcription of __penSegmentWidth in static/js/canvas.js."""
    pressure = _point_pressure(points, index)
    speed = _segment_speed(points, index)
    previous = points[max(0, index - 1)]
    current = points[min(len(points) - 1, index)]
    distance = math.hypot(current["x"] - previous["x"], current["y"] - previous["y"]) or 1
    vertical = abs(current["y"] - previous["y"]) / distance
    remaining = max(0, len(points) - 1 - index)

    if style == "brush":
        speed_weight = _clamp(1.58 - speed * 0.88, 0.42, 1.5)
        pressure_weight = 0.42 + pressure * 1.95
        taper = min(1, 0.18 + index / 3.5, 0.16 + remaining / 5)
        return max(0.55, base_size * pressure_weight * speed_weight * taper)

    nib_angle_weight = 0.42 + pow(vertical, 0.72) * 1.32
    pressure_weight = 0.82 + pressure * 0.32
    speed_weight = _clamp(1.08 - speed * 0.18, 0.82, 1.08)
    taper = min(1, 0.35 + index / 3, 0.3 + remaining / 4)
    return max(0.35, base_size * nib_angle_weight * pressure_weight * speed_weight * taper)


def _draw_centreline(shape, points):
    """The midpoint-smoothed centreline canvas.js draws, as Béziers."""
    if len(points) == 1:
        start = _pymupdf.Point(points[0]["x"], points[0]["y"])
        shape.draw_line(start, _pymupdf.Point(points[0]["x"] + 0.1, points[0]["y"] + 0.1))
        return

    if len(points) == 2:
        shape.draw_line(
            _pymupdf.Point(points[0]["x"], points[0]["y"]),
            _pymupdf.Point(points[1]["x"], points[1]["y"]),
        )
        return

    start = _pymupdf.Point(points[0]["x"], points[0]["y"])
    for index in range(1, len(points) - 1):
        control = points[index]
        end = _pymupdf.Point(
            (points[index]["x"] + points[index + 1]["x"]) / 2,
            (points[index]["y"] + points[index + 1]["y"]) / 2,
        )
        # A quadratic (start, control, end) is the cubic with these controls.
        c1 = _pymupdf.Point(
            start.x + (2 / 3) * (control["x"] - start.x),
            start.y + (2 / 3) * (control["y"] - start.y),
        )
        c2 = _pymupdf.Point(
            end.x + (2 / 3) * (control["x"] - end.x),
            end.y + (2 / 3) * (control["y"] - end.y),
        )
        shape.draw_bezier(start, c1, c2, end)
        start = end

    last = points[-1]
    shape.draw_line(start, _pymupdf.Point(last["x"], last["y"]))


def draw_path_on_page(page, path):
    """Add one Inkyscib path to a page as vector geometry.

    Returns True when it was drawn, False when this path is not something the
    server can reproduce exactly — in which case the caller reports it rather
    than drawing an approximation.
    """
    tool = path.get("tool")
    if tool not in VECTOR_TOOLS:
        return False
    if path.get("eraserCuts"):
        return False

    points = _finite_points(path)
    if not points:
        return False

    color, alpha = parse_css_color(path.get("color") or "#ffffff")
    size = path.get("size")
    base_size = max(0.5, size if isinstance(size, (int, float)) else 2)

    if tool == "highlight":
        shape = page.new_shape()
        _draw_centreline(shape, points)
        shape.finish(
            color=color,
            width=max(1.0, base_size),
            lineCap=1,
            lineJoin=1,
            closePath=False,
            stroke_opacity=alpha if alpha < 1 else 0.4,
        )
        shape.commit()
        return True

    if tool == "line":
        if len(points) < 2:
            return False
        if path.get("lineType") not in (None, "plain"):
            return False
        if path.get("startArrow") or path.get("endArrow") or path.get("label"):
            return False
        shape = page.new_shape()
        shape.draw_line(
            _pymupdf.Point(points[0]["x"], points[0]["y"]),
            _pymupdf.Point(points[1]["x"], points[1]["y"]),
        )
        shape.finish(color=color, width=base_size, lineCap=1, lineJoin=1, closePath=False)
        shape.commit()
        return True

    if tool == "shape":
        if len(points) < 2:
            return False
        kind = path.get("shapeType") or "rect"
        a, b = points[0], points[1]
        rect = _pymupdf.Rect(
            min(a["x"], b["x"]), min(a["y"], b["y"]),
            max(a["x"], b["x"]), max(a["y"], b["y"]),
        )
        shape = page.new_shape()
        if kind in ("circle", "ellipse"):
            shape.draw_oval(rect)
        elif kind in ("rect", "rectangle", "square"):
            shape.draw_rect(rect)
        else:
            return False
        shape.finish(color=color, width=base_size, lineCap=1, lineJoin=1, closePath=True)
        shape.commit()
        return True

    # pen
    raw_style = path.get("penStyle") or path.get("style") or "default"
    style = "calligraphy" if raw_style == "marker" else raw_style
    if style == "calligraphy":
        # Filled nib quads; the geometry lives in the browser renderer.
        return False

    if style in ("fountain", "brush"):
        opacity = 0.96 if style == "brush" else 1.0
        shape = page.new_shape()
        if len(points) == 1:
            width = pen_segment_width(style, base_size, points, 0)
            shape.draw_circle(_pymupdf.Point(points[0]["x"], points[0]["y"]), width / 2)
            shape.finish(color=color, fill=color, width=0.1, fill_opacity=opacity)
            shape.commit()
            return True

        def midpoint(p, q):
            return _pymupdf.Point((p["x"] + q["x"]) / 2, (p["y"] + q["y"]) / 2)

        # Each span carries its own width, so each is finished separately.
        first = midpoint(points[0], points[1])
        shape.draw_line(_pymupdf.Point(points[0]["x"], points[0]["y"]), first)
        shape.finish(
            color=color, width=pen_segment_width(style, base_size, points, 1),
            lineCap=1, lineJoin=1, closePath=False, stroke_opacity=opacity,
        )

        for index in range(1, len(points) - 1):
            start = midpoint(points[index - 1], points[index])
            end = midpoint(points[index], points[index + 1])
            control = points[index]
            c1 = _pymupdf.Point(
                start.x + (2 / 3) * (control["x"] - start.x),
                start.y + (2 / 3) * (control["y"] - start.y),
            )
            c2 = _pymupdf.Point(
                end.x + (2 / 3) * (control["x"] - end.x),
                end.y + (2 / 3) * (control["y"] - end.y),
            )
            shape.draw_bezier(start, c1, c2, end)
            current = pen_segment_width(style, base_size, points, index)
            following = pen_segment_width(style, base_size, points, index + 1)
            shape.finish(
                color=color, width=(current + following) / 2,
                lineCap=1, lineJoin=1, closePath=False, stroke_opacity=opacity,
            )

        last_mid = midpoint(points[-2], points[-1])
        shape.draw_line(last_mid, _pymupdf.Point(points[-1]["x"], points[-1]["y"]))
        shape.finish(
            color=color, width=pen_segment_width(style, base_size, points, len(points) - 1),
            lineCap=1, lineJoin=1, closePath=False, stroke_opacity=opacity,
        )
        shape.commit()
        return True

    widths = [base_size * 1.72, base_size * 1.34] if style == "gel" else [base_size]
    opacities = [0.42, 1.0] if style == "gel" else [alpha]
    for width, opacity in zip(widths, opacities):
        shape = page.new_shape()
        _draw_centreline(shape, points)
        shape.finish(
            color=color, width=width, lineCap=1, lineJoin=1,
            closePath=False, stroke_opacity=opacity,
        )
        shape.commit()
    return True


@app.post("/api/pdf/export")
def export_pdf_onto_original():
    """Add annotations to an uploaded PDF without rewriting its pages.

    Takes the original file plus the annotations that belong on each page, and
    returns the same document with vector ink on top. Pages with no
    annotations are never opened for writing, which is what keeps them
    identical to the upload.
    """
    if _pymupdf is None:
        return jsonify({"error": "PDF export needs PyMuPDF installed."}), 503

    upload = request.files.get("pdf")
    if not upload or not upload.filename:
        return jsonify({"error": "The original PDF is required for a lossless export."}), 400

    try:
        annotations = json.loads(request.form.get("annotations") or "[]")
    except ValueError:
        return jsonify({"error": "The annotations could not be read."}), 400
    if not isinstance(annotations, list):
        return jsonify({"error": "The annotations could not be read."}), 400

    total_paths = sum(len(entry.get("paths") or []) for entry in annotations if isinstance(entry, dict))
    if total_paths > MAX_ANNOTATION_PATHS:
        return jsonify({"error": f"Export is limited to {MAX_ANNOTATION_PATHS} strokes."}), 400

    with tempfile.TemporaryDirectory(prefix="inkyscib_export_") as temp_dir:
        source_path = Path(temp_dir) / "original.pdf"
        upload.save(source_path)

        try:
            document = _pymupdf.open(str(source_path))
        except Exception:
            logger.warning("Could not open the PDF to export onto", exc_info=True)
            return jsonify({"error": "Could not open this PDF."}), 400

        drawn = 0
        skipped = 0
        try:
            for entry in annotations:
                if not isinstance(entry, dict):
                    continue
                index = entry.get("pageIndex")
                if not isinstance(index, int) or not 0 <= index < document.page_count:
                    continue
                paths = [p for p in (entry.get("paths") or []) if isinstance(p, dict)]
                if not paths:
                    continue

                page = document[index]
                for path in paths:
                    if path.get("tool") == "eraser":
                        continue
                    try:
                        if draw_path_on_page(page, path):
                            drawn += 1
                        else:
                            skipped += 1
                    except Exception:
                        logger.warning("Skipped a stroke that could not be drawn", exc_info=True)
                        skipped += 1

            output = io.BytesIO()
            document.save(output, garbage=0, deflate=True, incremental=False)
        finally:
            document.close()

    output.seek(0)
    response = send_file(
        output,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=clean_download_name(request.form.get("filename"), ".pdf"),
    )
    # Lets the caller report honestly instead of assuming everything landed.
    response.headers["X-Inkyscib-Strokes-Drawn"] = str(drawn)
    response.headers["X-Inkyscib-Strokes-Skipped"] = str(skipped)
    return response


@app.post("/api/ppt/export/pptx")
def export_pptx():
    payload = request.get_json(silent=True) or {}
    slide_payloads = payload.get("slides") or []
    if not slide_payloads:
        return jsonify({"error": "There are no slides to export."}), 400
    if len(slide_payloads) > MAX_EXPORT_SLIDES:
        return jsonify({"error": f"Export is limited to {MAX_EXPORT_SLIDES} slides."}), 400

    try:
        slides = [normalize_export_slide(slide_data) for slide_data in slide_payloads]
    except Exception:
        return jsonify({"error": "One exported slide image was invalid."}), 400

    output = build_image_pptx(slides)

    return send_file(
        output,
        mimetype="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        as_attachment=True,
        download_name=clean_download_name(payload.get("filename"), ".pptx")
    )


if __name__ == "__main__":
    # The Flask dev server should not listen on the whole LAN by default.
    # Production runs behind gunicorn via wsgi.py; set HOST=0.0.0.0 explicitly
    # if you need to expose the dev server to other devices.
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", 10000))
    app.run(host=host, port=port)

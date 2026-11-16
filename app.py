import base64
import collections
import contextlib
import datetime
import gzip
import http.client
import io
import json
import logging
import math
import functools
import hashlib
import os
import posixpath
import re
import ssl
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
import zlib
from pathlib import Path
from xml.etree import ElementTree as ET

from flask import (
    Flask,
    Response,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    url_for,
)
from markupsafe import Markup, escape
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename

import logging_filters

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

# The public origin, used for canonical URLs, the sitemap, social cards and
# llms.txt. Set SITE_ORIGIN in production (e.g. https://inkyscib.com). Left
# unset, the app falls back to the origin the request arrived on, which is
# right for a local run and harmless on a single-domain deployment. Nothing
# else in the codebase may hardcode a domain.
SITE_ORIGIN = os.environ.get("SITE_ORIGIN", "").strip().rstrip("/")


def site_url(path="/"):
    """Absolute URL for a site-relative path, on the configured public origin."""
    if not path.startswith("/"):
        path = "/" + path
    # rstrip again rather than trusting the module-level value: a test or a
    # caller may have patched SITE_ORIGIN, and a doubled slash in a canonical
    # is a different URL to a crawler.
    origin = (SITE_ORIGIN or request.url_root).rstrip("/")
    return origin + path


# Behind a reverse proxy (Render, Fly, nginx) the socket this process sees is
# plain HTTP; the real scheme and host survive only in X-Forwarded-*. Without
# ProxyFix, request.is_secure is always False, so the HSTS header set in
# set_security_headers never actually ships. Only enable it where a proxy is
# genuinely in front, or a client can forge the scheme.
if os.environ.get("TRUST_PROXY_HEADERS", "").strip().lower() in {"1", "true", "yes"}:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

FORCE_HTTPS = os.environ.get("FORCE_HTTPS", "").strip().lower() in {"1", "true", "yes"}

# Everything served on a second hostname - www. as well as the apex, or the
# hosting platform's default *.onrender.com alongside the custom domain - is
# duplicate content. The canonical tag hints; this redirect settles it.
CANONICAL_HOST = urllib.parse.urlsplit(SITE_ORIGIN).netloc if SITE_ORIGIN else ""

# Search Console's HTML-tag verification. Empty in development, so no stray
# meta ships locally; set SEARCH_CONSOLE_TOKEN in the deploy environment.
SEARCH_CONSOLE_TOKEN = os.environ.get("SEARCH_CONSOLE_TOKEN", "").strip()


# PII never reaches a handler: the filter rewrites the record itself, so
# nothing identifying is written to disk or forwarded to a log service.
_PII_FILTER = logging_filters.RedactPII()
for _log in (logger, logging.getLogger("werkzeug"), logging.getLogger()):
    _log.addFilter(_PII_FILTER)


@app.context_processor
def inject_canonical():
    # request.path drops the query string, which is what a canonical wants:
    # /write?planner=1 and /write are the same document to a crawler.
    return {
        "canonical_url": site_url(request.path),
        "site_url": site_url,
        "app_version": APP_VERSION,
        "search_console_token": SEARCH_CONSOLE_TOKEN,
    }


@app.before_request
def redirect_to_canonical_origin():
    """One origin, over TLS. Off by default, so a local run is untouched."""
    host = request.host.split(":")[0]
    if host in ("127.0.0.1", "localhost", "[::1]"):
        return None

    wrong_scheme = FORCE_HTTPS and not request.is_secure
    wrong_host = bool(CANONICAL_HOST) and request.host != CANONICAL_HOST

    if not (wrong_scheme or wrong_host):
        return None

    scheme = "https" if (FORCE_HTTPS or request.is_secure) else request.scheme
    netloc = CANONICAL_HOST or request.host
    target = urllib.parse.urlunsplit(
        (scheme, netloc, request.path, request.query_string.decode(), "")
    )
    # 301 is what search engines consolidate on; 308 keeps the method and body
    # for anything that is not a plain read.
    code = 301 if request.method in ("GET", "HEAD") else 308
    return redirect(target, code=code)


@app.context_processor
def inject_current_year():
    """The editor prints a copyright line. Hard-coding the year means it is
    wrong every January and nobody notices until someone reads the footer, so
    it is rendered rather than typed."""
    return {"current_year": datetime.date.today().year}


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

APP_VERSION = "2.1.0"

# Render sets RENDER=true on every service; INKYSCIB_ENV=production is the
# switch for any other host. A random fallback is fine on a laptop, but under
# Gunicorn each worker would draw its own key, so anything that ever signs a
# cookie would break at random. Refuse to start instead.
IS_PRODUCTION = (
    os.environ.get("INKYSCIB_ENV", "").strip().lower() == "production"
    or os.environ.get("RENDER", "").strip().lower() == "true"
)
_secret_key = os.environ.get("SECRET_KEY", "").strip()
if not _secret_key:
    if IS_PRODUCTION:
        raise RuntimeError(
            "SECRET_KEY is not set. Set it in the host's environment before "
            "starting MAETHIST in production."
        )
    _secret_key = os.urandom(32).hex()
app.config["SECRET_KEY"] = _secret_key

# A saved video moment is cut from the video itself at the highest resolution
# YouTube offers (up to YOUTUBE_FRAME_MAX_HEIGHT), by reading byte ranges of the
# stream with yt-dlp and PyAV. It is the most expensive thing an anonymous
# visitor can trigger, so it is bounded by YOUTUBE_FRAME_CONCURRENCY below, and
# a host can switch it off with YOUTUBE_FULL_FRAMES=false, in which case a
# saved moment falls back to YouTube's own low-resolution storyboard preview.
YOUTUBE_FULL_FRAMES = os.environ.get("YOUTUBE_FULL_FRAMES", "true").strip().lower() not in (
    "0", "false", "no", "off"
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
# Imports. PDFs and .pptx files are normally converted in the browser
# (pdf-local-import.js, ppt-local-import.js); these endpoints are the fallback
# and the path for legacy .ppt. A conversion parses an untrusted file with
# PyMuPDF or Pillow and can hold hundreds of MB, so uploads are capped well
# below the global MAX_CONTENT_LENGTH (which is sized for slide exports) and
# only a couple run at once. Both are environment-tunable for a bigger host.
MAX_IMPORT_UPLOAD_BYTES = int(os.environ.get("MAX_IMPORT_UPLOAD_MB", "50")) * 1024 * 1024
IMPORT_CONCURRENCY = max(1, int(os.environ.get("IMPORT_CONCURRENCY", "2")))
IMPORT_WAIT_SECONDS = 15
_IMPORT_SLOTS = threading.BoundedSemaphore(IMPORT_CONCURRENCY)
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
        f'<p:nvPicPr><p:cNvPr id="2" name="MAETHIST slide {index}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
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
        f'<a:theme xmlns:a="{A_NS}" name="MAETHIST">'
        '<a:themeElements><a:clrScheme name="MAETHIST">'
        '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
        '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
        '<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>'
        '<a:accent1><a:srgbClr val="5A5AFF"/></a:accent1><a:accent2><a:srgbClr val="22C55E"/></a:accent2>'
        '<a:accent3><a:srgbClr val="F59E0B"/></a:accent3><a:accent4><a:srgbClr val="EF4444"/></a:accent4>'
        '<a:accent5><a:srgbClr val="06B6D4"/></a:accent5><a:accent6><a:srgbClr val="A855F7"/></a:accent6>'
        '<a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>'
        '</a:clrScheme><a:fontScheme name="MAETHIST"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme>'
        '<a:fmtScheme name="MAETHIST"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
        '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
        '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
        '</a:themeElements></a:theme>'
    )


def build_doc_props(slide_count):
    app_xml = (
        simple_xml_header() +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        '<Application>MAETHIST</Application>'
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
        '<dc:title>MAETHIST annotated presentation</dc:title>'
        '<dc:creator>MAETHIST</dc:creator>'
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
    stem = secure_filename(Path(name or "maethist-presentation").stem) or "maethist-presentation"
    return f"{stem}{suffix}"


# Every external origin the app legitimately talks to. Tighten here if a
# feature (AR hand tracking, YouTube player) is ever removed.
CONTENT_SECURITY_POLICY = "; ".join([
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    # 'unsafe-inline' is required by the inline scripts in the templates;
    # 'wasm-unsafe-eval' is required by MediaPipe Hands (AR) and PDF.js.
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' "
    "https://cdn.jsdelivr.net https://www.youtube.com",
    # Both type families are self-hosted (static/fonts/, static/css/fonts.css),
    # so no font origin is allowed here and font-src below falls back to 'self'.
    # Re-adding either origin re-opens the IP flow to Google that
    # tools/vendor_fonts.py exists to close.
    "style-src 'self' 'unsafe-inline'",
    # data: covers imported slide images; the rest are YouTube thumbnails,
    # and the icons8 brand mark. There is no analytics origin: v2 removed
    # analytics outright, and tests/test_analytics_csp.py keeps it out.
    "img-src 'self' data: blob: https://img.icons8.com https://*.ytimg.com "
    "https://img.youtube.com",
    "connect-src 'self' https://cdn.jsdelivr.net",
    "font-src 'self'",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    # data: covers the pomodoro alarm chime.
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    # Intentionally permissive: MAETHIST is meant to be embeddable on any
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

    # Allow camera only for MAETHIST itself, block microphone
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"

    # IMPORTANT:
    # Do NOT set X-Frame-Options, because it blocks iframe embedding.
    response.headers.pop("X-Frame-Options", None)

    response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY

    # InkLab (/lab/ink) needs cross-origin isolation for SharedArrayBuffer.
    # It is scoped to the lab and its own scripts: COEP on /write would block
    # the cross-origin YouTube player, and the lab's worker is refused
    # outright unless its own script response carries these headers too
    # (probed 2026-09-13). See
    # docs/superpowers/specs/2026-09-13-inklab-webgpu-design.md.
    if request.path.startswith(("/lab/", "/static/js/inklab/")):
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"

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


# InkLab: an isolated WebGPU ink lab, separate from the editor. These are
# the scripts its render worker loads with importScripts, in order.
INKLAB_WORKER_SCRIPTS = (
    "ring-buffer.js",
    "stroke-width.js",
    "predictor.js",
    "shaders.js",
    "canvas2d-renderer.js",
    "gpu-renderer.js",
)


@app.route("/lab/ink")
def lab_ink():
    config = {
        "worker": url_for("static", filename="js/inklab/render-worker.js"),
        "scripts": [
            url_for("static", filename=f"js/inklab/{name}")
            for name in INKLAB_WORKER_SCRIPTS
        ],
    }
    return render_template("lab_ink.html", config=config)


LEGAL_UPDATED = "2026-11-15"


@app.route("/legal/privacy")
def privacy():
    return render_template(
        "legal/privacy.html", nav_active="", legal_updated=LEGAL_UPDATED
    )


@app.route("/legal/cookies")
def cookies():
    return render_template(
        "legal/cookies.html", nav_active="", legal_updated=LEGAL_UPDATED
    )


@app.route("/legal/terms")
def terms():
    return render_template(
        "legal/terms.html", nav_active="", legal_updated=LEGAL_UPDATED
    )


@app.route("/healthz")
def healthz():
    """What the host pings to decide the service is up."""
    response = jsonify({"status": "ok", "version": APP_VERSION})
    response.headers["Cache-Control"] = "no-store"
    return response


# Everything the editor and the marketing pages need to open with no network.
# InkLab is a separate prototype with its own isolation headers and is left
# out; so is the planner's notification worker, which registers itself.
OFFLINE_PAGES = ("/", "/write", "/features", "/about")
# The per-icon SVG files are only read by the server (icon() inlines them);
# the browser gets the same icons through js/icon-set.js.
_OFFLINE_SKIP_PREFIXES = (
    "js/inklab/", "js/planner-sw.js", "img/",
    "icons/lucide/", "icons/phosphor/", "icons/remix/",
)
_OFFLINE_SUFFIXES = (
    ".css", ".js", ".woff2", ".png", ".ico", ".svg", ".webmanifest", ".webp",
)


def offline_asset_urls():
    urls = []
    static_root = Path(app.static_folder)
    for file_path in sorted(static_root.rglob("*")):
        if not file_path.is_file():
            continue
        relative = file_path.relative_to(static_root).as_posix()
        if relative.startswith(_OFFLINE_SKIP_PREFIXES):
            continue
        if not relative.endswith(_OFFLINE_SUFFIXES):
            continue
        urls.append(url_for("static", filename=relative))
    return urls


# The remote off switch for the offline shell. If a release ever ships a
# broken worker, set OFFLINE_SHELL=off and redeploy: every visitor's browser
# re-checks /sw.js on its next visit (it is served no-cache), receives a worker
# that deletes the cached app and unregisters itself, and the page stops
# registering a new one. Visitors' notes are untouched -- they live in
# IndexedDB and localStorage, not in Cache Storage.
OFFLINE_SHELL_ENABLED = os.environ.get("OFFLINE_SHELL", "on").strip().lower() not in (
    "0", "off", "false", "no"
)


# Icons vendored by tools/vendor_icons.py (Lucide, Phosphor, Remix Icon; see
# static/icons/LICENSES.md). icon("lucide:trash") inlines the SVG, so it is in
# the HTML on first paint, needs no script, and matches what
# window.Inkyscib.Icon.svg() builds in the browser, attribute for attribute.
_ICON_SETS = {
    "lucide": ("0 0 24 24", 'fill="none" stroke="currentColor" stroke-width="2" '
               'stroke-linecap="round" stroke-linejoin="round"'),
    "phosphor": ("0 0 256 256", 'fill="currentColor"'),
    "remix": ("0 0 24 24", 'fill="currentColor"'),
}
_ICON_CACHE = {}
_ICON_INNER = re.compile(r"<svg[^>]*>(.*)</svg>", re.S)


def icon(ref, class_name="", size=None):
    family, _, name = ref.partition(":")
    if family not in _ICON_SETS or not re.fullmatch(r"[a-z0-9-]+", name):
        raise ValueError(f"unknown icon {ref!r}")
    inner = _ICON_CACHE.get(ref)
    if inner is None:
        path = Path(app.static_folder) / "icons" / family / f"{name}.svg"
        if not path.is_file():
            # Loud on purpose: a missing icon is a blank button in production.
            raise ValueError(f"icon {ref!r} is not vendored; add it to tools/vendor_icons.py")
        inner = _ICON_INNER.search(path.read_text(encoding="utf-8")).group(1)
        _ICON_CACHE[ref] = inner
    view_box, paint = _ICON_SETS[family]
    classes = " ".join(part for part in ("icon", f"icon-{family}", f"icon-{name}", class_name) if part)
    dims = f' width="{int(size)}" height="{int(size)}"' if size else ""
    return Markup(
        f'<svg class="{escape(classes)}" viewBox="{view_box}"{dims} {paint} '
        f'aria-hidden="true" focusable="false">{inner}</svg>'
    )


app.jinja_env.globals["icon"] = icon


@app.context_processor
def inject_offline_shell():
    return {"offline_shell_enabled": OFFLINE_SHELL_ENABLED}


@app.route("/sw.js")
def service_worker():
    """The offline shell worker, served from the root so its scope is the site.

    The asset list is rendered into the script, and every static URL carries a
    token derived from the file, so the script's bytes change whenever any
    asset does. That byte change is what makes a browser install the update.
    """
    if not OFFLINE_SHELL_ENABLED:
        response = Response(render_template("sw-off.js"), mimetype="text/javascript")
        response.headers["Cache-Control"] = "no-cache"
        response.headers["Service-Worker-Allowed"] = "/"
        return response

    assets = offline_asset_urls()
    digest = hashlib.sha256("\n".join(assets).encode()).hexdigest()[:12]
    body = render_template(
        "sw.js",
        cache_name=f"inkyscib-shell-{APP_VERSION}-{digest}",
        pages=list(OFFLINE_PAGES),
        assets=assets,
    )
    response = Response(body, mimetype="text/javascript")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Service-Worker-Allowed"] = "/"
    return response


@app.route("/robots.txt")
def robots_txt():
    """Crawl policy. The API returns JSON or binaries and the lab is an
    unfinished prototype, so neither is worth a crawl budget."""
    body = "\n".join([
        "User-agent: *",
        "Allow: /",
        "Disallow: /api/",
        "Disallow: /lab/",
        "",
        f"Sitemap: {site_url('/sitemap.xml')}",
        "",
    ])
    return Response(body, mimetype="text/plain")


# (path, changefreq, priority). The template a path renders gives its
# <lastmod>: a stamp of "today" on every request is a claim no crawler
# believes, and a template's mtime is the closest honest answer available
# without a git history to read.
SITEMAP_ROUTES = (
    ("/", "weekly", "1.0"),
    ("/write", "weekly", "0.9"),
    ("/features", "monthly", "0.8"),
    ("/about", "monthly", "0.5"),
    ("/legal/privacy", "yearly", "0.3"),
    ("/legal/cookies", "yearly", "0.3"),
    ("/legal/terms", "yearly", "0.3"),
)

SITEMAP_TEMPLATES = {
    "/": "home.html",
    "/write": "write.html",
    "/features": "features.html",
    "/about": "about.html",
    "/legal/privacy": "legal/privacy.html",
    "/legal/cookies": "legal/cookies.html",
    "/legal/terms": "legal/terms.html",
}


def _template_lastmod(path):
    template = Path(app.root_path) / "templates" / SITEMAP_TEMPLATES[path]
    stamp = datetime.datetime.fromtimestamp(
        template.stat().st_mtime, datetime.timezone.utc
    )
    return stamp.date().isoformat()


@app.route("/sitemap.xml")
def sitemap_xml():
    entries = "".join(
        "<url>"
        f"<loc>{site_url(path)}</loc>"
        f"<lastmod>{_template_lastmod(path)}</lastmod>"
        f"<changefreq>{changefreq}</changefreq>"
        f"<priority>{priority}</priority>"
        "</url>"
        for path, changefreq, priority in SITEMAP_ROUTES
    )
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        f"{entries}"
        "</urlset>"
    )
    return Response(body, mimetype="application/xml")


@app.route("/llms.txt")
def llms_txt():
    """llmstxt.org: a short Markdown brief for LLM crawlers, so a model that
    summarises MAETHIST gets the price, the storage model and the licence
    right rather than inferring them from marketing copy."""
    return Response(render_template("llms.txt"), mimetype="text/markdown")


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

    url = f"https://www.youtube.com/results?search_query={urllib.parse.quote_plus(query)}&hl=en"
    try:
        html = _fetch_youtube_bytes(url, timeout=5).decode("utf-8", errors="replace")
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


YOUTUBE_FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+410",
}
YOUTUBE_STORYBOARD_HOST = "i.ytimg.com"
# The sprite URLs carry a signature, so a cached spec cannot be kept for ever.
YOUTUBE_STORYBOARD_TTL_SECONDS = 30 * 60
YOUTUBE_STORYBOARD_CACHE = {}
YOUTUBE_SPRITE_CACHE = {}
MAX_YOUTUBE_CACHED_STORYBOARDS = 64
MAX_YOUTUBE_CACHED_SPRITES = 24
MAX_YOUTUBE_WATCH_PAGE_BYTES = 8 * 1024 * 1024
MAX_YOUTUBE_SPRITE_BYTES = 4 * 1024 * 1024
MAX_YOUTUBE_FRAME_SECONDS = 7 * 24 * 60 * 60
_OUTBOUND_SSL_CONTEXT = None


def _outbound_ssl_context():
    """TLS for the server's own requests to YouTube.

    Python 3.13+ verifies with ``VERIFY_X509_STRICT``, which rejects a CA whose
    Basic Constraints extension is not marked critical. Antivirus HTTPS scanning
    installs exactly such a root and re-signs every site with it (Avast's "Web/
    Mail Shield Root" on the machine this was found on), so there every fetch
    failed: the storyboard lookup returned 502, search called itself
    unavailable, and "save frame" quietly fell back to the thumbnail.

    Only that profile check is relaxed. The chain is still verified against the
    system's trusted roots and the hostname is still checked.
    """
    global _OUTBOUND_SSL_CONTEXT
    if _OUTBOUND_SSL_CONTEXT is None:
        context = ssl.create_default_context()
        context.verify_flags &= ~ssl.VERIFY_X509_STRICT
        _OUTBOUND_SSL_CONTEXT = context
    return _OUTBOUND_SSL_CONTEXT


def _fetch_youtube_bytes(url, headers=None, timeout=8, max_bytes=None):
    """The one place the server fetches from YouTube.

    Keeping it single means TLS is configured once, and tests can stand in for
    the network by patching one name.
    """
    outbound = urllib.request.Request(url, headers=headers or YOUTUBE_FETCH_HEADERS)
    with urllib.request.urlopen(outbound, timeout=timeout, context=_outbound_ssl_context()) as response:
        if max_bytes is None:
            return response.read()
        body = response.read(max_bytes + 1)
    if len(body) > max_bytes:
        raise ValueError(f"YouTube response for {url} exceeded {max_bytes} bytes")
    return body


def _is_storyboard_url(url):
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and parts.hostname == YOUTUBE_STORYBOARD_HOST
        and parts.path.startswith("/sb/")
    )


def _parse_storyboard_spec(html):
    """Storyboard layers from a watch page, or None when it publishes none.

    The spec is ``baseUrl|w#h#count#cols#rows#intervalMs#name#sigh|...``, one
    layer per ``|``, lowest resolution first. ``$L`` in the base URL is the
    layer's index, ``$N`` its name (``M$M`` for the sheets, where ``$M`` is the
    sheet number). A base URL anywhere but YouTube's storyboard host is treated
    as no storyboard: the server only ever fetches from there.
    """
    player = _json_object_after_markers(
        html,
        (
            "var ytInitialPlayerResponse",
            'window["ytInitialPlayerResponse"]',
            "ytInitialPlayerResponse",
        ),
    )
    if not isinstance(player, dict):
        return None

    storyboards = player.get("storyboards") or {}
    spec = (
        (storyboards.get("playerStoryboardSpecRenderer") or {}).get("spec")
        or (storyboards.get("playerLiveStoryboardSpecRenderer") or {}).get("spec")
        or ""
    )
    parts = spec.split("|") if isinstance(spec, str) else []
    if len(parts) < 2 or not _is_storyboard_url(parts[0]):
        return None

    layers = []
    for level, layer_spec in enumerate(parts[1:]):
        segments = layer_spec.split("#")
        if len(segments) < 8:
            continue
        try:
            width, height, count, cols, rows, interval = (int(value) for value in segments[:6])
        except ValueError:
            continue
        if min(width, height, count, cols, rows) <= 0 or interval < 0:
            continue
        url = parts[0].replace("$L", str(level)).replace("$N", segments[6])
        separator = "&" if "?" in url else "?"
        layers.append({
            "level": level,
            "url": f"{url}{separator}sigh={segments[7]}",
            "width": width,
            "height": height,
            "count": count,
            "cols": cols,
            "rows": rows,
            "interval": interval,
        })
    return layers or None


def _fetch_storyboard_spec(video_id):
    """Storyboard layers for a video, or None when YouTube publishes none.

    Network and TLS failures raise, so callers can tell "this video has no
    preview frames" apart from "YouTube could not be reached".
    """
    cached = YOUTUBE_STORYBOARD_CACHE.get(video_id)
    if cached and time.monotonic() - cached[0] < YOUTUBE_STORYBOARD_TTL_SECONDS:
        return cached[1]

    html = _fetch_youtube_bytes(
        f"https://www.youtube.com/watch?v={urllib.parse.quote(video_id)}",
        timeout=8,
        max_bytes=MAX_YOUTUBE_WATCH_PAGE_BYTES,
    ).decode("utf-8", errors="replace")
    layers = _parse_storyboard_spec(html)

    YOUTUBE_STORYBOARD_CACHE[video_id] = (time.monotonic(), layers)
    while len(YOUTUBE_STORYBOARD_CACHE) > MAX_YOUTUBE_CACHED_STORYBOARDS:
        YOUTUBE_STORYBOARD_CACHE.pop(next(iter(YOUTUBE_STORYBOARD_CACHE)))
    return layers


def _storyboard_sprite(url):
    sprite = YOUTUBE_SPRITE_CACHE.pop(url, None)
    if sprite is None:
        sprite = _fetch_youtube_bytes(url, timeout=8, max_bytes=MAX_YOUTUBE_SPRITE_BYTES)
    # Re-inserted so the dict's order is least recently used first.
    YOUTUBE_SPRITE_CACHE[url] = sprite
    while len(YOUTUBE_SPRITE_CACHE) > MAX_YOUTUBE_CACHED_SPRITES:
        YOUTUBE_SPRITE_CACHE.pop(next(iter(YOUTUBE_SPRITE_CACHE)))
    return sprite


def _storyboard_frame(video_id, seconds):
    """The storyboard frame nearest ``seconds``, as a JPEG data URL.

    Cut out here rather than in the browser because YouTube serves the sprite
    sheets without ``Access-Control-Allow-Origin``: a page can display them but
    never read their pixels.
    """
    usable = [layer for layer in (_fetch_storyboard_spec(video_id) or []) if layer["interval"] > 0]
    if not usable:
        return None
    layer = max(usable, key=lambda item: item["width"] * item["height"])

    interval = layer["interval"] / 1000
    index = min(layer["count"] - 1, max(0, math.floor(seconds / interval + 0.5)))
    sheet, cell = divmod(index, layer["cols"] * layer["rows"])
    column, row = cell % layer["cols"], cell // layer["cols"]
    url = layer["url"].replace("$M", str(sheet))
    if not _is_storyboard_url(url):
        return None
    if Image is None:
        raise RuntimeError("Pillow is required to cut storyboard frames")

    left, top = column * layer["width"], row * layer["height"]
    box = (left, top, left + layer["width"], top + layer["height"])
    with Image.open(io.BytesIO(_storyboard_sprite(url))) as sprite:
        if box[2] > sprite.width or box[3] > sprite.height:
            raise ValueError(f"Storyboard sheet {url} is smaller than its spec")
        frame = sprite.crop(box).convert("RGB")

    buffer = io.BytesIO()
    frame.save(buffer, "JPEG", quality=92)
    return {
        "image": "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"),
        "width": frame.width,
        "height": frame.height,
        "frameTime": index * interval,
    }


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


# ---------------------------------------------------------------------------
# Full-resolution frames, cut from the video itself
#
# The browser cannot read pixels out of the YouTube iframe -- it is cross-origin
# -- which is why "save frame" used to ask for a screen share and then crop the
# player's box out of the tab. That capped every frame at whatever the player
# happened to be showing: a ~420px-wide player is served roughly 360p, and a
# crop cannot put back detail that was never painted.
#
# So the server cuts the frame instead. yt-dlp resolves the stream (the URL is
# behind a signature cipher, which is not a thing to hand-roll), PyAV seeks to
# the exact timestamp and decodes one frame, at the source's own resolution up
# to 4K. The resolve is cached per video, so a second frame from the same video
# skips it. Measured numbers for 1080p and 4K sources are in docs/V2-REVIEW.md.
#
# Nothing is downloaded to disk and no audio is touched: PyAV reads byte ranges
# over HTTP and stops as soon as it has the frame.
# ---------------------------------------------------------------------------

YOUTUBE_STREAM_CACHE = collections.OrderedDict()
YOUTUBE_STREAM_CACHE_TTL = 4 * 3600  # signed stream URLs outlive this comfortably
# Every key here is an 11-character id chosen by the caller, so the table is
# attacker-sized unless something caps it. Each entry also owns a kept-alive
# socket, which makes an uncapped table a file-descriptor leak as well as a
# memory one. 256 is far more than one server's worth of concurrently-watched
# lectures, and eviction closes the connection rather than dropping it.
YOUTUBE_STREAM_CACHE_MAX_ENTRIES = 256
# 4K. YouTube serves 2160p as VP9 or AV1, never H.264, which is why the stream
# choice below is by resolution rather than by codec. A host on a small
# instance can lower this (1440 or 1080) to trade detail for decode time.
YOUTUBE_FRAME_MAX_HEIGHT = int(os.environ.get("YOUTUBE_FRAME_MAX_HEIGHT", "2160"))
MAX_FRAME_WIDTH = YOUTUBE_FRAME_MAX_HEIGHT * 16 // 9
# JPEG at 4:4:4 (no chroma subsampling) and quality 95: lecture frames are
# mostly slides, text and thin coloured lines, which 4:2:0 smears. The frame is
# already lossy at the source, so PNG would only multiply the size. If a 4K
# frame would not fit the editor's per-frame storage budget, quality steps down
# rather than the frame being refused.
YOUTUBE_FRAME_JPEG_QUALITIES = (95, 92, 88, 84, 80)
# Must stay below INKYSCIB_MAX_FRAME_DATA_URL_LENGTH in static/js/storage.js
# (and MAX_FRAME_DATA_URL in youtube.js), measured on the base64 data URL.
YOUTUBE_FRAME_MAX_DATA_URL = 12 * 1024 * 1024
_YTDLP_SSL_PATCHED = False

# One lock per video. A capture and the /prepare call a video load fires can
# arrive together; the lock makes the capture wait for the resolve already in
# flight rather than start a second one, and serialises use of the kept-alive
# connection stored on the cache entry.
#
# Bounded for the same reason as the cache above, and it matters more here:
# the lock is taken *before* the resolve, so an unknown id that never reaches
# the cache still leaves an entry behind. A flood of random ids against
# /api/youtube/frame grew this table forever.
_YOUTUBE_VIDEO_LOCKS = collections.OrderedDict()
_YOUTUBE_VIDEO_LOCKS_MAX = 256
_YOUTUBE_VIDEO_LOCKS_GUARD = threading.Lock()

# Cutting a frame is the most expensive thing this server does: a ~3s yt-dlp
# resolve for a video it has not seen, then a seek and decode. Nothing
# authenticates the caller, so without a ceiling a handful of requests can
# occupy every worker and a flood of unknown ids turns the server into a bot
# hammering YouTube from its own address.
#
# The ceiling is global rather than per-IP on purpose. A per-IP budget means
# keeping a table of who asked for what, which is a new processing activity
# undertaken to protect the server.
# A global semaphore costs one integer and protects the machine just as well:
# the work is CPU-bound, so more than a few at once is slower for everyone.
# A 4K decode holds a few hundred MB while it runs, so on a small instance
# two at a time is the safe default. Raise it on a bigger machine.
YOUTUBE_FRAME_CONCURRENCY = max(1, int(os.environ.get("YOUTUBE_FRAME_CONCURRENCY", "2")))
YOUTUBE_FRAME_WAIT_SECONDS = 20
_YOUTUBE_FRAME_SLOTS = threading.BoundedSemaphore(YOUTUBE_FRAME_CONCURRENCY)


@contextlib.contextmanager
def _youtube_frame_slot():
    """Hold one of the decode slots, or raise _Busy if they are all taken."""
    if not _YOUTUBE_FRAME_SLOTS.acquire(timeout=YOUTUBE_FRAME_WAIT_SECONDS):
        raise _Busy()
    try:
        yield
    finally:
        _YOUTUBE_FRAME_SLOTS.release()


class _Busy(Exception):
    """Every decode slot is occupied. Answered with 503 and a Retry-After."""

# Byte-range chunks of the stream, shared across captures. The file's header
# and index live in the first chunk, so after one capture (or a /prepare) every
# later one skips them, and a second frame near the first is often served with
# no request at all. Capped so a long session does not grow without bound.
_STREAM_CHUNK_SIZE = 1024 * 1024
_STREAM_CHUNK_BUDGET = 48 * 1024 * 1024
_STREAM_CHUNKS = collections.OrderedDict()
_STREAM_CHUNKS_LOCK = threading.Lock()
_STREAM_CHUNK_BYTES = 0


def _video_lock(video_id):
    with _YOUTUBE_VIDEO_LOCKS_GUARD:
        lock = _YOUTUBE_VIDEO_LOCKS.get(video_id)
        if lock is None:
            lock = threading.Lock()
            _YOUTUBE_VIDEO_LOCKS[video_id] = lock
        else:
            _YOUTUBE_VIDEO_LOCKS.move_to_end(video_id)

        # Evict from the cold end, but never a lock that is currently held --
        # dropping that one hands the next caller for the same video a
        # different lock, and the two then resolve and seek concurrently over
        # one kept-alive connection. Held locks are skipped, not removed, so
        # the table can briefly exceed the cap while captures are in flight.
        while len(_YOUTUBE_VIDEO_LOCKS) > _YOUTUBE_VIDEO_LOCKS_MAX:
            for key, candidate in _YOUTUBE_VIDEO_LOCKS.items():
                if key != video_id and not candidate.locked():
                    del _YOUTUBE_VIDEO_LOCKS[key]
                    break
            else:
                break

        return lock


def _evict_stream_cache(video_id=None):
    """Drop expired entries, then the coldest, closing each one's socket.

    Called with the new entry already stored, so ``video_id`` is protected
    from eviction by the caller that just resolved it.
    """
    now = time.time()
    stale = [
        key for key, entry in YOUTUBE_STREAM_CACHE.items()
        if key != video_id and entry.get("expires", 0) <= now
    ]
    for key in stale:
        _close_stream_entry(YOUTUBE_STREAM_CACHE.pop(key, None))

    while len(YOUTUBE_STREAM_CACHE) > YOUTUBE_STREAM_CACHE_MAX_ENTRIES:
        key, entry = YOUTUBE_STREAM_CACHE.popitem(last=False)
        if key == video_id:  # the freshest entry; put it back and stop
            YOUTUBE_STREAM_CACHE[key] = entry
            break
        _close_stream_entry(entry)


def _close_stream_entry(entry):
    if entry and entry.get("conn") is not None:
        with contextlib.suppress(Exception):
            entry["conn"].close()


def _patch_ytdlp_ssl():
    """Give yt-dlp the same TLS bargain the rest of the server makes.

    Two independent problems on a machine whose antivirus scans HTTPS:

    1. yt-dlp verifies against certifi's bundle, which cannot contain a root
       that only exists in the local Windows store. ``no-certifi`` switches it
       to the system store, where the scanner's root actually is.
    2. Python 3.13+ then rejects that root under ``VERIFY_X509_STRICT``,
       because its Basic Constraints are not marked critical -- the same
       failure ``_outbound_ssl_context`` exists to work around.

    The chain is still verified and the hostname is still checked. Only the
    strict profile is relaxed, and only for this client.
    """
    global _YTDLP_SSL_PATCHED
    if _YTDLP_SSL_PATCHED:
        return
    from yt_dlp.networking.common import RequestHandler

    original = RequestHandler._make_sslcontext

    def relaxed(self, *args, **kwargs):
        context = original(self, *args, **kwargs)
        context.verify_flags &= ~ssl.VERIFY_X509_STRICT
        return context

    RequestHandler._make_sslcontext = relaxed
    _YTDLP_SSL_PATCHED = True


def _youtube_stream(video_id):
    """The highest-resolution video stream, cached until its URL expires.

    Chosen by resolution, up to YOUTUBE_FRAME_MAX_HEIGHT, then frame rate, in
    any codec PyAV's bundled FFmpeg decodes (H.264, VP9, AV1): above 1080p
    YouTube offers nothing else. SDR is preferred, because an HDR frame
    converted to RGB without tone mapping comes out washed out; an HDR-only
    video still works, just with flatter colour.

    Call with the video's lock held.
    """
    cached = YOUTUBE_STREAM_CACHE.get(video_id)
    if cached and cached["expires"] > time.time():
        return cached

    import yt_dlp

    _patch_ytdlp_ssl()
    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        # Not a flag but a compat option: it is what drives prefer_system_certs.
        "compat_opts": {"no-certifi"},
        "format": (
            f"bestvideo[dynamic_range=SDR][height<={YOUTUBE_FRAME_MAX_HEIGHT}]"
            f"/bestvideo[height<={YOUTUBE_FRAME_MAX_HEIGHT}]"
            "/bestvideo/best"
        ),
        # Highest resolution first, then frame rate; codec only breaks ties.
        "format_sort": [f"res:{YOUTUBE_FRAME_MAX_HEIGHT}", "fps"],
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=False
        )
    chosen = info if info.get("url") else (info.get("requested_formats") or [None])[0]
    if not chosen or not chosen.get("url"):
        raise ValueError("no playable stream")

    _close_stream_entry(cached)
    entry = {
        "url": chosen["url"],
        "format": str(chosen.get("format_id") or "0"),
        "width": chosen.get("width"),
        "height": chosen.get("height"),
        "duration": info.get("duration"),
        "size": None,
        "conn": None,
        "expires": time.time() + YOUTUBE_STREAM_CACHE_TTL,
    }
    YOUTUBE_STREAM_CACHE[video_id] = entry
    YOUTUBE_STREAM_CACHE.move_to_end(video_id)
    _evict_stream_cache(video_id)
    return entry


class _StreamFile(io.RawIOBase):
    """The stream as a seekable file, for PyAV, over one kept-alive connection.

    Handing FFmpeg the URL directly was the slow part, and by a wide margin:
    its HTTP reader opened fresh connections as the MP4 demuxer hopped between
    the index and the data, and read far past what the frame needed. Measured
    on a 1080p video at the same 3.7 MB/s line: 6.3s and 7.1s for frames at
    2:05 and 5:00, against 0.84s and 0.88s through this -- three requests and
    2.1 MB per frame, and the same pixels.

    Reads are served from 1 MB chunks, fetched with ranged GETs on a single
    HTTPS connection that is kept on the stream's cache entry between
    captures, and shared through _STREAM_CHUNKS.
    """

    def __init__(self, video_id, entry):
        super().__init__()
        self.video_id = video_id
        self.entry = entry
        self.pos = 0
        if entry["size"] is None:
            response, _ = self._fetch(0, 0)
            entry["size"] = int(response.getheader("Content-Range").rsplit("/", 1)[-1])
        self.size = entry["size"]

    # -- network ---------------------------------------------------------
    def _connect(self):
        parts = urllib.parse.urlsplit(self.entry["url"])
        # The only host this should ever talk to. A URL that points anywhere
        # else did not come from YouTube's player response.
        if parts.scheme != "https" or not (parts.hostname or "").endswith(".googlevideo.com"):
            raise ValueError("unexpected stream host")
        conn = http.client.HTTPSConnection(
            parts.hostname, parts.port or 443, context=_outbound_ssl_context(), timeout=20
        )
        self.entry["conn"] = conn
        self.entry["path"] = parts.path + ("?" + parts.query if parts.query else "")
        return conn

    def _fetch(self, start, end):
        last_error = None
        for _ in range(3):
            conn = self.entry.get("conn") or self._connect()
            try:
                conn.request(
                    "GET",
                    self.entry["path"],
                    headers={"Range": f"bytes={start}-{end}", "User-Agent": "Mozilla/5.0"},
                )
                response = conn.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    response.read()
                    self.entry["url"] = response.getheader("Location") or self.entry["url"]
                    conn.close()
                    self.entry["conn"] = None
                    continue
                body = response.read()
                if response.status != 206:
                    raise IOError(f"stream answered {response.status}")
                return response, body
            except (http.client.HTTPException, OSError) as error:
                # A kept-alive connection the server has since closed fails
                # here on first use; reconnect and try again.
                last_error = error
                with contextlib.suppress(Exception):
                    conn.close()
                self.entry["conn"] = None
        raise IOError(f"could not read the stream: {last_error}")

    def _chunk(self, index):
        global _STREAM_CHUNK_BYTES
        key = (self.video_id, self.entry["format"], index)
        with _STREAM_CHUNKS_LOCK:
            data = _STREAM_CHUNKS.get(key)
            if data is not None:
                _STREAM_CHUNKS.move_to_end(key)
                return data
        start = index * _STREAM_CHUNK_SIZE
        end = min(self.size, start + _STREAM_CHUNK_SIZE) - 1
        _, data = self._fetch(start, end)
        with _STREAM_CHUNKS_LOCK:
            if key not in _STREAM_CHUNKS:
                _STREAM_CHUNKS[key] = data
                _STREAM_CHUNK_BYTES += len(data)
                while _STREAM_CHUNK_BYTES > _STREAM_CHUNK_BUDGET and len(_STREAM_CHUNKS) > 1:
                    _, dropped = _STREAM_CHUNKS.popitem(last=False)
                    _STREAM_CHUNK_BYTES -= len(dropped)
        return data

    # -- file protocol ---------------------------------------------------
    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=io.SEEK_SET):
        if whence == io.SEEK_SET:
            self.pos = offset
        elif whence == io.SEEK_CUR:
            self.pos += offset
        else:
            self.pos = self.size + offset
        return self.pos

    def readinto(self, buffer):
        if self.pos >= self.size:
            return 0
        wanted = min(len(buffer), self.size - self.pos)
        got = 0
        while got < wanted:
            index, offset = divmod(self.pos + got, _STREAM_CHUNK_SIZE)
            data = self._chunk(index)
            count = min(len(data) - offset, wanted - got)
            if count <= 0:
                break
            buffer[got:got + count] = data[offset:offset + count]
            got += count
        self.pos += got
        return got


def _prepare_video(video_id):
    """Resolve the stream and pull its header, so the first capture is warm.

    Called when a video loads in the player. The resolve is ~3s of yt-dlp and
    the header is the first chunk; with both done, pressing "save frame" pays
    only for the frame itself.
    """
    with _video_lock(video_id):
        entry = _youtube_stream(video_id)
        _StreamFile(video_id, entry)._chunk(0)
        return entry


def _frame_to_rgb(frame):
    """The decoded frame as an RGB image, with its own colour metadata honoured.

    Video is stored in limited (TV) range; converting it as if it were full
    range lifts blacks and dulls whites. The frame says which range and matrix
    it uses, so the conversion is told rather than left to guess.
    """
    options = {"dst_color_range": "JPEG"}
    color_range = getattr(frame, "color_range", 0) or 0
    if color_range:
        options["src_color_range"] = color_range
    try:
        return frame.to_image(**options)
    except Exception:  # an older PyAV without colour-range arguments
        return frame.to_image()


def _encode_frame(image):
    """JPEG data URL at the highest quality that fits the storage budget."""
    data_url = None
    for quality in YOUTUBE_FRAME_JPEG_QUALITIES:
        buffer = io.BytesIO()
        # No optimize=True: it bought ~5% on file size for 2-4x the encode
        # time, and this is on the path someone is waiting on.
        image.save(buffer, "JPEG", quality=quality, subsampling=0)
        data_url = "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        if len(data_url) <= YOUTUBE_FRAME_MAX_DATA_URL:
            return data_url, quality
    # Still too big at the lowest quality: an extreme source. Halve it.
    smaller = image.resize((image.width // 2, image.height // 2), Image.LANCZOS)
    buffer = io.BytesIO()
    smaller.save(buffer, "JPEG", quality=YOUTUBE_FRAME_JPEG_QUALITIES[-1], subsampling=0)
    return (
        "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"),
        YOUTUBE_FRAME_JPEG_QUALITIES[-1],
    )


def _video_frame(video_id, seconds):
    """Decode the frame at ``seconds``, or None if the video cannot be read."""
    with _video_lock(video_id):
        try:
            stream_info = _youtube_stream(video_id)
        except Exception:
            logger.info("Could not resolve a stream for %s", video_id, exc_info=True)
            return None

        import av

        duration = stream_info.get("duration")
        if duration:
            # Past the end lands on the last frame rather than failing.
            seconds = min(seconds, max(0.0, duration - 0.1))

        container = None
        try:
            container = av.open(_StreamFile(video_id, stream_info), mode="r")
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            codec = stream.codec_context
            time_base = float(stream.time_base)
            # YouTube puts keyframes ~10s apart, so the seek lands up to 10s
            # early and every frame from there is decoded to reach the target.
            # B-frames are never used as references, so they can be skipped
            # until the target is close: half the frames, twice as fast, and
            # the pixels of the frame returned are byte-identical (checked at
            # three timestamps against a full decode).
            codec.skip_frame = "NONREF"
            skipping = True
            container.seek(int(seconds / time_base), stream=stream, backward=True)

            picked = None
            for frame in container.decode(stream):
                if frame.pts is None:
                    continue
                picked = frame
                at = frame.pts * time_base
                if skipping and at >= seconds - 0.6:
                    codec.skip_frame = "DEFAULT"
                    skipping = False
                if at >= seconds - 0.001:
                    break
            if picked is None:
                return None

            image = _frame_to_rgb(picked)
            if image.width > MAX_FRAME_WIDTH:
                height = round(image.height * MAX_FRAME_WIDTH / image.width)
                image = image.resize((MAX_FRAME_WIDTH, height), Image.LANCZOS)

            data_url, quality = _encode_frame(image)
            return {
                "image": data_url,
                "width": image.width,
                "height": image.height,
                "quality": quality,
                "frameTime": round(picked.pts * time_base, 3),
            }
        except Exception:
            logger.info("Could not cut a frame from %s", video_id, exc_info=True)
            # A broken connection or an expired URL: start clean next time.
            YOUTUBE_STREAM_CACHE.pop(video_id, None)
            return None
        finally:
            if container is not None:
                with contextlib.suppress(Exception):
                    container.close()


@app.route("/api/youtube/prepare")
def youtube_prepare():
    """Warm the frame cut for a video that has just been loaded.

    Fire-and-forget from the player. A failure here costs nothing: the capture
    will try again, and fall back to the storyboard if it must.
    """
    video_id = request.args.get("v", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return jsonify({"error": "Invalid video ID"}), 400
    if not YOUTUBE_FULL_FRAMES:
        return jsonify({"ready": False}), 200
    try:
        with _youtube_frame_slot():
            entry = _prepare_video(video_id)
    except _Busy:
        # Warming is optional by design, so a busy server declines it rather
        # than queueing: the capture that follows will resolve for itself.
        return jsonify({"ready": False}), 200
    except Exception:
        logger.info("Could not prepare %s", video_id, exc_info=True)
        return jsonify({"ready": False}), 200
    return jsonify({"ready": True, "width": entry.get("width"), "height": entry.get("height")})


@app.route("/api/youtube/frame")
def youtube_frame():
    video_id = request.args.get("v", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return jsonify({"error": "Invalid video ID"}), 400
    try:
        seconds = float(request.args.get("t", ""))
    except ValueError:
        seconds = math.nan
    if not math.isfinite(seconds) or not 0 <= seconds <= MAX_YOUTUBE_FRAME_SECONDS:
        return jsonify({"error": "Invalid time"}), 400

    # The video itself first, at full resolution and the exact timestamp.
    # Storyboards are the fallback: they are ~320x180 and quantised to the
    # sheet's interval, so they are a poor frame but better than none.
    source = "video"
    frame = None
    if YOUTUBE_FULL_FRAMES and request.args.get("quality") != "preview":
        try:
            with _youtube_frame_slot():
                frame = _video_frame(video_id, seconds)
        except _Busy:
            # The storyboard path below is cheap -- a small sprite sheet and a
            # crop -- so a busy server still answers with a usable frame
            # instead of an error. Falling through is the whole point of the
            # fallback existing.
            logger.info("All decode slots busy; falling back to the storyboard")

    if not frame:
        source = "storyboard"
        try:
            frame = _storyboard_frame(video_id, seconds)
        except Exception:
            logger.warning("Error cutting a storyboard frame for %s", video_id, exc_info=True)
            return jsonify({"error": "Could not reach YouTube for this frame"}), 502
        if not frame:
            return jsonify({"error": "YouTube has no preview frames for this video"}), 404

    response = jsonify({"videoId": video_id, "source": source, **frame})
    response.headers["Cache-Control"] = "private, max-age=3600"
    return response


def _import_guard(view):
    """Size cap and concurrency ceiling for the two import endpoints.

    The size check runs on Content-Length, before Flask parses the multipart
    body, so an oversized upload is refused without being read. Conversions
    beyond IMPORT_CONCURRENCY wait briefly for a slot and are then told to
    retry, instead of piling up until the instance runs out of memory.
    """
    @functools.wraps(view)
    def guarded(*args, **kwargs):
        size = request.content_length or 0
        if size > MAX_IMPORT_UPLOAD_BYTES:
            limit = MAX_IMPORT_UPLOAD_BYTES // (1024 * 1024)
            return jsonify({
                "error": f"That file is too large to import here (the limit is {limit} MB). "
                         "Try a smaller file, or split the document."
            }), 413
        if not _IMPORT_SLOTS.acquire(timeout=IMPORT_WAIT_SECONDS):
            response = jsonify({"error": "The server is busy converting other files. Try again in a moment."})
            response.headers["Retry-After"] = "10"
            return response, 503
        try:
            return view(*args, **kwargs)
        finally:
            _IMPORT_SLOTS.release()
    return guarded


@app.post("/api/ppt/import")
@_import_guard
def import_ppt():
    upload = request.files.get("ppt")
    if not upload or not upload.filename:
        return jsonify({"error": "Choose a PPT or PPTX file first."}), 400

    # Validate the extension against the original name: secure_filename() can
    # strip a non-ASCII stem entirely, which used to reject valid uploads.
    suffix = Path(upload.filename).suffix.lower()
    if suffix not in {".ppt", ".pptx"}:
        return jsonify({"error": "MAETHIST can import .ppt and .pptx files."}), 400

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
@_import_guard
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
    """Add one MAETHIST path to a page as vector geometry.

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

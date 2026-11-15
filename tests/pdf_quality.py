"""Fixtures and measurements for the PDF round-trip quality harness.

Inkyscib's promise for imported documents is that the file you upload is the
file you get back: the original page objects are preserved and annotations are
added on top as vectors. Today they are not — a page is rasterised on import
and the export is a photograph of that raster — so this module exists to state
the promise as something measurable.

Nothing here asserts. It builds documents that are hard to fake your way
through (dense vector text, a scan, mixed orientations, CJK, a form) and
measures the four things the quality contract turns on: does the text layer
survive, do the original page objects survive, did anything pick up a lossy
codec on the way through, and do the pixels still match.
"""

import hashlib
import io
from pathlib import Path

import fitz
from PIL import Image, ImageChops, ImageDraw

# Comparisons render at print resolution deliberately. A screen-resolution
# diff hides exactly the softening this harness is meant to catch.
COMPARE_DPI = 300


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------


def build_vector_pdf(directory, name="vector.pdf"):
    """Dense small text plus vector art — the LaTeX-paper case.

    Small type is where resampling shows first, so this is the fixture that
    fails loudest when a page gets rasterised.
    """
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((56, 78), "On Lossless Round Trips", fontsize=17, fontname="hebo")
    for index in range(34):
        page.insert_text(
            (56, 110 + index * 15),
            "%02d. The quick brown fox jumps over the lazy dog; 0123456789 fi fl ff." % (index + 1),
            fontsize=8,
        )
    shape = page.new_shape()
    shape.draw_circle(fitz.Point(300, 700), 70)
    shape.draw_line(fitz.Point(120, 630), fitz.Point(480, 770))
    shape.finish(color=(0.05, 0.42, 0.45), width=0.8)
    shape.commit()

    second = document.new_page(width=595, height=842)
    second.insert_text((56, 78), "Appendix A", fontsize=17, fontname="hebo")
    for index in range(20):
        second.insert_text((56, 110 + index * 15), "Row %02d — measurement, tolerance, result." % index, fontsize=8)

    path = Path(directory) / name
    document.save(path)
    document.close()
    return path


def build_scanned_pdf(directory, name="scanned.pdf"):
    """A page that is one large photograph — the scanned-textbook case.

    There is no text layer to protect here; what must survive is the image
    itself, at its own resolution and without a second codec generation.
    """
    width, height = 1654, 2339  # A4 at 200 dpi
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)
    for index in range(40):
        y = 160 + index * 52
        draw.line([(150, y), (width - 150, y)], fill=(30, 34, 38), width=3)
        draw.line([(150, y + 16), (width - 420, y + 16)], fill=(80, 88, 94), width=2)
    draw.rectangle([180, 1900, 900, 2180], outline=(20, 90, 96), width=6)

    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG")

    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_image(page.rect, stream=buffer.getvalue())
    path = Path(directory) / name
    # Deflate so the scan lands as FlateDecode — a lossless filter. That is the
    # baseline a re-encode has to be caught against: if DCTDecode shows up in
    # an export of this file, a JPEG generation was added.
    document.save(path, deflate=True, deflate_images=True)
    document.close()
    return path


def build_mixed_orientation_pdf(directory, name="mixed.pdf"):
    """Portrait, landscape and A5 in one file — page geometry must be per page."""
    document = fitz.open()
    for width, height, label in ((595, 842, "Portrait"), (842, 595, "Landscape"), (420, 595, "A5")):
        page = document.new_page(width=width, height=height)
        page.insert_text((48, 72), label, fontsize=16, fontname="hebo")
        page.insert_text((48, 100), "%d x %d pt" % (width, height), fontsize=9)
    path = Path(directory) / name
    document.save(path)
    document.close()
    return path


def build_cjk_pdf(directory, name="cjk.pdf"):
    """Non-Latin text, which is where font handling quietly drops glyphs."""
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((56, 100), "Inkyscib", fontsize=18, fontname="hebo")
    for index in range(8):
        page.insert_text((56, 140 + index * 26), "学而时习之，不亦说乎", fontsize=13, fontname="china-ss")
    path = Path(directory) / name
    document.save(path)
    document.close()
    return path


def build_form_pdf(directory, name="form.pdf"):
    """A fillable form. Flattening a page to a bitmap destroys the fields."""
    document = fitz.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((56, 80), "Enrolment form", fontsize=16, fontname="hebo")
    for index, label in enumerate(("Name", "Class", "Roll number")):
        top = 120 + index * 60
        page.insert_text((56, top), label, fontsize=9)
        widget = fitz.Widget()
        widget.field_name = label.lower().replace(" ", "_")
        widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        widget.rect = fitz.Rect(56, top + 8, 380, top + 32)
        widget.field_value = ""
        page.add_widget(widget)
    path = Path(directory) / name
    document.save(path)
    document.close()
    return path


def build_cropped_pdf(directory, name="cropped.pdf", crop=True):
    """A page whose CropBox is inset from its MediaBox — the cropped-scan case.

    PDF.js lays a page out in its CropBox, so annotations are stored relative
    to that box while the MediaBox stays larger and offset. This is the only
    fixture where the two differ, and it exists because an exporter that
    confuses them still looks perfect on every other page here: the error is
    exactly the offset between the boxes, which is zero when they agree.

    The four insets are deliberately all different, so a box picked wrongly
    cannot cancel itself out into a passing result. Pass ``crop=False`` for the
    identical page with no CropBox at all — the control that holds every other
    variable steady. The page carries no vector art of its own so that anything
    ``ink_bounds`` finds on it is annotation.
    """
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    page.insert_text((60, 90), "Cropped page", fontsize=15, fontname="hebo")
    for index in range(14):
        page.insert_text(
            (60, 130 + index * 16),
            "%02d. Body text that must survive being annotated." % (index + 1),
            fontsize=9,
        )
    if crop:
        # fitz takes this y-down from the MediaBox top, so the stored CropBox
        # is [18, 22, 588, 768] — inset 18 left, 24 right, 24 top, 22 bottom.
        page.set_cropbox(fitz.Rect(18, 24, 588, 770))

    path = Path(directory) / name
    document.save(path)
    document.close()
    return path


def build_heavy_pdf(directory, name="heavy.pdf", megabytes=8):
    """A deliberately large file, well past the old 2 MB media ceiling.

    Filled with incompressible noise so the size is real: the point is to prove
    the document store keeps whole uploads that the data-URL path could never
    have held.
    """
    import random

    random.seed(20260901)
    document = fitz.open()
    per_page = 2
    for page_number in range(max(1, round(megabytes / per_page))):
        side = 1100
        noise = bytes(random.getrandbits(8) for _ in range(side * side * 3))
        image = Image.frombytes("RGB", (side, side), noise)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", compress_level=0)

        page = document.new_page(width=595, height=842)
        page.insert_image(fitz.Rect(40, 40, 555, 555), stream=buffer.getvalue())
        page.insert_text((48, 640), "Heavy page %d" % (page_number + 1), fontsize=13, fontname="hebo")

    path = Path(directory) / name
    document.save(path)
    document.close()
    return path


FIXTURE_BUILDERS = {
    "vector": build_vector_pdf,
    "scanned": build_scanned_pdf,
    "mixed": build_mixed_orientation_pdf,
    "cjk": build_cjk_pdf,
    "form": build_form_pdf,
    "cropped": build_cropped_pdf,
}


# --------------------------------------------------------------------------
# measurements
# --------------------------------------------------------------------------


def page_texts(pdf_bytes):
    """Extracted text per page, whitespace-normalised for comparison."""
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        return [" ".join(page.get_text("text").split()) for page in document]
    finally:
        document.close()


def page_sizes(pdf_bytes):
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        return [(round(page.rect.width, 2), round(page.rect.height, 2)) for page in document]
    finally:
        document.close()


def content_stream_digests(pdf_bytes):
    """SHA-256 of each page's content stream.

    An export that adds annotations to the original leaves these alone or
    appends to them; an export that redraws the page replaces them outright.
    """
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        return [hashlib.sha256(page.read_contents()).hexdigest() for page in document]
    finally:
        document.close()


def image_filters(pdf_bytes):
    """Compression filter names used by every image on every page.

    ``DCTDecode`` is JPEG. Seeing one appear that was not in the source means
    something was re-encoded lossily on the way through.
    """
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        filters = set()
        for number in range(document.page_count):
            for image in document.get_page_images(number, full=True):
                filters.add(image[8])
        return filters
    finally:
        document.close()


def form_field_names(pdf_bytes):
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        names = set()
        for page in document:
            for widget in page.widgets():
                names.add(widget.field_name)
        return names
    finally:
        document.close()


def render_page(pdf_bytes, index=0, dpi=COMPARE_DPI):
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        pixmap = document[index].get_pixmap(dpi=dpi, colorspace=fitz.csRGB)
        return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    finally:
        document.close()


def compare_renders(left, right):
    """How far apart two rendered pages are.

    Returns the worst single-channel difference and the share of pixels that
    moved at all, which together separate "identical" from "resampled" from
    "visibly degraded" without needing a tolerance argued for up front.
    """
    if left.size != right.size:
        right = right.resize(left.size, Image.LANCZOS)

    difference = ImageChops.difference(left, right).convert("L")
    histogram = difference.histogram()
    total = sum(histogram)
    changed = sum(histogram[1:])
    worst = max((value for value, count in enumerate(histogram) if count), default=0)
    return {
        "max_channel_delta": worst,
        "changed_fraction": (changed / total) if total else 0.0,
        "identical": changed == 0,
    }


def ink_bounds(pdf_bytes, index=0):
    """The bounding box of the vector drawings on a page, or None if it has none.

    This is every drawing on the page, so it only measures annotation on a
    fixture that has no vector art of its own — `build_cropped_pdf` is the one
    built for it. On a page that draws its own shapes this returns their union
    with the ink and means nothing.

    PyMuPDF reports drawings in page coordinates — the origin at the CropBox's
    top-left corner with y growing downward — which is precisely the space
    PDF.js hands the editor and the space annotations are stored in. So for ink
    that landed correctly this box comes back in the same numbers the stroke
    was drawn at, and any offset between the two is the misplacement in points.
    """
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        page = document[index]
        box = None
        for drawing in page.get_drawings():
            rect = drawing.get("rect")
            if rect is None:
                continue
            box = rect if box is None else (box | rect)
    if box is None:
        return None
    return (box.x0, box.y0, box.x1, box.y1)


def measure(pdf_bytes):
    """Everything the contract cares about, for one document."""
    return {
        "size_bytes": len(pdf_bytes),
        "page_sizes": page_sizes(pdf_bytes),
        "texts": page_texts(pdf_bytes),
        "text_chars": sum(len(text) for text in page_texts(pdf_bytes)),
        "content_digests": content_stream_digests(pdf_bytes),
        "image_filters": image_filters(pdf_bytes),
        "form_fields": form_field_names(pdf_bytes),
    }

"""Image to text, on this server: handwritten equations and handwriting.

Two open models, both run here so a student's handwriting never goes to a
third party:

* equations: Pix2Text MFR 1.5 (breezedeus/pix2text-mfr-1.5), a formula
  recogniser trained on handwritten as well as printed maths, which writes
  LaTeX. It ships as two ONNX files (about 120 MB) and runs on ONNX Runtime
  with greedy decoding written out here, so it needs no PyTorch. It replaced
  pix2tex, which learned from typeset maths only and read a handwritten
  "x^2 + 1 = 2" as "\\chi^{\\dagger}+\\mid=\\tilde{\\alpha}";
* text: Microsoft TrOCR (base, handwritten), one line at a time. A page of
  writing is cut into lines first by a horizontal ink profile, and each line
  is read on its own.

Both are loaded on first use and then kept in memory, behind one lock, so the
first request after a deploy is slow (the weights are downloaded once from
the Hugging Face hub) and every later one is quick: about 1.5 s for an
equation and 2-4 s per line of handwriting on a laptop CPU. The image is decoded in memory and dropped when the request ends.
Nothing is written to disk, logged or kept.

OCR=off in the environment switches the feature off without a deploy.
"""

import base64
import io
import os
import re
import threading

_LOCK = threading.Lock()
_MODELS = {}

MAX_IMAGE_BYTES = 6 * 1024 * 1024
MAX_SIDE = 1600
TROCR_MODEL = os.environ.get("OCR_TEXT_MODEL", "microsoft/trocr-base-handwritten")
MFR_MODEL = os.environ.get("OCR_MATH_MODEL", "breezedeus/pix2text-mfr-1.5")
MFR_FILES = ("encoder_model.onnx", "decoder_model.onnx", "tokenizer.json")
MFR_SIZE = 384
MFR_MAX_TOKENS = 256
MFR_START, MFR_END = 1, 2


class OcrUnavailable(RuntimeError):
    """The OCR models are not installed, or the feature is switched off."""


class OcrInputError(ValueError):
    """The request did not carry a usable image."""


def enabled():
    return os.environ.get("OCR", "on").strip().lower() not in {"off", "0", "false", "no"}


def decode_image(data_url):
    """A data: URL (or bare base64) to an RGB PIL image, bounded in size."""
    from PIL import Image

    if not isinstance(data_url, str) or not data_url:
        raise OcrInputError("Send an image to convert.")
    match = re.match(r"^data:image/(png|jpeg|jpg|webp);base64,(.+)$", data_url, re.S)
    payload = match.group(2) if match else data_url
    try:
        raw = base64.b64decode(payload, validate=False)
    except (ValueError, TypeError):
        raise OcrInputError("That image could not be read.") from None
    if len(raw) > MAX_IMAGE_BYTES:
        raise OcrInputError("That image is too large; crop it to the writing and try again.")
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except Exception:
        raise OcrInputError("That image could not be read.") from None
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        # Ink drawn on a transparent canvas: put it on white, or the models see black on black.
        background = Image.new("RGB", image.size, (255, 255, 255))
        rgba = image.convert("RGBA")
        background.paste(rgba, mask=rgba.split()[-1])
        image = background
    else:
        image = image.convert("RGB")
    if max(image.size) > MAX_SIDE:
        scale = MAX_SIDE / max(image.size)
        image = image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))))
    return image


def normalise(image):
    """Dark ink on white, whatever the canvas theme was. A dark board with
    light chalk (or the editor's dark canvas) is inverted."""
    import numpy as np
    from PIL import Image, ImageOps

    grey = np.asarray(image.convert("L"), dtype=np.float32)
    if grey.mean() < 110:
        image = ImageOps.invert(image)
        grey = 255 - grey
    # Trim to the ink, with a margin, so the models see writing and not paper.
    ink = grey < 170
    if ink.any():
        ys, xs = np.where(ink)
        pad = 12
        box = (max(0, xs.min() - pad), max(0, ys.min() - pad),
               min(image.width, xs.max() + pad), min(image.height, ys.max() + pad))
        image = image.crop(box)
    return image


def has_ink(image):
    """Whether anything is written at all. A box around blank paper is
    refused rather than read: the equation reader answers an empty picture
    with confident nonsense (a run of \\newcommand definitions)."""
    import numpy as np

    grey = np.asarray(image.convert("L"), dtype=np.float32)
    if grey.mean() < 110:
        grey = 255 - grey
    return int((grey < 170).sum()) >= 24


def split_lines(image):
    """Cut a block of handwriting into lines by its horizontal ink profile."""
    import numpy as np

    grey = np.asarray(image.convert("L"), dtype=np.float32)
    ink_rows = (grey < 170).sum(axis=1)
    threshold = max(1, int(image.width * 0.004))
    rows = ink_rows > threshold
    lines = []
    start = None
    for y, on in enumerate(rows):
        if on and start is None:
            start = y
        elif not on and start is not None:
            if y - start > 6:
                lines.append((start, y))
            start = None
    if start is not None and image.height - start > 6:
        lines.append((start, image.height))
    if not lines:
        return [image]
    # Merge gaps smaller than a third of the typical line height (descenders, dots).
    heights = sorted(b - a for a, b in lines)
    typical = heights[len(heights) // 2]
    merged = [list(lines[0])]
    for a, b in lines[1:]:
        if a - merged[-1][1] < typical / 3:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    pad = 6
    return [image.crop((0, max(0, a - pad), image.width, min(image.height, b + pad))) for a, b in merged]


def _hub_file(download, repo, name):
    """The local copy when there is one. Asking the hub whether a cached
    model has changed is a network round trip on every load, and on a slow or
    filtered network it hung the first request for minutes."""
    try:
        return download(repo, name, local_files_only=True)
    except Exception:
        return download(repo, name)


def _cached_first(load, repo, **options):
    try:
        return load(repo, local_files_only=True, **options)
    except Exception:
        return load(repo, **options)


def _load(kind):
    if not enabled():
        raise OcrUnavailable("Image to text is switched off on this server.")
    with _LOCK:
        if kind in _MODELS:
            return _MODELS[kind]
        try:
            if kind == "math":
                import onnxruntime as ort
                from huggingface_hub import hf_hub_download
                from tokenizers import Tokenizer

                files = {name: _hub_file(hf_hub_download, MFR_MODEL, name) for name in MFR_FILES}
                options = ort.SessionOptions()
                options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
                providers = ["CPUExecutionProvider"]
                _MODELS[kind] = {
                    "encoder": ort.InferenceSession(files["encoder_model.onnx"], options, providers=providers),
                    "decoder": ort.InferenceSession(files["decoder_model.onnx"], options, providers=providers),
                    "tokenizer": Tokenizer.from_file(files["tokenizer.json"]),
                }
            else:
                from transformers import TrOCRProcessor, VisionEncoderDecoderModel

                processor = _cached_first(TrOCRProcessor.from_pretrained, TROCR_MODEL, use_fast=False)
                model = _cached_first(VisionEncoderDecoderModel.from_pretrained, TROCR_MODEL)
                model.eval()
                _MODELS[kind] = (processor, model)
        except ImportError:
            raise OcrUnavailable(
                "Image to text needs its models installed on the server "
                "(pip install -r requirements-ocr.txt)."
            ) from None
        return _MODELS[kind]


def clean_latex(latex):
    """The recogniser writes one token per space ("x ^ { 2 } + 3 y = 7").
    LaTeX ignores most of those spaces in maths, so they go, except where one
    ends a command name ("\\alpha b" is not "\\alphab"). A \\textsc{} wrapper
    the model sometimes puts around a capital is dropped too, and so is any
    \\newcommand definition, which is what it writes when it sees no maths
    at all: no school working ever contains one."""
    tokens = (latex or "").split()
    out = ""
    for token in tokens:
        if out and re.search(r"\\[A-Za-z]+$", out) and re.match(r"[A-Za-z]", token):
            out += " "
        out += token
    out = re.sub(r"\\textsc\{([^{}]*)\}", r"\1", out)
    out = re.sub(r"\\(?:re)?newcommand\{\\[^{}]*\}\{(?:[^{}]|\{[^{}]*\})*\}", "", out)
    return out.strip()


def read_math(image):
    import numpy as np
    from PIL import Image

    model = _load("math")
    picture = normalise(image).convert("RGB").resize((MFR_SIZE, MFR_SIZE), Image.BICUBIC)
    pixels = (np.asarray(picture, dtype=np.float32) / 255.0 - 0.5) / 0.5
    pixels = pixels.transpose(2, 0, 1)[None]
    hidden = model["encoder"].run(None, {"pixel_values": pixels})[0]
    ids = [MFR_START]
    for _ in range(MFR_MAX_TOKENS):
        logits = model["decoder"].run(None, {
            "input_ids": np.array([ids], dtype=np.int64),
            "encoder_hidden_states": hidden,
        })[0]
        token = int(logits[0, -1].argmax())
        if token == MFR_END:
            break
        ids.append(token)
    return clean_latex(model["tokenizer"].decode(ids[1:], skip_special_tokens=True))


def read_text(image):
    import torch

    processor, model = _load("text")
    lines = []
    for line in split_lines(normalise(image)):
        pixels = processor(images=line, return_tensors="pt").pixel_values
        with torch.no_grad():
            ids = model.generate(pixels, max_new_tokens=96)
        text = processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
        if text:
            lines.append(text)
    return "\n".join(lines)


def convert(data_url, kind="math"):
    """Read a handwritten image. kind is "math" (LaTeX out) or "text"."""
    image = decode_image(data_url)
    if not has_ink(image):
        raise OcrInputError("There is no writing in that box. Draw it around the ink and try again.")
    if kind == "text":
        result = {"kind": "text", "text": read_text(image)}
    else:
        result = {"kind": "math", "latex": read_math(image)}
    if not (result.get("text") or result.get("latex") or "").strip():
        raise OcrInputError("Nothing readable was found in that box.")
    return result


def warm(kind="math"):
    """Load a model ahead of the first request (used by tools and tests)."""
    _load(kind)
    return True

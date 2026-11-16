"""Build every brand image MAETHIST needs from one source icon.

    python tools/make_brand_icons.py path/to/maths.ico

Writes:
    static/logo.ico                       the favicon, every size the source has
    static/img/maethist-mark.png          256px, transparent: the logo mark on pages
    static/icons/maethist-192.png         PWA icon, transparent ("any")
    static/icons/maethist-512.png         PWA icon, transparent ("any")
    static/icons/maethist-180.png         apple-touch-icon, on paper -- iOS fills
                                          transparency with black
    static/icons/maethist-maskable-512.png  Android adaptive icon: the mark inside
                                          the 80% safe zone, on paper, because the
                                          launcher crops to a circle or squircle
    static/icons/maethist-badge-96.png    notification badge: Android draws only
                                          the alpha channel, so it is a white
                                          silhouette, not the colour mark

The source is 256px, so the 512px icons are upscaled (Lanczos). Replace the
source with a 1024px PNG or an SVG for crisper large icons, and re-run this.
"""

import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PAPER = (243, 247, 251, 255)   # --paper, light: the mark's black outlines need a light ground


def load(source):
    image = Image.open(source)
    if getattr(image, "format", "") == "ICO":
        sizes = sorted(image.info.get("sizes", {image.size}), key=lambda s: s[0])
        image.size = sizes[-1]
    return image.convert("RGBA")


def fit(mark, size, scale=1.0, background=None):
    canvas = Image.new("RGBA", (size, size), background or (0, 0, 0, 0))
    inner = max(1, round(size * scale))
    resized = mark.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.alpha_composite(resized, (offset, offset))
    return canvas


def main(source):
    source = Path(source)
    mark = load(source)
    icons = ROOT / "static" / "icons"
    img = ROOT / "static" / "img"
    img.mkdir(parents=True, exist_ok=True)

    if source.suffix.lower() == ".ico":
        shutil.copyfile(source, ROOT / "static" / "logo.ico")
    else:
        fit(mark, 256).save(ROOT / "static" / "logo.ico",
                            sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    fit(mark, 256).save(img / "maethist-mark.png", optimize=True)
    fit(mark, 192).save(icons / "maethist-192.png", optimize=True)
    fit(mark, 512).save(icons / "maethist-512.png", optimize=True)
    fit(mark, 180, scale=0.86, background=PAPER).save(icons / "maethist-180.png", optimize=True)
    fit(mark, 512, scale=0.66, background=PAPER).save(icons / "maethist-maskable-512.png", optimize=True)

    badge = fit(mark, 96, scale=0.9)
    alpha = badge.getchannel("A")
    white = Image.new("RGBA", badge.size, (255, 255, 255, 0))
    white.putalpha(alpha)
    white.save(icons / "maethist-badge-96.png", optimize=True)

    for old in icons.glob("inkyscib-*.png"):
        old.unlink()
    print("wrote", ", ".join(sorted(p.name for p in icons.glob("maethist-*.png"))),
          "and static/img/maethist-mark.png, static/logo.ico")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])

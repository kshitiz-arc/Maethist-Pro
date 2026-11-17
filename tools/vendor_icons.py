"""Vendor the icons MAETHIST uses from three open icon libraries.

    python tools/vendor_icons.py            # needs outbound network, once

MAETHIST has no build step and no node_modules, so "installing" an icon set
means copying the SVGs it actually uses into the repository, at a pinned
release, with each library's licence beside them:

    Lucide       lucide-icons/lucide       ISC      the editor: toolbar, rail,
                                                    panels, File sheet, player
    Phosphor     phosphor-icons/core       MIT      Planner, Pomodoro, the tour
    Remix Icon   Remix-Design/RemixIcon    Remix    the marketing and legal pages
                                           Icon
                                           Licence

One family per surface, so two icon styles never sit side by side in a row.

What it writes:

    static/icons/<set>/<name>.svg   one sanitised file per icon
    static/icons/LICENSES.md        the three licence texts, verbatim
    static/js/icon-set.js           the same icons as a JS registry, for
                                    scripts that build markup at runtime

Templates inline the SVG files through the `icon()` Jinja global (app.py), so
an icon is in the HTML on first paint and works without script.

Every file is sanitised on the way in: only drawing elements and drawing
attributes survive, colours are forced to currentColor, and anything else --
scripts, event handlers, links, styles, ids -- is dropped. A pinned tag is not
a reason to trust markup that ends up inlined in every page.

To add an icon: put it in ICONS below and run this again. Unknown names fail
the run rather than shipping a blank button.
"""

import concurrent.futures
import json
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "static" / "icons"
REGISTRY = ROOT / "static" / "js" / "icon-set.js"

SETS = {
    "lucide": {
        "repo": "lucide-icons/lucide",
        "tag": "1.66.0",
        "path": "icons/{name}.svg",
        "license": "LICENSE",
        "licence_name": "ISC",
        "viewBox": "0 0 24 24",
        "mode": "stroke",
    },
    "phosphor": {
        "repo": "phosphor-icons/core",
        "tag": "v2.0.8",
        "path": "assets/regular/{name}.svg",
        "license": "LICENSE",
        "licence_name": "MIT",
        "viewBox": "0 0 256 256",
        "mode": "fill",
    },
    "remix": {
        "repo": "Remix-Design/RemixIcon",
        "tag": "v4.9.1",
        # Remix files live under a category folder; resolved from the tree.
        "path": None,
        "license": "License",
        "licence_name": "Remix Icon License v1.0",
        "viewBox": "0 0 24 24",
        "mode": "fill",
    },
}

ICONS = {
    "lucide": [
        # tools
        "mouse-pointer-2", "pen-line", "eraser", "highlighter", "blocks", "drafting-compass",
        "angle", "slash", "circle-question-mark", "shapes",
        # history, view, workspace
        "undo-2", "redo-2", "trash", "zoom-in", "zoom-out", "move", "scan", "palette",
        "tv-minimal-play", "timer", "presentation", "file-down", "wand-sparkles",
        # File sheet
        "file", "plus", "upload", "clock-arrow-down", "sliders-horizontal", "calendar-check",
        "camera", "map", "folder-open", "save", "save-all", "file-text", "image", "package",
        "hard-drive-download", "book-open", "pencil-line",
        # player and general UI
        "x", "check", "circle-check", "circle-alert", "triangle-alert", "minus", "search",
        "arrow-left", "arrow-up", "arrow-down", "chevron-down", "play", "pause", "fast-forward",
        "rotate-ccw", "settings", "loader-circle", "expand", "download", "minimize-2",
        "maximize-2", "grip-vertical", "image-down", "circle", "square", "ruler", "clock",
        "contrast", "coffee", "brush-cleaning", "cloud-rain", "waves-horizontal", "brain",
        "flame", "volume-2", "volume-x", "sofa", "target", "keyboard", "layers", "copy",
    ],
    "phosphor": [
        # Pomodoro
        "play", "pause", "fast-forward", "arrow-counter-clockwise", "gear", "x", "check",
        "coffee", "cloud-rain", "waves", "couch", "fire", "brain", "target", "speaker-high",
        "speaker-x", "clock", "timer", "minus", "plus", "hourglass",
        # Planner
        "calendar-check", "calendar-blank", "caret-left", "caret-right", "caret-down", "bell",
        "bell-slash", "check-circle", "list-checks", "pencil-simple", "trash", "sun", "moon",
        "notepad", "flag",
        # tour
        "map-trifold", "sparkle", "lightbulb", "hand-pointing", "lock-simple", "pencil-line",
        "play-circle", "books", "arrow-right", "arrow-left", "cursor", "eraser",
        "highlighter-circle", "shapes", "line-segment", "arrows-out-cardinal",
        "magnifying-glass-plus", "pen-nib", "palette", "sliders-horizontal", "list-dashes",
        "notebook", "dots-nine", "floppy-disk", "files", "file-pdf", "presentation", "export",
        "camera", "webcam", "arrows-down-up", "circle-half", "clock-counter-clockwise",
        "keyboard", "repeat", "chart-bar", "squares-four", "compass-tool", "triangle",
    ],
    "remix": [
        "cursor-line", "pencil-line", "checkbox-blank-circle-line", "subtract-line",
        "triangle-line", "checkbox-blank-line", "contrast-2-line", "arrow-right-up-line",
        "arrow-right-line", "arrow-left-line", "github-line", "linkedin-box-line",
        "home-4-line", "compass-3-line", "shapes-line", "file-pdf-2-line", "wifi-off-line",
        "shield-check-line", "download-2-line", "delete-bin-line", "play-circle-line",
        "add-line", "subtract-line", "timer-line", "calendar-check-line", "check-line",
        "tablet-line", "sparkling-2-line", "book-open-line", "lock-line", "quill-pen-line",
    ],
}

ALLOWED_TAGS = {"path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g"}
ALLOWED_ATTRS = {
    "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height",
    "points", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
    "fill-rule", "clip-rule", "opacity", "transform",
}
SAFE_VALUE = re.compile(r"^[0-9A-Za-z .,\-#()%]*$")


def fetch(url):
    """curl first: it verifies with its own CA bundle, so antivirus TLS
    interception (which makes urllib hang until its timeout) does not slow
    every one of a hundred requests. urllib is the fallback for a machine
    without curl."""
    try:
        return subprocess.run(
            ["curl", "-fsSL", "--max-time", "30", url], check=True, capture_output=True
        ).stdout
    except FileNotFoundError:
        request = urllib.request.Request(url, headers={"User-Agent": "inkyscib-vendor-icons"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()


def remix_paths(tag):
    data = json.loads(fetch(
        f"https://api.github.com/repos/Remix-Design/RemixIcon/git/trees/{tag}?recursive=1"
    ))
    found = {}
    for entry in data["tree"]:
        path = entry["path"]
        if path.startswith("icons/") and path.endswith(".svg"):
            found[Path(path).stem] = path
    return found


def sanitise(raw, mode):
    """The drawing elements of one SVG, as a string, and nothing else."""
    text = raw.decode("utf-8")
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    root = ET.fromstring(text)
    out = []

    def walk(node):
        for child in node:
            tag = child.tag.rsplit("}", 1)[-1]
            if tag not in ALLOWED_TAGS:
                continue
            attrs = []
            for key, value in child.attrib.items():
                key = key.rsplit("}", 1)[-1]
                if key not in ALLOWED_ATTRS or not SAFE_VALUE.match(value):
                    continue
                if key in ("fill", "stroke"):
                    value = "none" if value == "none" else "currentColor"
                attrs.append(f'{key}="{value}"')
            if tag == "g":
                out.append("<g" + "".join(" " + a for a in attrs) + ">")
                walk(child)
                out.append("</g>")
            else:
                out.append(f"<{tag}" + "".join(" " + a for a in attrs) + "/>")

    walk(root)
    inner = "".join(out)
    if not inner:
        raise ValueError("no drawable content")
    return inner


def main():
    registry = {}
    licences = []
    for set_name, spec in SETS.items():
        base = f"https://raw.githubusercontent.com/{spec['repo']}/{spec['tag']}/"
        lookup = remix_paths(spec["tag"]) if set_name == "remix" else None
        folder = OUT_DIR / set_name
        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.glob("*.svg"):
            old.unlink()
        names = sorted(set(ICONS[set_name]))
        paths = {}
        for name in names:
            path = lookup.get(name) if lookup is not None else spec["path"].format(name=name)
            if not path:
                sys.exit(f"{set_name}: no icon called {name!r} in {spec['tag']}")
            paths[name] = path

        def get(name):
            try:
                return name, sanitise(fetch(base + paths[name]), spec["mode"])
            except subprocess.CalledProcessError:
                return name, None

        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = dict(pool.map(get, names))
        missing = [name for name, inner in results.items() if inner is None]
        if missing:
            sys.exit(f"{set_name}: not found in {spec['tag']}: {', '.join(missing)}")
        for name in names:
            inner = results[name]
            registry[f"{set_name}:{name}"] = inner
            (folder / f"{name}.svg").write_text(svg_file(set_name, inner), encoding="utf-8")
        licence = fetch(base + spec["license"]).decode("utf-8").strip()
        licences.append(
            f"## {set_name} -- {spec['repo']} {spec['tag']} ({spec['licence_name']})\n\n"
            f"Files: `static/icons/{set_name}/`, and the `{set_name}:` entries in "
            f"`static/js/icon-set.js`.\n\n```\n{licence}\n```\n"
        )
        print(f"{set_name}: {len(names)} icons from {spec['repo']}@{spec['tag']}")

    (OUT_DIR / "LICENSES.md").write_text(
        "# Icon licences\n\n"
        "MAETHIST's own code is MIT. The icons below are not: each set keeps its\n"
        "own licence, reproduced verbatim. Written by tools/vendor_icons.py.\n\n"
        + "\n".join(licences),
        encoding="utf-8",
    )

    sets = {name: {"viewBox": spec["viewBox"], "mode": spec["mode"]} for name, spec in SETS.items()}
    REGISTRY.write_text(
        "/* Generated by tools/vendor_icons.py -- do not edit by hand.\n"
        " * Lucide (ISC), Phosphor (MIT) and Remix Icon (Remix Icon License v1.0);\n"
        " * licences in static/icons/LICENSES.md. Rendered by static/js/icons.js. */\n"
        "window.InkyscibIconSet = "
        + json.dumps({"sets": sets, "icons": registry}, separators=(",", ":"), sort_keys=True)
        + ";\n",
        encoding="utf-8",
    )
    print(f"wrote {REGISTRY.relative_to(ROOT)} ({REGISTRY.stat().st_size // 1024} KB)")


def svg_file(set_name, inner):
    spec = SETS[set_name]
    if spec["mode"] == "stroke":
        attrs = ('fill="none" stroke="currentColor" stroke-width="2" '
                 'stroke-linecap="round" stroke-linejoin="round"')
    else:
        attrs = 'fill="currentColor"'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{spec["viewBox"]}" {attrs}>'
            f"{inner}</svg>\n")


if __name__ == "__main__":
    main()

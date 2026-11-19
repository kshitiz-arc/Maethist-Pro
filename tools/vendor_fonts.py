"""Self-host the two web fonts, so no visitor's IP ever reaches Google.

    python tools/vendor_fonts.py            # needs outbound network, once

Embedding fonts.googleapis.com sends every visitor's IP address to Google on
every page load, with no consent and no way to refuse it -- which is what
*LG Muenchen I, 3 O 17493/20* found unlawful. Self-hosting deletes the flow
rather than asking permission for it, and it is also faster: one same-origin
stylesheet instead of a DNS lookup, a TLS handshake and two round trips to a
third party.

What this does:

1. Fetches the Google Fonts CSS for both families with a modern-Chrome
   User-Agent. The API serves woff2 only to browsers it believes support it;
   with urllib's default User-Agent it answers with truetype, which is roughly
   twice the bytes for no benefit.
2. Downloads every woff2 the CSS references into static/fonts/.
3. Writes static/css/fonts.css: the same @font-face rules, with each src
   rewritten to the local file. font-display: swap and every unicode-range are
   carried over from the source verbatim -- the ranges are what keep a
   latin-only visitor from downloading the latin-ext subset, and retyping them
   by hand is how that optimisation gets silently lost.

It does not touch the templates, app.py or the licence file. Those three edits
are printed at the end, because each one is a judgement call in a file another
change may be in flight on.
"""

import re
import ssl
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = ROOT / "static" / "fonts"
CSS_PATH = ROOT / "static" / "css" / "fonts.css"

# Both families are SIL Open Font License 1.1.
FAMILIES = (
    "Archivo:wght@400..900",
    "Space+Grotesk:wght@400..700",
    "JetBrains+Mono:wght@400..800",
    # The handwritten line under the owner's name on About.
    "Gochi+Hand",
    # About's display type (2.7.0): a grotesque with real character for the
    # name, and a serif italic for the one phrase that carries the idea.
    "Bricolage+Grotesque:opsz,wght@12..96,400..800",
    "Instrument+Serif:ital@0;1",
)

CSS_URL = (
    "https://fonts.googleapis.com/css2?"
    + "&".join(f"family={family}" for family in FAMILIES)
    + "&display=swap"
)

# The API decides which format to serve from the User-Agent. This is a current
# Chrome string; if Google ever stops honouring it, the symptom is .ttf URLs in
# the response and a much bigger download, not a failure.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, "
    "like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

# Each @font-face block in the API response is preceded by a comment naming its
# subset (/* latin-ext */). Both are captured, so the rewritten stylesheet keeps
# the comments -- they are the only thing that makes a unicode-range readable.
_BLOCK_RE = re.compile(r"(?:/\*[^*]*\*/\s*)?@font-face\s*\{[^}]*\}", re.DOTALL)
_URL_RE = re.compile(r"url\((https://fonts\.gstatic\.com/[^)]+)\)")
_FAMILY_RE = re.compile(r"font-family:\s*'([^']+)'")
_WEIGHT_RE = re.compile(r"font-weight:\s*([^;]+);")


def fetch(url, accept_css=False):
    headers = {"User-Agent": USER_AGENT}
    if accept_css:
        headers["Accept"] = "text/css,*/*;q=0.1"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()
    except urllib.error.URLError as error:
        if not isinstance(error.reason, ssl.SSLError):
            raise
        # Antivirus HTTPS scanning installs a root whose Basic Constraints
        # extension is not marked critical, and Python 3.13+ verifies with
        # VERIFY_X509_STRICT, which rejects exactly that -- app.py hits the
        # same wall on its YouTube fetches. curl carries its own CA bundle and
        # verifies the chain fully, so handing the request to it keeps
        # verification intact rather than switching it off.
        return _fetch_via_curl(url, headers)


def _fetch_via_curl(url, headers):
    command = ["curl", "--silent", "--show-error", "--fail", "--location", "--max-time", "30"]
    for name, value in headers.items():
        command += ["--header", f"{name}: {value}"]
    command.append(url)
    try:
        finished = subprocess.run(command, capture_output=True, check=True)
    except FileNotFoundError:
        raise OSError("TLS verification failed and curl is not installed") from None
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", "replace").strip()
        raise OSError(f"curl could not fetch {url}: {detail}") from None
    return finished.stdout


def local_name(family, weight, url, index):
    """A stable, readable filename: archivo-400-900-latin-0.woff2.

    The remote name is a content hash with no family in it, so keeping it would
    make static/fonts/ unreadable and a stale file impossible to spot.
    """
    slug = family.lower().replace(" ", "-")
    weights = weight.strip().replace(" ", "-")
    suffix = Path(url).suffix or ".woff2"
    return f"{slug}-{weights}-{index}{suffix}"


def main():
    print(f"GET {CSS_URL}")
    try:
        source = fetch(CSS_URL, accept_css=True).decode("utf-8")
    except OSError as error:
        print(f"could not reach the Google Fonts API: {error}", file=sys.stderr)
        print(
            "This tool needs outbound network access. Run it on a networked "
            "machine and commit static/fonts/ and static/css/fonts.css.",
            file=sys.stderr,
        )
        return 1

    if ".woff2" not in source:
        print(
            "the API served no woff2 -- the User-Agent above is no longer "
            "recognised as a modern browser; update USER_AGENT and retry",
            file=sys.stderr,
        )
        return 1

    FONT_DIR.mkdir(parents=True, exist_ok=True)
    CSS_PATH.parent.mkdir(parents=True, exist_ok=True)

    # The response is a run of @font-face blocks, each preceded by a comment
    # naming its subset (/* latin-ext */). Rewriting it block by block keeps
    # every declaration the API sent -- unicode-range, font-style,
    # font-display -- instead of reconstructing a guess at them.
    downloaded = {}
    rewritten = []
    counters = {}

    for found in _BLOCK_RE.finditer(source):
        block = found.group(0).strip()
        family_match = _FAMILY_RE.search(block)
        weight_match = _WEIGHT_RE.search(block)
        if not family_match:
            continue
        family = family_match.group(1)
        weight = weight_match.group(1) if weight_match else "400"

        def replace(match, family=family, weight=weight):
            url = match.group(1)
            if url not in downloaded:
                index = counters.get(family, 0)
                counters[family] = index + 1
                name = local_name(family, weight, url, index)
                target = FONT_DIR / name
                print(f"  {url}\n    -> static/fonts/{name}", end="")
                payload = fetch(url)
                target.write_bytes(payload)
                print(f"  ({len(payload) // 1024} KB)")
                downloaded[url] = name
            return f"url('../fonts/{downloaded[url]}')"

        rewritten.append(_URL_RE.sub(replace, block).rstrip())

    if not downloaded:
        print("no font URLs found in the response", file=sys.stderr)
        return 1

    header = (
        "/* Self-hosted so no visitor's IP reaches a third party. Generated by\n"
        "   tools/vendor_fonts.py -- re-run it to pick up a new subset or weight,\n"
        "   do not hand-edit. Both families are SIL Open Font License 1.1; the\n"
        "   licence is in static/fonts/OFL.txt as that licence requires.\n"
        f"   Source: {CSS_URL} */\n\n"
    )
    CSS_PATH.write_text(header + "\n\n".join(rewritten) + "\n", encoding="utf-8")

    total = sum((FONT_DIR / name).stat().st_size for name in downloaded.values())
    print(
        f"\n{len(downloaded)} woff2 files, {total // 1024} KB total\n"
        f"wrote {CSS_PATH} ({len(rewritten)} @font-face rules)"
    )

    print(
        "\n"
        "Three edits are left, and they are deliberately not automated:\n"
        "\n"
        "  1. templates/_marketing.html and templates/write.html -- replace the\n"
        "     Google font <link> tags with the local stylesheet:\n"
        "\n"
        "       <link rel=\"preload\" as=\"font\" type=\"font/woff2\" crossorigin\n"
        "         href=\"{{ url_for('static', filename='fonts/"
        f"{sorted(downloaded.values())[0]}', v='fonts-1') }}\">\n"
        "       <link rel=\"stylesheet\"\n"
        "         href=\"{{ url_for('static', filename='css/fonts.css', v='fonts-1') }}\">\n"
        "\n"
        "     The media=\"print\" non-blocking trick goes with them: a same-origin\n"
        "     stylesheet is not a render-blocking problem.\n"
        "\n"
        "  2. app.py, CONTENT_SECURITY_POLICY -- drop\n"
        "     https://fonts.googleapis.com from style-src and\n"
        "     https://fonts.gstatic.com from font-src. Both fall back to 'self'.\n"
        "\n"
        "  3. static/fonts/OFL.txt -- copy the SIL Open Font License 1.1 text in\n"
        "     beside the woff2 files. Redistributing the fonts without it is a\n"
        "     licence breach, and this tool will not invent a licence file.\n"
        "\n"
        "Then run: python -m pytest tests/test_analytics_csp.py tests/test_seo.py -q\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

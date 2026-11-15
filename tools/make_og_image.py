"""Generate static/img/og-cover.png, the 1200x630 social share card.

Run it again whenever the homepage hero changes:

    python tools/make_og_image.py

It screenshots the real homepage rather than compositing a mock, so the card
cannot drift from what a visitor actually lands on. Playwright is a dev-only
dependency; the app does not need it to run.
"""

import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from PIL import Image  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

from app import app  # noqa: E402
from browser_server import make_browser_server  # noqa: E402

OUTPUT = ROOT / "static" / "img" / "og-cover.png"


def main():
    server = make_browser_server(app)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{server.server_port}"

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(
            viewport={"width": 1200, "height": 630}, device_scale_factor=1
        )
        # The first-run tour would otherwise cover the hero.
        page.add_init_script(
            "localStorage.setItem('inkyscib-feature-tour-v1', 'dismissed')"
        )
        page.goto(f"{base_url}/", wait_until="networkidle")
        page.wait_for_timeout(800)  # the hero's construction settles
        page.screenshot(path=str(OUTPUT))
        browser.close()

    server.shutdown()

    # The card is flat brand colour and line art, so a 256-colour palette is
    # visually lossless here and cuts the file by roughly two thirds.
    with Image.open(OUTPUT) as raw:
        quantised = raw.convert("RGB").quantize(colors=256, method=Image.MEDIANCUT)
        quantised.save(OUTPUT, optimize=True)

    print(f"{OUTPUT} -> {OUTPUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()

import base64
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import app as inkyscib


def image_data_url(width, height, color):
    output = io.BytesIO()
    inkyscib.Image.new("RGB", (width, height), color).save(output, "PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def picture_placement(package, slide_number):
    root = ET.fromstring(package.read(f"ppt/slides/slide{slide_number}.xml"))
    picture = next(node for node in root.iter() if node.tag.endswith("pic"))
    transform = next(node for node in picture.iter() if node.tag.endswith("xfrm"))
    offset = next(node for node in transform if node.tag.endswith("off"))
    extent = next(node for node in transform if node.tag.endswith("ext"))
    return tuple(int(value) for value in (
        offset.attrib["x"],
        offset.attrib["y"],
        extent.attrib["cx"],
        extent.attrib["cy"],
    ))


@unittest.skipIf(inkyscib.Image is None, "Pillow is required")
class NativeDocumentSizeTests(unittest.TestCase):
    def setUp(self):
        self.client = inkyscib.app.test_client()

    @unittest.skipIf(inkyscib._pymupdf is None, "PyMuPDF is required")
    def test_pdf_export_preserves_each_native_page_size(self):
        slides = [
            {"image": image_data_url(396, 306, "red"), "width": 792, "height": 612, "unit": "pt"},
            {"image": image_data_url(306, 396, "green"), "width": 612, "height": 792, "unit": "pt"},
            {"image": image_data_url(250, 350, "blue"), "width": 500, "height": 700, "unit": "pt"},
        ]

        response = self.client.post("/api/ppt/export/pdf", json={"filename": "native", "slides": slides})
        self.assertEqual(response.status_code, 200)

        document = inkyscib._pymupdf.open(stream=response.data, filetype="pdf")
        try:
            sizes = [(round(page.rect.width, 3), round(page.rect.height, 3)) for page in document]
        finally:
            document.close()
        self.assertEqual(sizes, [(792.0, 612.0), (612.0, 792.0), (500.0, 700.0)])

    def test_pptx_export_keeps_exact_emu_and_contains_mixed_aspects(self):
        native_width = 10_123_457
        native_height = 7_654_321
        slides = [
            {
                "image": image_data_url(1012, 765, "red"),
                "width": native_width / 9525,
                "height": native_height / 9525,
                "unit": "px",
                "sourceWidthEmu": native_width,
                "sourceHeightEmu": native_height,
            },
            {"image": image_data_url(90, 120, "green"), "width": 720, "height": 960, "unit": "px"},
            {"image": image_data_url(160, 90, "blue"), "width": 1280, "height": 720, "unit": "px"},
        ]

        response = self.client.post("/api/ppt/export/pptx", json={"filename": "native", "slides": slides})
        self.assertEqual(response.status_code, 200)

        with zipfile.ZipFile(io.BytesIO(response.data)) as package:
            presentation = ET.fromstring(package.read("ppt/presentation.xml"))
            size = next(node for node in presentation.iter() if node.tag.endswith("sldSz"))
            deck_size = (int(size.attrib["cx"]), int(size.attrib["cy"]))
            self.assertEqual(deck_size, (native_width, native_height))
            self.assertEqual(picture_placement(package, 1), (0, 0, native_width, native_height))

            for slide_number, source in ((2, slides[1]), (3, slides[2])):
                x, y, width, height = picture_placement(package, slide_number)
                self.assertGreaterEqual(x, 0)
                self.assertGreaterEqual(y, 0)
                self.assertLessEqual(width, native_width)
                self.assertLessEqual(height, native_height)
                self.assertAlmostEqual(width / height, source["width"] / source["height"], places=5)

    def test_server_pptx_import_uses_native_page_pixels_and_returns_emu(self):
        width_emu = 6_858_000
        height_emu = 9_144_000
        slides = [{
            "image": image_data_url(720, 960, "purple"),
            "width": 720,
            "height": 960,
            "unit": "px",
            "sourceWidthEmu": width_emu,
            "sourceHeightEmu": height_emu,
        }]
        response = self.client.post("/api/ppt/export/pptx", json={"filename": "portrait", "slides": slides})
        self.assertEqual(response.status_code, 200)

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "portrait.pptx"
            destination = Path(directory) / "slides"
            destination.mkdir()
            source.write_bytes(response.data)
            rendered, imported_width_emu, imported_height_emu = inkyscib.convert_pptx_basic(source, destination)
            with inkyscib.Image.open(rendered[0]) as image:
                self.assertEqual(image.size, (720, 960))

        self.assertEqual((imported_width_emu, imported_height_emu), (width_emu, height_emu))

    def test_large_custom_ppt_backing_raster_is_bounded(self):
        native_width = 56 * inkyscib.CSS_PIXELS_PER_INCH
        native_height = 30 * inkyscib.CSS_PIXELS_PER_INCH
        render_width, render_height = inkyscib.bounded_ppt_render_size(native_width, native_height)

        self.assertLessEqual(render_width, inkyscib.MAX_PPT_RENDER_SIDE)
        self.assertLessEqual(render_height, inkyscib.MAX_PPT_RENDER_SIDE)
        self.assertLessEqual(
            render_width * render_height,
            inkyscib.MAX_PPT_RENDER_PIXELS
        )
        self.assertAlmostEqual(
            render_width / render_height,
            native_width / native_height,
            places=2
        )


if __name__ == "__main__":
    unittest.main()

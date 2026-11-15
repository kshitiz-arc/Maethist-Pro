"""Server-side privacy invariants: logs that carry no personal data, uploads
that outlive nothing.

No browser here -- all three are things a unit test and a test client can see.
"""

import io
import json
import logging
import re
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

import logging_filters
from app import app

class LogRedactionTests(unittest.TestCase):
    def test_an_ipv4_address_loses_its_last_octet(self):
        self.assertEqual(logging_filters.anonymise_ip("203.0.113.47"), "203.0.113.0")

    def test_an_ipv6_address_is_truncated_to_a_48_bit_prefix(self):
        self.assertEqual(
            logging_filters.anonymise_ip("2001:db8:85a3:8d3:1319:8a2e:370:7348"),
            "2001:db8:85a3::",
        )

    def test_loopback_is_left_alone(self):
        """127.0.0.1 identifies nobody, and truncating it rewrote the dev
        server's own startup banner to a URL that does not work."""
        for address in ("127.0.0.1", "::1"):
            with self.subTest(address=address):
                self.assertEqual(logging_filters.anonymise_ip(address), address)

        record = logging.LogRecord("t", logging.INFO, __file__, 1,
                                   "Running on http://127.0.0.1:8977", None, None)
        logging_filters.RedactPII().filter(record)
        self.assertIn("127.0.0.1:8977", record.getMessage())

    def test_a_log_record_carrying_an_address_is_rewritten_in_place(self):
        record = logging.LogRecord("t", logging.INFO, __file__, 1,
                                   "import from 203.0.113.47 ok", None, None)
        logging_filters.RedactPII().filter(record)
        self.assertNotIn("203.0.113.47", record.getMessage())
        self.assertIn("203.0.113.0", record.getMessage())

    def test_an_uploaded_filename_never_reaches_the_log(self):
        record = logging.LogRecord("t", logging.INFO, __file__, 1,
                                   'converted "Rahul medical report.pdf"', None, None)
        logging_filters.RedactPII().filter(record)
        self.assertNotIn("Rahul", record.getMessage())
        self.assertIn("[filename]", record.getMessage())

    def test_an_email_address_never_reaches_the_log(self):
        record = logging.LogRecord("t", logging.INFO, __file__, 1,
                                   "contact kz@sbpsranchi.com", None, None)
        logging_filters.RedactPII().filter(record)
        self.assertNotIn("@", record.getMessage())


class UploadLifetimeTests(unittest.TestCase):
    """Every import path converts inside a tempfile.TemporaryDirectory, so the
    file is gone when the request ends even if it raised. These pin that."""

    def setUp(self):
        self.client = app.test_client()

    def test_a_failed_import_also_leaves_nothing_on_disk(self):
        before = set(Path(tempfile.gettempdir()).glob("inkyscib_*"))
        self.client.post(
            "/api/pdf/import",
            data={"file": (io.BytesIO(b"not a pdf"), "x.pdf")},
        )
        after = set(Path(tempfile.gettempdir()).glob("inkyscib_*"))
        self.assertEqual(after - before, set())

    def test_the_app_never_writes_an_uploaded_file_outside_a_temp_directory(self):
        """A source check, because the failure this guards against is a future
        edit rather than a runtime bug: `upload.save(somewhere_permanent)` is
        one line, and it would silently turn a local-first product into one
        that keeps other people's documents.

        Every `upload.save(X)` must name a variable assigned from `temp_dir`,
        and every one of those assignments must sit inside a
        `tempfile.TemporaryDirectory` block. Other `.save(` calls in app.py are
        Pillow and PyMuPDF writing to in-memory buffers, which is why this
        looks at the receiver rather than the method name.
        """
        source = Path(app.root_path, "app.py").read_text(encoding="utf-8")
        lines = source.splitlines()

        saved = re.findall(r"upload\.save\(\s*([A-Za-z_][\w]*)\s*\)", source)
        self.assertTrue(saved, "no upload.save() call found - has the API moved?")

        # Follow the chain transitively: the PPT path goes
        # temp_dir -> temp_path = Path(temp_dir) -> source_path = temp_path / ...
        rooted = {"temp_dir"}
        for _ in range(4):          # four hops is far more than any path uses
            for line in lines:
                match = re.match(r"\s*([A-Za-z_][\w]*)\s*=\s*(.+)$", line)
                if match and any(root in match.group(2) for root in rooted):
                    rooted.add(match.group(1))

        for name in set(saved):
            with self.subTest(variable=name):
                assignments = [
                    line for line in lines
                    if re.match(rf"\s*{re.escape(name)}\s*=", line)
                ]
                self.assertTrue(assignments, f"{name} is never assigned")
                self.assertIn(
                    name, rooted,
                    f"{name} is not derived from a TemporaryDirectory",
                )
                for assignment in assignments:
                    self.assertTrue(
                        any(root in assignment for root in rooted),
                        f"an upload is written to a path not rooted in a "
                        f"temporary directory: {assignment.strip()}",
                    )

        # One temporary directory per upload path, so none of them shares or
        # outlives a request.
        self.assertGreaterEqual(
            source.count("tempfile.TemporaryDirectory("), len(saved)
        )

        # And nothing writes an upload straight to a caller-named path.
        self.assertNotIn("upload.save(filename", source)
        self.assertNotIn("upload.save(secure_filename", source)

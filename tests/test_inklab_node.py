"""Runs InkLab's Node unit tests from pytest.

The pure parts of InkLab - the ring buffer, the width reference, the predictor -
are tested in Node (`tests/inklab/*.test.cjs`), because they need no browser and
run in milliseconds. This wrapper keeps `python -m pytest tests/ -q` the one
command that runs every layer.
"""

import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
class InkLabNodeTests(unittest.TestCase):
    def test_inklab_node_unit_tests_pass(self):
        files = sorted((ROOT / "tests" / "inklab").glob("*.test.cjs"))
        self.assertTrue(files, "no InkLab Node tests were found")

        result = subprocess.run(
            ["node", "--test", *[str(path) for path in files]],
            capture_output=True,
            # Node's reporter prints non-ASCII marks; the Windows default
            # codepage cannot decode them.
            encoding="utf-8",
            errors="replace",
            timeout=180,
            cwd=ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

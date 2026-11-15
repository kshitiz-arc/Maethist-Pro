"""Covers the helper every browser test starts its server with.

Chromium refuses to navigate to a fixed list of ports before it even connects,
so a server the OS happens to put on one of them fails every test in its class
with net::ERR_UNSAFE_PORT (TODOS.md item 10). The OS cannot be made to hand out
a blocked port on demand, so most of these tests give the helper a fake bind.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from app import app
from browser_server import make_browser_server


# The ports Chromium 151 blocks inside this machine's dynamic port range
# (1024-65534), found by navigating the browser to every Fetch "bad port".
BLOCKED_IN_DYNAMIC_RANGE = [
    1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000,
    6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]

ALLOWED = 8123


class FakeServer:
    def __init__(self, os, port):
        self.os = os
        self.server_port = port

    def server_close(self):
        self.os.open_ports.discard(self.server_port)


class FakeOS:
    """Binds port 0 to the first port in `ports` that no open server holds.

    That is the worst case for a retry: a port the helper gives back is handed
    straight out again."""

    MAX_BINDS = 50

    def __init__(self, ports):
        self.ports = ports
        self.open_ports = set()
        self.binds = 0

    def bind(self, host, port, app=None, threaded=False):
        assert (host, port, threaded) == ("127.0.0.1", 0, True), (host, port, threaded)
        self.binds += 1
        if self.binds > self.MAX_BINDS:
            raise AssertionError("the helper kept binding and never settled on a port")
        for candidate in self.ports:
            if candidate not in self.open_ports:
                self.open_ports.add(candidate)
                return FakeServer(self, candidate)
        raise OSError("no free port")


class BrowserServerTests(unittest.TestCase):
    def test_a_blocked_port_is_given_back_and_bound_again(self):
        os = FakeOS([4045, ALLOWED])

        server = make_browser_server(app, bind=os.bind)

        self.assertEqual(server.server_port, ALLOWED)
        self.assertEqual(os.open_ports, {ALLOWED}, "the server on the blocked port was left open")

    def test_every_blocked_port_in_this_machines_range_is_refused(self):
        for port in BLOCKED_IN_DYNAMIC_RANGE:
            with self.subTest(port=port):
                os = FakeOS([port, ALLOWED])

                server = make_browser_server(app, bind=os.bind)

                self.assertEqual(server.server_port, ALLOWED)

    def test_a_run_of_blocked_ports_never_comes_back(self):
        os = FakeOS([6665, 6666, 6667, 6668, 6669, ALLOWED])

        server = make_browser_server(app, bind=os.bind)

        self.assertEqual(server.server_port, ALLOWED)
        self.assertEqual(os.open_ports, {ALLOWED})
        self.assertEqual(os.binds, 6)

    def test_an_allowed_port_is_kept(self):
        os = FakeOS([ALLOWED])

        server = make_browser_server(app, bind=os.bind)

        self.assertEqual(server.server_port, ALLOWED)
        self.assertEqual(os.binds, 1)

    def test_the_real_server_is_threaded_on_loopback(self):
        server = make_browser_server(app)
        self.addCleanup(server.server_close)

        self.assertEqual(server.host, "127.0.0.1")
        self.assertTrue(server.multithread)
        self.assertNotIn(server.server_port, BLOCKED_IN_DYNAMIC_RANGE)


if __name__ == "__main__":
    unittest.main()

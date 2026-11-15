"""Starts the local server a browser test drives.

The OS picks the port, and Chromium refuses to navigate to a fixed list of them
before it even connects - `net::ERR_UNSAFE_PORT`, failing every test in the
class. On a machine whose dynamic port range is wide (this one's is 1024-65534)
the OS can hand one out. See TODOS.md item 10.
"""

from werkzeug.serving import make_server


# The Fetch standard's "bad ports". Chromium 151 blocks 80 of these 82 (not 4190
# or 6679); refusing those two as well costs nothing.
BLOCKED_PORTS = frozenset({
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
    87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
    139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
    540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
    2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
    6679, 6697, 10080,
})


def make_browser_server(app, bind=make_server):
    """A threaded server for `app` on 127.0.0.1, on a port Chromium will open.

    A server that lands on a blocked port stays open until a usable one is
    found, so the OS cannot hand the same port straight back."""
    rejected = []
    try:
        server = bind("127.0.0.1", 0, app, threaded=True)
        while server.server_port in BLOCKED_PORTS:
            rejected.append(server)
            server = bind("127.0.0.1", 0, app, threaded=True)
    finally:
        for blocked in rejected:
            blocked.server_close()
    return server

"""The live class board (2.10.0): a teacher's page, followed live by a class.

The teacher starts a board from the editor and gets a six-letter code and a
QR code. Anyone who opens /live/<code> sees the teacher's ink as it is
written. No accounts: the code is the address, and only the browser that
started the board holds the key that can write to it.

What lives here, and for how long
---------------------------------
A board is held in this server process's memory, never written to disk:

- the ink on the teacher's page (the same strokes the editor saves locally),
  the part of the page the teacher is looking at, and the page colour;
- a hash of the teacher's key;
- when it was started and last written to.

It is deleted when the teacher ends it (after a short grace so a student's
page can say "class ended"), after BOARD_IDLE_SECONDS with no writing, or
when the server restarts. Nothing about the people watching is kept: a
student's request carries only the code and the last version it saw.

Because boards are in memory, the server must run as one process
(gunicorn.conf.py's default WEB_CONCURRENCY=1; more threads are fine).

Protocol
--------
POST /api/live                      -> {code, key}
POST /api/live/<code>  (X-Live-Key) <- {order?, set?, live?, view?, bg?, theme?}
GET  /api/live/<code>?since=<v>     -> 204 if nothing changed, else
                                       {v, order?, set, live?, view, bg, theme, ended}
DELETE /api/live/<code> (X-Live-Key)   ends the board

Each stroke has a short id chosen by the teacher's page. A push sends only
the strokes that changed and, when it changed, the order of ids on the page
(which also says what was removed). A poll gets everything changed since the
version it last saw, so a student who joins late, or loses the network for
a minute, catches up in one request.
"""

import hashlib
import hmac
import json
import secrets
import threading
import time

from flask import Blueprint, Response, abort, jsonify, render_template, request

from qr_svg import qr_svg

live = Blueprint("live", __name__)

# Unambiguous letters and digits (no 0/O, 1/I/L): 31^6 is about 887 million.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 6
BOARD_IDLE_SECONDS = 2 * 60 * 60
ENDED_GRACE_SECONDS = 10 * 60
MAX_BOARDS = 300
MAX_BOARD_BYTES = 24 * 1024 * 1024
MAX_PUSH_BYTES = 8 * 1024 * 1024
MAX_PATH_BYTES = 6 * 1024 * 1024
MAX_PATHS = 20000
MAX_ID_CHARS = 24

_BOARDS = {}
_LOCK = threading.Lock()
_last_sweep = [0.0]


def _hash_key(key):
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _sweep(now):
    """Forget boards that ended or went quiet. Called under _LOCK."""
    if now - _last_sweep[0] < 30:
        return
    _last_sweep[0] = now
    for code in list(_BOARDS):
        board = _BOARDS[code]
        if board["ended_at"] and now - board["ended_at"] > ENDED_GRACE_SECONDS:
            del _BOARDS[code]
        elif now - board["touched"] > BOARD_IDLE_SECONDS:
            del _BOARDS[code]


def _clean_code(code):
    code = (code or "").strip().upper()
    if len(code) != CODE_LENGTH or any(c not in CODE_ALPHABET for c in code):
        return None
    return code


def _board_for_teacher(code):
    """The board, if the request carries its key; aborts otherwise."""
    code = _clean_code(code)
    board = _BOARDS.get(code) if code else None
    if board is None:
        abort(404)
    key = request.headers.get("X-Live-Key", "")
    if not hmac.compare_digest(_hash_key(key), board["key_hash"]):
        abort(403)
    return board


@live.route("/api/live", methods=["POST"])
def create():
    now = time.monotonic()
    with _LOCK:
        _sweep(now)
        if len(_BOARDS) >= MAX_BOARDS:
            return jsonify({"error": "Too many live boards are running right now. Try again in a few minutes."}), 503
        while True:
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            if code not in _BOARDS:
                break
        key = secrets.token_urlsafe(24)
        _BOARDS[code] = {
            "key_hash": _hash_key(key),
            "created": now,
            "touched": now,
            "ended_at": None,
            "version": 1,
            "paths": {},  # id -> (version changed, json text)
            "order": [],
            "order_v": 1,
            "live": None,
            "live_v": 1,
            "view": None,
            "bg": None,
            "theme": None,
            "bytes": 0,
        }
    return jsonify({"code": code, "key": key})


def _valid_id(value):
    return isinstance(value, str) and 0 < len(value) <= MAX_ID_CHARS and value.isascii() and value.isalnum()


def _short_text(value, limit=40):
    return value if isinstance(value, str) and len(value) <= limit else None


@live.route("/api/live/<code>", methods=["POST"])
def push(code):
    if (request.content_length or 0) > MAX_PUSH_BYTES:
        abort(413)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        abort(400)
    now = time.monotonic()
    with _LOCK:
        board = _board_for_teacher(code)
        if board["ended_at"]:
            return jsonify({"error": "This board has ended."}), 410
        version = board["version"] + 1
        changed = False

        updates = payload.get("set") or {}
        if not isinstance(updates, dict):
            abort(400)
        for pid, path in updates.items():
            if not _valid_id(pid) or not isinstance(path, dict):
                abort(400)
            text = json.dumps(path, separators=(",", ":"))
            if len(text) > MAX_PATH_BYTES:
                continue  # too big to send (a huge image): the class just misses it
            old = board["paths"].get(pid)
            board["bytes"] += len(text) - (len(old[1]) if old else 0)
            board["paths"][pid] = (version, text)
            changed = True

        if "order" in payload:
            order = payload["order"]
            if not isinstance(order, list) or len(order) > MAX_PATHS or not all(_valid_id(i) for i in order):
                abort(400)
            board["order"] = order
            board["order_v"] = version
            keep = set(order)
            for pid in [p for p in board["paths"] if p not in keep]:
                board["bytes"] -= len(board["paths"].pop(pid)[1])
            changed = True

        if "live" in payload:
            stroke = payload["live"]
            if stroke is not None and not isinstance(stroke, dict):
                abort(400)
            text = json.dumps(stroke, separators=(",", ":")) if stroke else None
            board["live"] = text if text is None or len(text) <= MAX_PATH_BYTES else None
            board["live_v"] = version
            changed = True

        view = payload.get("view")
        if isinstance(view, dict):
            try:
                clean = {k: float(view[k]) for k in ("x", "y", "w", "h")}
            except (KeyError, TypeError, ValueError):
                abort(400)
            if all(abs(v) < 1e9 for v in clean.values()) and clean["w"] > 0 and clean["h"] > 0:
                if clean != board["view"]:
                    board["view"] = clean
                    changed = True
        for field in ("bg", "theme"):
            value = _short_text(payload.get(field))
            if value is not None and value != board[field]:
                board[field] = value
                changed = True

        if board["bytes"] > MAX_BOARD_BYTES:
            return jsonify({"error": "This page is too big to share live."}), 413
        board["touched"] = now
        if changed:
            board["version"] = version
        return jsonify({"v": board["version"]})


@live.route("/api/live/<code>", methods=["GET"])
def poll(code):
    code = _clean_code(code)
    try:
        since = int(request.args.get("since", "0"))
    except ValueError:
        since = 0
    with _LOCK:
        _sweep(time.monotonic())
        board = _BOARDS.get(code) if code else None
        if board is None:
            return jsonify({"error": "No live board has this code."}), 404
        if since == board["version"] and not board["ended_at"]:
            return Response(status=204)
        fresh = since <= 0 or since > board["version"]
        out = {
            "v": board["version"],
            "set": {pid: text for pid, (v, text) in board["paths"].items() if fresh or v > since},
            "view": board["view"],
            "bg": board["bg"],
            "theme": board["theme"],
            "ended": bool(board["ended_at"]),
        }
        if fresh or board["order_v"] > since:
            out["order"] = board["order"]
        if fresh or board["live_v"] > since:
            out["live"] = board["live"]
    # Paths are stored as JSON text, so splice them in rather than re-parse.
    sets = ",".join(f"{json.dumps(pid)}:{text}" for pid, text in out.pop("set").items())
    live_text = out.pop("live", "__absent__")
    body = json.dumps(out, separators=(",", ":"))[:-1] + ',"set":{' + sets + "}"
    if live_text != "__absent__":
        body += ',"live":' + (live_text or "null")
    body += "}"
    response = Response(body, mimetype="application/json")
    response.headers["Cache-Control"] = "no-store"
    return response


@live.route("/api/live/<code>", methods=["DELETE"])
def end(code):
    with _LOCK:
        board = _board_for_teacher(code)
        board["ended_at"] = time.monotonic()
        board["version"] += 1
        board["paths"].clear()
        board["order"] = []
        board["order_v"] = board["version"]
        board["live"] = None
        board["live_v"] = board["version"]
        board["bytes"] = 0
    return jsonify({"ended": True})


@live.route("/api/live/<code>/qr.svg")
def qr(code):
    code = _clean_code(code)
    if not code:
        abort(404)
    url = request.host_url.rstrip("/") + "/live/" + code
    response = Response(qr_svg(url), mimetype="image/svg+xml")
    response.headers["Cache-Control"] = "private, max-age=3600"
    return response


@live.route("/live")
@live.route("/live/<code>")
def viewer(code=None):
    clean = _clean_code(code) if code else None
    return render_template("live.html", code=clean or "", asked=(code or "")[:12], nav_active="")

"""Live dashboard + Prometheus metrics for outage-watch (stdlib only)."""
import base64
import hashlib
import json
import os
import re
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

STATE_NUM = {"up": 0, "warning": 1, "suspect": 2, "down": 3, "blocked": 4}
LEVEL_NUM = {"ok": 0, "caution": 1, "freeze": 2}
HISTORY = 120      # probe rounds kept in memory for the dashboard's replay / sparklines
SLOW_MS = 3000     # probe() itself reports "degraded" above this, whatever the baseline


def _default_edges():
    try:
        import outagewatch
        return outagewatch.dependency_edges()
    except Exception:
        return []


class Snapshot:
    """Thread-safe latest status, written by the probe loop, read by the server.

    Extra (backwards compatible) fields for the blast-radius dashboard:
      services[name].baseline / .warn_ms  learned latency baseline and warning threshold (ms, or null)
      edges     [[upstream, dependent], ...] dependency graph
      interval  seconds between probe rounds
      history   last HISTORY rounds, only with /status.json?history=1
    """

    def __init__(self, edges=None, interval=60):
        self._lock = threading.Lock()
        self._edges = _default_edges() if edges is None else [list(e) for e in edges]
        self._interval, self._hist = interval, deque(maxlen=HISTORY)
        self._data = {"updated": None, "level": "ok", "verdict": "starting", "services": {}}

    def update(self, ts, level, verdict, results, published, monitor=None):
        svc = {}
        for r in results:
            base = monitor.baseline(r["name"]) if monitor else None
            warn = SLOW_MS if base is None else round(min(SLOW_MS, max(base * monitor.factor, base + monitor.floor_ms)))
            svc[r["name"]] = {"state": published.get(r["name"], r["state"]), "code": r["code"], "ms": r["ms"],
                              "error": r["error"], "baseline": base, "warn_ms": warn}
        with self._lock:
            self._data = {"updated": ts, "level": level, "verdict": verdict, "services": svc}
            self._hist.append(self._data)

    def get(self, history=False):
        with self._lock:
            d = dict(self._data, edges=self._edges, interval=self._interval)
            if history:
                d["history"] = list(self._hist)
            return json.loads(json.dumps(d))


def _label(v):
    return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def metrics_text(d):
    out = ["# TYPE outagewatch_service_state gauge",
           "# HELP outagewatch_service_state 0=up 1=warning 2=suspect 3=down"]
    for n, s in sorted(d["services"].items()):
        out.append(f'outagewatch_service_state{{service="{_label(n)}"}} {STATE_NUM.get(s["state"], 3)}')
    out.append("# TYPE outagewatch_latency_ms gauge")
    for n, s in sorted(d["services"].items()):
        out.append(f'outagewatch_latency_ms{{service="{_label(n)}"}} {s["ms"]}')
    out += ["# TYPE outagewatch_level gauge", f'outagewatch_level {LEVEL_NUM.get(d["level"], 2)}']
    return "\n".join(out) + "\n"


with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.html"), encoding="utf-8") as _f:
    PAGE = _f.read()


def _csp(page):
    """Strict policy: nothing external; only the page's own inline <script>/<style>, pinned by hash."""
    def hashes(tag):
        return " ".join("'sha256-" + base64.b64encode(hashlib.sha256(m.encode()).digest()).decode() + "'"
                        for m in re.findall(rf"<{tag}>(.*?)</{tag}>", page, re.S)) or "'none'"
    return ("default-src 'none'; script-src " + hashes("script") + "; style-src " + hashes("style") +
            "; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


CSP = _csp(PAGE)


def make_server(snapshot, port, bind="127.0.0.1"):
    class H(BaseHTTPRequestHandler):
        def _send(self, code, body, ctype, extra=()):
            data = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            for k, v in extra:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            url = urlsplit(self.path)
            path = url.path
            if path == "/":
                self._send(200, PAGE, "text/html; charset=utf-8",
                           (("Content-Security-Policy", CSP), ("X-Frame-Options", "DENY")))
            elif path == "/status.json":
                hist = parse_qs(url.query).get("history", ["0"])[0] == "1"
                self._send(200, json.dumps(snapshot.get(history=hist)), "application/json")
            elif path == "/metrics":
                self._send(200, metrics_text(snapshot.get()), "text/plain; version=0.0.4")
            elif path == "/healthz":
                self._send(200, "ok\n", "text/plain")
            else:
                self._send(404, "not found\n", "text/plain")

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer((bind, port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

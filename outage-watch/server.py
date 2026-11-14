"""Live dashboard + Prometheus metrics for outage-watch (stdlib only)."""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

STATE_NUM = {"up": 0, "warning": 1, "suspect": 2, "down": 3, "blocked": 4}
LEVEL_NUM = {"ok": 0, "caution": 1, "freeze": 2}
MAX_BODY = 4096    # bytes accepted by the admin POST endpoints
MIN_GAP = 5.0      # seconds between manual runs (per endpoint)
MIN_TOKEN = 16     # shortest admin token accepted
LOCAL = ("127.0.0.1", "localhost", "::1")
HISTORY = 120      # probe rounds kept in memory for the dashboard's replay / sparklines
SLOW_MS = 3000     # probe() itself reports "degraded" above this, whatever the baseline


try:
    from outagewatch import role_view, stress_score
except Exception:          # keep the server usable on its own
    stress_score = role_view = None


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

    def __init__(self, edges=None, interval=60, roles=None, drills=None, labels=None, warnings=()):
        self._lock = threading.Lock()
        self._edges = _default_edges() if edges is None else [list(e) for e in edges]
        self._interval, self._hist = interval, deque(maxlen=HISTORY)
        self._data = {"updated": None, "level": "ok", "verdict": "starting", "services": {}}
        self._static = {"roles": [[k, list(v)] for k, v in (roles or {}).items()], "drills": drills}
        self._roles, self._labels, self._warnings = roles or {}, labels or {}, list(warnings)
        self.sla, self.auth = None, False   # sla: filled from the SQLite store; auth: viewer login in force
        self.public = {"updated": None, "tasks": [], "interval": interval}   # for the staff status page
        self.admin = False   # set by make_server: tells the page whether manual tests are enabled

    def update(self, ts, level, verdict, results, published, monitor=None, maintenance=None, health=None, alerts=None):
        svc = {}
        for r in results:
            base = monitor.baseline(r["name"]) if monitor else None
            warn = SLOW_MS if base is None else round(min(SLOW_MS, max(base * monitor.factor, base + monitor.floor_ms)))
            svc[r["name"]] = {"state": published.get(r["name"], r["state"]), "code": r["code"], "ms": r["ms"],
                              "error": r["error"], "baseline": base, "warn_ms": warn}
            if r.get("info"):
                svc[r["name"]]["info"] = r["info"]
            if maintenance and r["name"] in maintenance:
                svc[r["name"]]["maintenance"] = maintenance[r["name"]]
            if health and r["name"] in health["ms"]:
                svc[r["name"]]["ms_status"] = health["ms"][r["name"]]
        with self._lock:
            if stress_score:
                for n, v in svc.items():
                    past = [(f["services"][n]["state"], f["services"][n]["ms"]) for f in list(self._hist)[-9:]
                            if n in f["services"]]
                    v["stress"] = stress_score(past + [(v["state"], v["ms"])], v["baseline"], v["warn_ms"])
            self._data = {"updated": ts, "level": level, "verdict": verdict, "services": svc}
            self._hist.append(self._data)
            self._extra = {"alerts": alerts, "health": None if not health else {
                "divergent": health["divergent"], "error": health["error"], "age_s": health["age_s"]}}
            if role_view:
                counted = {n: v["state"] for n, v in svc.items() if "maintenance" not in v}
                self.public = {"updated": ts, "interval": self._interval,
                               "tasks": role_view(counted, self._roles, self._edges, self._labels),
                               "maintenance": bool(maintenance)}

    def get(self, history=False):
        with self._lock:
            d = dict(self._data, edges=self._edges, interval=self._interval, admin=self.admin, auth=self.auth,
                     warnings=self._warnings, sla=self.sla, **getattr(self, "_extra", {}))
            if history:
                d.update(self._static, history=list(self._hist))
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
    out.append("# TYPE outagewatch_stress_score gauge")
    out.append("# HELP outagewatch_stress_score 0-100 heuristic: latency drift, jitter, recent failed probes")
    for n, s in sorted(d["services"].items()):
        out.append(f'outagewatch_stress_score{{service="{_label(n)}"}} {s.get("stress", 0)}')
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


def _page(name):
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), name), encoding="utf-8") as f:
        text = f.read()
    return text, _csp(text)


LOGIN_PAGE, LOGIN_CSP = _page("login.html")
STATUS_PAGE, STATUS_CSP = _page("status.html")
SESSION_S = 12 * 3600


def make_server(snapshot, port, bind="127.0.0.1", admin=None, access=None):
    """admin (optional) enables the admin API (manual test, test alert, ack, snooze):
    {"token": str, "targets": () -> [names], "run_test": (only) -> dict, "test_alert": () -> dict,
     "ack": () -> dict, "snooze": (service, minutes) -> dict}.
    Without it the POST endpoints answer 403 and the page hides its buttons.

    access (optional) protects the read-only pages:
    {"viewer_token": str, "trusted_proxy": "10.0.0.5", "proxy_header": "X-Forwarded-User",
     "public_status": bool}. With neither a viewer token nor a trusted proxy, reading is open
    (the default, intended for localhost)."""
    token = (admin or {}).get("token")
    access = access or {}
    viewer, proxy_ip = access.get("viewer_token"), access.get("trusted_proxy")
    proxy_header = access.get("proxy_header") or "X-Forwarded-User"
    for what, t in (("admin", token), ("viewer", viewer)):
        if t is not None and len(t) < MIN_TOKEN:
            raise ValueError(f"{what} token must be at least {MIN_TOKEN} characters")
    if viewer and token and hmac.compare_digest(viewer.encode(), token.encode()):
        raise ValueError("viewer token and admin token must be different")
    if bind not in LOCAL and not (token or viewer or proxy_ip):
        raise ValueError(f"--bind {bind} exposes the dashboard beyond localhost; set OUTAGEWATCH_VIEWER_TOKEN or "
                         "OUTAGEWATCH_ADMIN_TOKEN (and put it behind an authenticating reverse proxy) or bind to 127.0.0.1")
    protected = bool(viewer or proxy_ip)
    snapshot.admin, snapshot.auth = bool(token), bool(viewer)
    gate = {"lock": threading.Lock(), "busy": threading.Lock(), "last": {}, "fails": deque(maxlen=20)}
    sessions = {}

    class H(BaseHTTPRequestHandler):
        def _json(self, code, obj, extra=()):
            self._send(code, json.dumps(obj), "application/json", extra)

        def _same_origin(self):
            host, origin = self.headers.get("Host"), self.headers.get("Origin")
            if not host or self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
                return False
            return origin is None or origin in ("http://" + host, "https://" + host)

        def _locked(self, now):
            with gate["lock"]:
                return len(gate["fails"]) == gate["fails"].maxlen and now - gate["fails"][0] < 60

        def _fail(self, now):
            with gate["lock"]:
                gate["fails"].append(now)

        def _bearer(self, expected):
            auth = self.headers.get("Authorization", "")
            return bool(expected) and auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].encode(), expected.encode())

        def _session(self):
            for part in self.headers.get("Cookie", "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == "ow_session":
                    with gate["lock"]:
                        return sessions.get(v, 0) > time.time()
            return False

        def _may_read(self):
            """Viewer access: open by default; else trusted proxy identity, session cookie, or bearer token."""
            if not protected:
                return True
            if proxy_ip and self.client_address[0] == proxy_ip and self.headers.get(proxy_header, "").strip():
                return True
            return self._session() or self._bearer(viewer) or self._bearer(token)

        def _login(self, path):
            self.close_connection = True
            now = time.monotonic()
            if path == "/logout":
                for part in self.headers.get("Cookie", "").split(";"):
                    k, _, v = part.strip().partition("=")
                    if k == "ow_session":
                        with gate["lock"]:
                            sessions.pop(v, None)
                return self._json(200, {"ok": True}, (("Set-Cookie", "ow_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"),))
            if not viewer:
                return self._json(403, {"error": "login is disabled"})
            if not self._same_origin() or self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                return self._json(403, {"error": "forbidden"})
            try:
                length = int(self.headers.get("Content-Length", ""))
                if not 0 < length <= MAX_BODY:
                    raise ValueError
            except ValueError:
                return self._json(400, {"error": "bad request"})
            if self._locked(now):
                return self._json(429, {"error": "too many requests"}, (("Retry-After", "60"),))
            try:
                given = json.loads(self.rfile.read(length)).get("token")
            except Exception:
                given = None
            if not isinstance(given, str) or not hmac.compare_digest(given.encode(), viewer.encode()):
                self._fail(now)
                time.sleep(0.3)                    # small fixed backoff on every bad attempt
                return self._json(401, {"error": "unauthorized"})
            sid = secrets.token_urlsafe(32)
            with gate["lock"]:
                for k in [k for k, exp in sessions.items() if exp < time.time()] + list(sessions)[:max(0, len(sessions) - 200)]:
                    sessions.pop(k, None)
                sessions[sid] = time.time() + SESSION_S
            secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
            self._json(200, {"ok": True}, (("Set-Cookie", f"ow_session={sid}; Max-Age={SESSION_S}; Path=/; HttpOnly; SameSite=Strict{secure}"),))

        def do_POST(self):
            path = urlsplit(self.path).path
            if path in ("/login", "/logout"):
                return self._login(path)
            if path not in ("/api/test", "/api/test-alert", "/api/ack", "/api/snooze"):
                return self._json(404, {"error": "not found"})
            self.close_connection = True      # we may answer without reading the body
            if not token:
                return self._json(403, {"error": "manual test is disabled"})
            if not self._same_origin():
                return self._json(403, {"error": "forbidden"})
            if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                return self._json(415, {"error": "unsupported media type"})
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._json(411, {"error": "length required"})
            if length < 0 or length > MAX_BODY:
                return self._json(413, {"error": "payload too large"})
            now = time.monotonic()
            if self._locked(now):
                return self._json(429, {"error": "too many requests"}, (("Retry-After", "60"),))
            if not self._bearer(token):
                self._fail(now)
                return self._json(401, {"error": "unauthorized"}, (("WWW-Authenticate", "Bearer"),))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
                only = body.get("only") if isinstance(body, dict) else 0
                known = set(admin["targets"]())
                if not isinstance(body, dict) or not (only is None or (
                        isinstance(only, list) and 0 < len(only) <= 50 and
                        all(isinstance(n, str) and n in known for n in only))):
                    raise ValueError
                if path == "/api/snooze":
                    svc, minutes = body.get("service"), body.get("minutes")
                    if svc not in known or type(minutes) not in (int, float) or not 0 <= minutes <= 7 * 1440:
                        raise ValueError
            except Exception:
                return self._json(400, {"error": "bad request"})
            if path in ("/api/ack", "/api/snooze"):
                fn = admin.get("ack" if path == "/api/ack" else "snooze")
                if not fn:
                    return self._json(404, {"error": "alerting is not configured"})
                try:
                    return self._json(200, fn() if path == "/api/ack" else fn(svc, minutes))
                except Exception:
                    return self._json(500, {"error": "internal error"})
            if not gate["busy"].acquire(blocking=False):
                return self._json(429, {"error": "too many requests"}, (("Retry-After", "5"),))
            try:
                wait = MIN_GAP - (now - gate["last"].get(path, -MIN_GAP))
                if wait > 0:
                    return self._json(429, {"error": "too many requests"}, (("Retry-After", str(int(wait) + 1)),))
                gate["last"][path] = now
                out = admin["run_test"](only) if path == "/api/test" else admin["test_alert"]()
            except Exception:
                return self._json(500, {"error": "internal error"})
            finally:
                gate["busy"].release()
            self._json(200, out)

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
            html = "text/html; charset=utf-8"
            if path == "/healthz":
                return self._send(200, "ok\n", "text/plain")
            if path in ("/status", "/status-public.json"):       # staff page: no login, nothing internal
                if not access.get("public_status"):
                    return self._send(404, "not found\n", "text/plain")
                if path == "/status":
                    return self._send(200, STATUS_PAGE, html, (("Content-Security-Policy", STATUS_CSP), ("X-Frame-Options", "DENY")))
                return self._send(200, json.dumps(snapshot.public), "application/json")
            if path == "/login":
                return self._send(200, LOGIN_PAGE, html, (("Content-Security-Policy", LOGIN_CSP), ("X-Frame-Options", "DENY")))
            if path not in ("/", "/status.json", "/metrics"):
                return self._send(404, "not found\n", "text/plain")
            if not self._may_read():
                if path == "/":
                    return self._send(401, LOGIN_PAGE, html, (("Content-Security-Policy", LOGIN_CSP), ("X-Frame-Options", "DENY")))
                return self._json(401, {"error": "unauthorized"}, (("WWW-Authenticate", "Bearer"),))
            if path == "/":
                self._send(200, PAGE, html, (("Content-Security-Policy", CSP), ("X-Frame-Options", "DENY")))
            elif path == "/status.json":
                hist = parse_qs(url.query).get("history", ["0"])[0] == "1"
                self._send(200, json.dumps(snapshot.get(history=hist)), "application/json")
            else:
                self._send(200, metrics_text(snapshot.get()), "text/plain; version=0.0.4")

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer((bind, port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

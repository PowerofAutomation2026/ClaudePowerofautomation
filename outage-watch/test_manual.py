"""Manual test (--test / --test-alert), admin API security, and dashboard extras."""
import contextlib, io, json, os, sys, tempfile, threading, unittest, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
import outagewatch as ow, server

TOKEN = "t0ken-for-tests-0123456789"


def target(code=200):
    """Local stand-in service; also records POST bodies (webhook)."""
    got = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(code); self.end_headers()

        def do_POST(self):
            got.append(self.rfile.read(int(self.headers["Content-Length"])).decode())
            self.send_response(200); self.end_headers()

        def log_message(self, *a): pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}/", got


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = ow.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class CliTestMode(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.up, up_url, self.hooked = target(200)
        self.bad, bad_url, _ = target(503)
        self.url = up_url
        self.cfg = os.path.join(self.d, "c.json")
        json.dump({"replace_defaults": True, "targets": {"good": [up_url, [200]], "bad": [bad_url, [200]]}}, open(self.cfg, "w"))
        self.ff = os.path.join(self.d, "freeze.json")

    def tearDown(self):
        for s in (self.up, self.bad): s.shutdown(); s.server_close()

    def test_healthy_exit_0_and_table(self):
        code, out, _ = run("--config", self.cfg, "--test", "--only", "good")
        self.assertEqual(code, 0)
        for word in ("MANUAL TEST", "good", "up", "200", "freeze level this would set: ok", "dry run"):
            self.assertIn(word, out)

    def test_problem_exit_1_and_json(self):
        code, out, _ = run("--config", self.cfg, "--test", "--json")
        t = json.loads(out)
        self.assertEqual(code, 1)
        self.assertEqual({r["name"]: r["state"] for r in t["results"]}, {"good": "up", "bad": "down"})
        self.assertEqual((t["level_would_set"], t["applied"], t["kind"]), ("freeze", False, "manual-test"))

    def test_bad_usage_exit_2(self):
        self.assertEqual(run("--config", self.cfg, "--test", "--only", "nope")[0], 2)
        self.assertEqual(run("--config", self.cfg, "--only", "good")[0], 2)
        self.assertEqual(run("--config", self.cfg, "--apply")[0], 2)
        self.assertEqual(run("--no-such-flag")[0], 2)
        self.assertEqual(run("--test-alert")[0], 2)      # nothing to alert through

    def test_dry_run_touches_nothing_apply_does(self):
        log = os.path.join(self.d, "l.jsonl")
        hook = os.path.join(self.d, "hook.txt")
        cmd = f"{sys.executable} -c \"import os;open(r'{hook}','w').write(os.environ['OUTAGEWATCH_LEVEL'])\""
        common = ("--config", self.cfg, "--log", log, "--freeze-file", self.ff, "--on-change", cmd, "--webhook", self.url, "--test")
        self.assertEqual(run(*common)[0], 1)
        self.assertFalse(os.path.exists(self.ff)); self.assertFalse(os.path.exists(hook))
        self.assertFalse(os.path.exists(log)); self.assertEqual(self.hooked, [])
        code, out, _ = run(*common, "--apply")
        self.assertEqual(code, 1)
        self.assertEqual(json.load(open(self.ff))["level"], "freeze")
        self.assertEqual(open(hook).read(), "freeze")
        self.assertIn("MANUAL TEST", self.hooked[0]); self.assertIn("applied", out)

    def test_alert_sends_labelled_message_and_runs_hook(self):
        hook = os.path.join(self.d, "hook.txt")
        cmd = f"{sys.executable} -c \"import os;open(r'{hook}','w').write(os.environ['OUTAGEWATCH_LEVEL'])\""
        code, out, _ = run("--test-alert", "--webhook", self.url, "--on-change", cmd)
        self.assertEqual(code, 0)
        self.assertEqual(open(hook).read(), "test")
        self.assertIn("TEST", json.loads(self.hooked[0])["text"])
        self.assertIn("hook exit code: 0", out); self.assertIn("webhook: sent", out)

    def test_alert_failures_exit_1(self):
        code, out, _ = run("--test-alert", "--on-change", f"{sys.executable} -c \"raise SystemExit(3)\"")
        self.assertEqual(code, 1); self.assertIn("hook exit code: 3", out)
        code, out, _ = run("--test-alert", "--webhook", "http://127.0.0.1:1/")
        self.assertEqual(code, 1); self.assertIn("webhook: failed", out)

    def test_manual_test_does_not_mutate_monitor(self):
        m = ow.Monitor(min_history=1)
        m.step([{"name": "good", "state": "up", "code": 200, "ms": 1, "error": None}])
        before = json.dumps([m.hist, m.fails, m.state])
        t = ow.manual_test({"good": (self.url, {200})}, monitor=m)
        self.assertEqual(json.dumps([m.hist, m.fails, m.state]), before)
        self.assertEqual(t["results"][0]["baseline"], 1)
        with self.assertRaises(ValueError): ow.manual_test({"good": (self.url, None)}, ["https://evil.test/"])


class AdminApi(unittest.TestCase):
    def setUp(self):
        self.calls, self.gap = [], server.MIN_GAP
        admin = {"token": TOKEN, "targets": lambda: ["a", "b"],
                 "run_test": lambda only: self.calls.append(only) or {"kind": "manual-test", "only": only},
                 "test_alert": lambda: self.calls.append("alert") or {"kind": "test-alert"}}
        self.snap = server.Snapshot(edges=[["a", "b"]], interval=7)
        self.srv = server.make_server(self.snap, 0, admin=admin)
        self.base = f"http://127.0.0.1:{self.srv.server_port}"

    def tearDown(self):
        server.MIN_GAP = self.gap
        self.srv.shutdown(); self.srv.server_close()

    def post(self, path="/api/test", body=b"{}", token=TOKEN, ctype="application/json", base=None, **headers):
        h = dict(headers)
        if ctype: h["Content-Type"] = ctype
        if token: h["Authorization"] = "Bearer " + token
        req = urllib.request.Request((base or self.base) + path, data=body, headers=h, method="POST")
        try:
            r = urllib.request.urlopen(req); code = r.status
        except urllib.error.HTTPError as e:
            r, code = e, e.code
        data = json.loads(r.read()); r.close()
        return code, data

    def test_ok_then_rate_limited(self):
        self.assertEqual(self.post(body=b'{"only": ["a"]}'), (200, {"kind": "manual-test", "only": ["a"]}))
        self.assertEqual(self.post()[0], 429)
        self.assertEqual(self.calls, [["a"]])
        self.assertEqual(self.post("/api/test-alert")[0], 200)      # separate limiter per endpoint
        self.assertEqual(self.post("/api/test-alert")[0], 429)
        server.MIN_GAP = 0
        self.assertEqual(self.post(body=b"")[0], 200)                # empty body = all services
        self.assertEqual(self.calls, [["a"], "alert", None])

    def test_missing_and_wrong_token(self):
        for tok in (None, "wrong-token-wrong-token", TOKEN[:-1], TOKEN + "x"):
            code, data = self.post(token=tok)
            self.assertEqual((code, data), (401, {"error": "unauthorized"}))
        self.assertEqual(self.calls, [])

    def test_repeated_bad_tokens_lock_out(self):
        for _ in range(20): self.assertEqual(self.post(token="x" * 20)[0], 401)
        self.assertEqual(self.post()[0], 429)                         # even the right token, for a minute
        self.assertEqual(self.calls, [])

    def test_cross_origin_rejected(self):
        self.assertEqual(self.post(Origin="https://evil.example")[0], 403)
        self.assertEqual(self.post(**{"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.post(Origin=self.base)[0], 200)

    def test_content_type_and_size(self):
        self.assertEqual(self.post(ctype="text/plain")[0], 415)
        self.assertEqual(self.post(ctype=None)[0], 415)               # urllib then sends a form content type
        self.assertEqual(self.post(body=b'{"only":["a"],"pad":"' + b"x" * server.MAX_BODY + b'"}')[0], 413)
        self.assertEqual(self.calls, [])

    def test_only_names_never_urls(self):
        for body in (b'{"only": ["nope"]}', b'{"only": ["https://evil.example/"]}', b'{"only": "a"}', b'{"only": []}',
                     b'{"only": [1]}', b'[1]', b'{nope'):
            self.assertEqual(self.post(body=body), (400, {"error": "bad request"}), body)
        self.assertEqual(self.calls, [])

    def test_internal_error_is_generic(self):
        self.srv.shutdown(); self.srv.server_close()
        def boom(only): raise RuntimeError("secret detail")
        self.srv = server.make_server(self.snap, 0, admin={"token": TOKEN, "targets": lambda: ["a"], "run_test": boom, "test_alert": boom})
        self.assertEqual(self.post(base=f"http://127.0.0.1:{self.srv.server_port}"), (500, {"error": "internal error"}))

    def test_get_and_unknown_post_paths(self):
        with self.assertRaises(urllib.error.HTTPError) as c: urllib.request.urlopen(self.base + "/api/test")
        self.assertEqual(c.exception.code, 404)
        self.assertEqual(self.post("/api/other")[0], 404)
        self.assertEqual(self.post("/status.json")[0], 404)

    def test_disabled_without_token(self):
        snap = server.Snapshot(edges=[])
        srv = server.make_server(snap, 0)
        try:
            base = f"http://127.0.0.1:{srv.server_port}"
            self.assertEqual(self.post(base=base)[0], 403)
            self.assertFalse(json.loads(urllib.request.urlopen(base + "/status.json").read())["admin"])
        finally:
            srv.shutdown(); srv.server_close()
        self.assertTrue(json.loads(urllib.request.urlopen(self.base + "/status.json").read())["admin"])

    def test_refuses_public_bind_without_token_and_short_token(self):
        with self.assertRaises(ValueError): server.make_server(server.Snapshot(edges=[]), 0, bind="0.0.0.0")
        with self.assertRaises(ValueError): server.make_server(server.Snapshot(edges=[]), 0, admin={"token": "short"})
        code, _, err = run("--serve", "18766", "--bind", "0.0.0.0", "--once")
        self.assertEqual(code, 2); self.assertIn("refusing to start", err)


class DashboardExtras(unittest.TestCase):
    def setUp(self):
        self.snap = server.Snapshot(edges=[["a", "b"]], interval=7)
        self.srv = server.make_server(self.snap, 0)
        self.base = f"http://127.0.0.1:{self.srv.server_port}"

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()

    def test_status_extras_and_history(self):
        m = ow.Monitor(min_history=1)
        for i, ms in enumerate((100, 120)):
            res = [{"name": "a", "state": "up", "code": 200, "ms": ms, "error": None}]
            self.snap.update(f"2026-01-01T00:00:0{i}+00:00", "ok", "v", res, m.step(res), m)
        d = json.loads(urllib.request.urlopen(self.base + "/status.json").read())
        self.assertEqual((d["edges"], d["interval"]), ([["a", "b"]], 7))
        self.assertEqual((d["services"]["a"]["baseline"], d["services"]["a"]["warn_ms"]), (120, 920))
        self.assertNotIn("history", d)
        h = json.loads(urllib.request.urlopen(self.base + "/status.json?history=1").read())["history"]
        self.assertEqual([f["services"]["a"]["ms"] for f in h], [100, 120])

    def test_history_is_capped_and_default_edges(self):
        for i in range(server.HISTORY + 5):
            self.snap.update(str(i), "ok", "v", [], {})
        self.assertEqual(len(self.snap.get(history=True)["history"]), server.HISTORY)
        self.assertIn(["auth", "exchange"], server.Snapshot().get()["edges"])
        self.assertIn(["graph", "m365-copilot"], ow.dependency_edges())

    def test_page_csp_and_no_external_refs(self):
        r = urllib.request.urlopen(self.base + "/"); page = r.read().decode(); r.close()
        csp = r.headers["Content-Security-Policy"]
        self.assertIn("default-src 'none'", csp); self.assertIn("connect-src 'self'", csp)
        self.assertNotIn("unsafe-inline", csp); self.assertNotIn("unsafe-eval", csp)
        self.assertEqual(csp.count("'sha256-"), 2)
        self.assertEqual(r.headers["X-Frame-Options"], "DENY")
        for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "localStorage.setItem('ow-token",
                    "https://", "//cdn", " style=\""):
            self.assertNotIn(bad, page, bad)
        self.assertEqual(page.count("http://"), 1)          # only the SVG namespace string
        self.assertIn("SIMULATION", page); self.assertIn("MANUAL TEST", page)


if __name__ == "__main__":
    unittest.main()

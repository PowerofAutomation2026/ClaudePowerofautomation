import json, os, tempfile, threading, time, unittest, urllib.request
import outagewatch as ow, report, server


def R(n, s="up", ms=100):
    return {"name": n, "state": s, "code": 200, "ms": ms, "error": None}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.snap = server.Snapshot()
        self.snap.update("2026-01-01T00:00:00+00:00", "caution", "v", [R("a", "up", 5), R('we"ird\nname', "down")],
                         {"a": "warning", 'we"ird\nname': "down"})
        self.srv = server.make_server(self.snap, 0)
        self.base = f"http://127.0.0.1:{self.srv.server_port}"

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()

    def get(self, p):
        r = urllib.request.urlopen(self.base + p); b = r.read().decode(); r.close(); return r, b

    def test_status_json(self):
        r, b = self.get("/status.json")
        d = json.loads(b)
        self.assertEqual(d["level"], "caution"); self.assertEqual(d["services"]["a"]["state"], "warning")

    def test_metrics_escaped_and_numeric(self):
        _, b = self.get("/metrics")
        self.assertIn('outagewatch_service_state{service="a"} 1', b)
        self.assertIn("outagewatch_level 1", b)
        self.assertNotIn('we"ird', b)          # quote must be escaped
        self.assertEqual(len([l for l in b.splitlines() if "ird" in l and l.startswith("outagewatch_service")]), 1)

    def test_dashboard_and_headers(self):
        r, b = self.get("/")
        self.assertIn("outage-watch", b); self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        self.assertNotIn("innerHTML", b)       # no HTML injection from service names

    def test_404_and_health(self):
        self.assertEqual(self.get("/healthz")[1], "ok\n")
        with self.assertRaises(urllib.error.HTTPError) as c: self.get("/nope")
        self.assertEqual(c.exception.code, 404)

    def test_default_bind_is_localhost(self):
        self.assertEqual(self.srv.server_address[0], "127.0.0.1")


class ConfigTests(unittest.TestCase):
    def cfg(self, obj):
        p = os.path.join(tempfile.mkdtemp(), "c.json"); json.dump(obj, open(p, "w")); return p

    def test_valid(self):
        c = ow.load_config(self.cfg({"targets": {"x": ["https://x.test/", [200, 401]], "y": ["http://y/", None]}, "interval": 30}))
        self.assertEqual(c["targets"]["x"], ("https://x.test/", {200, 401}))
        self.assertIsNone(c["targets"]["y"][1])

    def test_rejects_bad(self):
        for bad in ({"targets": {"x": ["ftp://x", None]}}, {"targets": {"x": "https://x"}},
                    {"targets": {"x": ["https://x", ["200"]]}}, {"interval": 1}, {"confirm": 0}, [1]):
            with self.assertRaises(ValueError, msg=str(bad)): ow.load_config(self.cfg(bad))


class ReportTests(unittest.TestCase):
    def rows(self):
        def row(t, **pub): return {"ts": f"2026-01-01T00:{t:02d}:00+00:00", "published": pub, "results": []}
        return [row(0, a="up", b="up"), row(1, a="warning", b="up"), row(2, a="suspect", b="up"),
                row(3, a="down", b="up"), row(4, a="down", b="warning"), row(5, a="up", b="up"),
                row(6, a="up", b="down")]

    def test_incidents_and_lead_time(self):
        inc = {i["service"]: i for i in report.incidents(self.rows())}
        a = inc["a"]
        self.assertEqual((a["worst"], a["ongoing"], a["duration_s"], a["lead_s"]), ("down", False, 240, 120))
        b = inc["b"]
        self.assertEqual((b["worst"], b["lead_s"], b["ongoing"]), ("down", 0, True))

    def test_never_down_has_no_lead(self):
        rows = [{"ts": f"2026-01-01T00:0{i}:00+00:00", "published": {"a": s}, "results": []}
                for i, s in enumerate(["up", "warning", "up"])]
        self.assertIsNone(report.incidents(rows)[0]["lead_s"])

    def test_markdown_and_empty(self):
        md = report.markdown(self.rows(), report.incidents(self.rows()))
        self.assertIn("| a |", md); self.assertIn("ONGOING", md); self.assertIn("120s", md)
        self.assertIn("No incidents", report.markdown(self.rows()[:1], []))
        self.assertIn("No samples", report.markdown([], []))

    def test_load_skips_bad_lines(self):
        p = os.path.join(tempfile.mkdtemp(), "l.jsonl")
        open(p, "w").write('{"ts":"2026-01-01T00:00:00+00:00","results":[]}\nGARBAGE\n\n{"nots":1}\n')
        self.assertEqual(len(report.load(p)), 1)

    def test_legacy_rows_without_published(self):
        rows = [{"ts": "2026-01-01T00:00:00+00:00", "results": [R("a", "down")]},
                {"ts": "2026-01-01T00:01:00+00:00", "results": [R("a")]}]
        self.assertEqual(report.incidents(rows)[0]["duration_s"], 60)


class EndToEnd(unittest.TestCase):
    def test_cli_serve_config_and_report(self):
        import subprocess, sys
        d = tempfile.mkdtemp()
        cfgp, logp = os.path.join(d, "c.json"), os.path.join(d, "l.jsonl")
        json.dump({"replace_defaults": True, "targets": {"local": ["http://127.0.0.1:9/", [200]]}, "interval": 5}, open(cfgp, "w"))
        port = 18765
        pr = subprocess.Popen([sys.executable, "outagewatch.py", "--config", cfgp, "--serve", str(port),
                               "--log", logp, "--freeze-file", os.path.join(d, "f.json"), "--timeout", "2"],
                              cwd=os.path.dirname(os.path.abspath(__file__)), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            body = None
            for _ in range(30):
                try:
                    body = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/status.json").read())
                    if body["services"]: break
                except Exception: pass
                time.sleep(0.3)
            self.assertIsNotNone(body); self.assertIn("local", body["services"])
            self.assertEqual(body["services"]["local"]["state"], "suspect")
            self.assertEqual(json.load(open(os.path.join(d, "f.json")))["level"], "caution")
        finally:
            pr.kill(); pr.wait()
        self.assertTrue(report.load(logp))

    def test_bad_config_exit_code(self):
        import subprocess, sys
        p = os.path.join(tempfile.mkdtemp(), "c.json"); open(p, "w").write("{nope")
        r = subprocess.run([sys.executable, "outagewatch.py", "--config", p, "--once"],
                           cwd=os.path.dirname(os.path.abspath(__file__)), capture_output=True)
        self.assertEqual(r.returncode, 2)


class BlockedTests(unittest.TestCase):
    def test_proxy_denial_is_blocked_not_down(self):
        import urllib.error
        orig = ow.urllib.request.build_opener
        class Op:
            def open(self, *a, **k): raise urllib.error.URLError(OSError("Tunnel connection failed: 403 Forbidden"))
        ow.urllib.request.build_opener = lambda *a: Op()
        try:
            self.assertEqual(ow.probe("t", "https://x.test/", {200})["state"], "blocked")
        finally:
            ow.urllib.request.build_opener = orig

    def test_blocked_never_freezes_or_escalates(self):
        m = ow.Monitor(confirm=1)
        st = m.step([R("a", "blocked"), R("b")])
        self.assertEqual(st["a"], "blocked")
        self.assertEqual(ow.Automation.target_level(st), "ok")
        self.assertEqual(ow.Automation.target_level({"a": "blocked", "b": "down"}), "freeze")

    def test_diagnose_blocked(self):
        self.assertIn("not a Microsoft outage", ow.diagnose([R("a", "blocked"), R("b")]))

    def test_dns_failure_still_down(self):
        self.assertEqual(ow.probe("t", "http://127.0.0.1:1/", {200}, timeout=2)["state"], "down")


if __name__ == "__main__":
    unittest.main()

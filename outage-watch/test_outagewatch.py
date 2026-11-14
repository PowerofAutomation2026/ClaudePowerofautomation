import threading, unittest, tempfile, os, json
from http.server import BaseHTTPRequestHandler, HTTPServer
import outagewatch as ow


def serve(code, delay=0.0):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            import time; time.sleep(delay)
            self.send_response(code); self.end_headers()
        def log_message(self, *a): pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}/"


class Tests(unittest.TestCase):
    def check(self, code, ok, expect, **kw):
        srv, url = serve(code, kw.pop("delay", 0))
        try:
            self.assertEqual(ow.probe("t", url, ok, **kw)["state"], expect)
        finally:
            srv.shutdown(); srv.server_close()

    def test_up(self): self.check(200, {200}, "up")
    def test_401_alive(self): self.check(401, {200, 401}, "up")
    def test_redirect_alive(self): self.check(302, {302}, "up")
    def test_500_down(self): self.check(503, {200}, "down")
    def test_429_down(self): self.check(429, {200}, "down")
    def test_unexpected_degraded(self): self.check(404, {200}, "degraded")
    def test_slow_degraded(self): self.check(200, {200}, "degraded", delay=0.3, slow=0.1)
    def test_refused_down(self):
        self.assertEqual(ow.probe("t", "http://127.0.0.1:1/", {200}, timeout=2)["state"], "down")

    def test_diagnose(self):
        r = lambda **s: [{"name": n, "state": v} for n, v in s.items()]
        self.assertEqual(ow.diagnose(r(auth="up", graph="up")), "all healthy")
        self.assertIn("YOUR network", ow.diagnose(r(auth="down", graph="down")))
        self.assertIn("authentication", ow.diagnose(r(auth="down", graph="up")))
        self.assertIn("partial", ow.diagnose(r(auth="up", graph="down", mail="up")))

    def test_cycle_logs_and_alerts_only_on_change(self):
        srv, url = serve(200)
        sent = []
        orig, ow.notify = ow.notify, lambda w, t: sent.append(t)
        try:
            log = os.path.join(tempfile.mkdtemp(), "l.jsonl")
            targets = {"a": (url, {200})}
            _, s = ow.run_cycle(targets, None, log, "hook")
            ow.run_cycle(targets, s, log, "hook")
            self.assertEqual(sent, [])                      # no change, no alert
            ow.run_cycle({"a": (url, {201})}, s, log, "hook")  # becomes degraded
            self.assertEqual(len(sent), 1)
            self.assertEqual(len(open(log).read().splitlines()), 3)
            json.loads(open(log).readline())
        finally:
            ow.notify = orig; srv.shutdown(); srv.server_close()


def R(name, state="up", ms=100):
    return {"name": name, "state": state, "code": 200, "ms": ms, "error": None}


class MonitorTests(unittest.TestCase):
    def warm(self, m, n="teams", k=6):
        for _ in range(k):
            m.step([R(n)])

    def test_suspect_then_down_then_recover(self):
        m = ow.Monitor(confirm=2)
        self.assertEqual(m.step([R("a", "down")])["a"], "suspect")
        self.assertEqual(m.step([R("a", "down")])["a"], "down")
        self.assertEqual(m.step([R("a")])["a"], "up")

    def test_blip_never_confirms(self):
        m = ow.Monitor(confirm=2)
        m.step([R("a", "down")]); m.step([R("a")])
        self.assertEqual(m.step([R("a", "down")])["a"], "suspect")

    def test_latency_spike_warns_before_failure(self):
        m = ow.Monitor(); self.warm(m)
        self.assertEqual(m.step([R("teams", ms=2500)])["teams"], "warning")

    def test_small_jitter_is_not_a_warning(self):
        m = ow.Monitor(); self.warm(m)
        self.assertEqual(m.step([R("teams", ms=300)])["teams"], "up")

    def test_no_warning_without_baseline(self):
        m = ow.Monitor()
        self.assertEqual(m.step([R("teams", ms=5000)])["teams"], "up")

    def test_slow_samples_do_not_poison_baseline(self):
        m = ow.Monitor(); self.warm(m)
        for _ in range(10): m.step([R("teams", ms=2500)])
        self.assertEqual(m.baseline("teams"), 100)

    def test_impact_when_auth_fails(self):
        st = {"auth": "suspect", "teams": "up", "office-cdn": "up", "exchange": "up"}
        self.assertEqual(ow.impact(st), ["exchange", "teams"])
        self.assertEqual(ow.impact({"auth": "up", "teams": "down"}), [])

    def test_tenant_targets(self):
        t = ow.tenant_targets("contoso")
        self.assertIn("contoso.sharepoint.com", t["sharepoint"][0])
        self.assertIn("contoso-my.sharepoint.com", t["onedrive"][0])

    def test_any_answer_below_500_alive_when_none(self):
        srv, url = serve(404)
        try:
            self.assertEqual(ow.probe("t", url, None)["state"], "up")
        finally:
            srv.shutdown(); srv.server_close()


if __name__ == "__main__":
    unittest.main()

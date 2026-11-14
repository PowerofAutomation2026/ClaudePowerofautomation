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


if __name__ == "__main__":
    unittest.main()

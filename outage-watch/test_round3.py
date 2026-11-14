"""Alerting, maintenance, SLA store, Graph divergence (mock), access control, status page, TLS/DNS checks."""
import contextlib, io, json, os, socket, socketserver, subprocess, sys, tempfile, threading, time, unittest
import urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import alerts, graphhealth, maint, outagewatch as ow, report, server, store

ADMIN, VIEWER = "admin-token-0123456789", "viewer-token-0123456789"


def http_mock(routes=None):
    """Records every request; routes: {path-prefix: (code, json-body)}."""
    got = []

    class H(BaseHTTPRequestHandler):
        def _do(self):
            n = int(self.headers.get("Content-Length") or 0)
            got.append({"path": self.path, "headers": dict(self.headers), "body": self.rfile.read(n).decode()})
            code, body = 200, {}
            for pre, (c, b) in (routes or {}).items():
                if self.path.startswith(pre): code, body = c, b
            data = json.dumps(body).encode()
            self.send_response(code); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
        do_GET = do_POST = _do
        def log_message(self, *a): pass
    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}", got


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = ow.main(list(argv))
    return code, out.getvalue(), err.getvalue()


def cfgfile(obj):
    p = os.path.join(tempfile.mkdtemp(), "c.json"); json.dump(obj, open(p, "w")); return p


class Channels(unittest.TestCase):
    def setUp(self):
        self.srv, self.url, self.got = http_mock()
        os.environ["OW_T_URL"] = self.url + "/hook/SECRETPART"
        os.environ["OW_T_TOKEN"] = "tg-SECRET-token"

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        for k in ("OW_T_URL", "OW_T_TOKEN"): os.environ.pop(k, None)

    def test_each_http_channel_payload(self):
        text = "[outage-watch] FREEZE: new incident (t)\nProbes saw: auth down"
        for typ in ("webhook", "slack", "mattermost"):
            self.assertIsNone(alerts.send({"type": typ, "url_env": "OW_T_URL"}, text))
            self.assertEqual(json.loads(self.got[-1]["body"]), {"text": text})
        self.assertIsNone(alerts.send({"type": "discord", "url_env": "OW_T_URL"}, text))
        self.assertEqual(json.loads(self.got[-1]["body"]), {"content": text})
        self.assertIsNone(alerts.send({"type": "teams", "url_env": "OW_T_URL"}, text))
        card = json.loads(self.got[-1]["body"])["attachments"][0]
        self.assertEqual(card["contentType"], "application/vnd.microsoft.card.adaptive")
        self.assertIn("FREEZE", card["content"]["body"][0]["text"]); self.assertIn("auth down", card["content"]["body"][1]["text"])
        self.assertIsNone(alerts.send({"type": "ntfy", "url_env": "OW_T_URL", "token_env": "OW_T_TOKEN"}, text, "freeze"))
        g = self.got[-1]
        self.assertEqual((g["body"], g["headers"]["Priority"], g["headers"]["Authorization"]), (text, "5", "Bearer tg-SECRET-token"))
        self.assertIsNone(alerts.send({"type": "telegram", "token_env": "OW_T_TOKEN", "chat_id": "42", "api_base": self.url}, text))
        self.assertEqual(self.got[-1]["path"], "/bottg-SECRET-token/sendMessage")
        self.assertEqual(json.loads(self.got[-1]["body"]), {"chat_id": "42", "text": text})

    def test_errors_are_short_and_never_leak_secrets(self):
        os.environ["OW_T_URL"] = "http://127.0.0.1:1/SECRETPART"
        for c in ({"type": "slack", "url_env": "OW_T_URL"}, {"type": "slack", "url_env": "OW_MISSING"},
                  {"type": "telegram", "token_env": "OW_T_TOKEN", "chat_id": 1, "api_base": "http://127.0.0.1:1"},
                  {"type": "smtp", "host": "127.0.0.1", "port": 1, "from": "a@b", "to": ["c@d"]}):
            err = alerts.send(c, "x", timeout=2)
            self.assertTrue(err); self.assertNotIn("SECRET", err); self.assertLess(len(err), 60)
        os.environ["OW_T_URL"] = "file:///etc/passwd"
        self.assertIn("not an http", alerts.send({"type": "webhook", "url_env": "OW_T_URL"}, "x"))

    def test_smtp_against_fake_server(self):
        seen = []

        class S(socketserver.StreamRequestHandler):
            def handle(self):
                self.wfile.write(b"220 fake\r\n"); data = False
                for line in self.rfile:
                    seen.append(line)
                    if data:
                        if line == b".\r\n": data = False; self.wfile.write(b"250 ok\r\n")
                    elif line.upper().startswith(b"DATA"): data = True; self.wfile.write(b"354 go\r\n")
                    elif line.upper().startswith(b"QUIT"): self.wfile.write(b"221 bye\r\n"); return
                    elif line.upper().startswith(b"EHLO"): self.wfile.write(b"250 fake\r\n")
                    else: self.wfile.write(b"250 ok\r\n")
        srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), S); threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            c = {"type": "smtp", "host": "127.0.0.1", "port": srv.server_address[1], "starttls": False, "from": "ow@example.org", "to": ["oncall@example.org"]}
            self.assertIsNone(alerts.send(c, "[outage-watch] CAUTION: new incident (t)\nProbes saw: teams warning"))
        finally:
            srv.shutdown(); srv.server_close()
        blob = b"".join(seen)
        self.assertIn(b"Subject: [outage-watch] CAUTION: new incident (t)", blob); self.assertIn(b"teams warning", blob)
        self.assertIn(b"RCPT TO:<oncall@example.org>", blob.upper().replace(b"ONCALL@EXAMPLE.ORG", b"oncall@example.org"))

    def test_config_rejects_inline_secrets_and_bad_shapes(self):
        ok = {"channels": {"a": {"type": "slack", "url_env": "OW_T_URL"}}, "routes": {"freeze": ["a"]}, "escalate_to": ["a"]}
        self.assertEqual(alerts.validate(ok), ok)
        for bad in ({"channels": {"a": {"type": "slack", "url": "https://hooks.slack.com/x"}}},
                    {"channels": {"a": {"type": "telegram", "token": "123:abc", "chat_id": 1}}},
                    {"channels": {"a": {"type": "smtp", "host": "h", "from": "a", "to": ["b"], "password": "p"}}},
                    {"channels": {"a": {"type": "carrier-pigeon", "url_env": "X"}}},
                    {"channels": {"a": {"type": "slack", "url_env": "not a name; rm -rf"}}},
                    {"channels": {"a": {"type": "slack"}}}, dict(ok, routes={"freeze": ["nope"]}), dict(ok, routes={"panic": ["a"]}),
                    dict(ok, escalate_after_min=0), dict(ok, base_url="https://user:pw@host/"), dict(ok, base_url="javascript:alert(1)"), []):
            with self.assertRaises(ValueError, msg=str(bad)): alerts.validate(bad)
        with self.assertRaises(ValueError): ow.load_config(cfgfile({"alerts": {"channels": {"a": {"type": "slack", "url": "x"}}}}))

    def test_independence_check(self):
        for host, hit in (("contoso.webhook.office.com", True), ("prod-1.westeurope.logic.azure.com", True), ("smtp.office365.com", True),
                          ("outlook.office365.com", True), ("hooks.slack.com", False), ("ntfy.sh", False), ("notoffice.com.evil.example", False),
                          ("evil-office.com", False), ("", False), (None, False)):
            self.assertEqual(bool(alerts.m365_hosted(host)), hit, host)
        os.environ["OW_T_URL"] = "https://contoso.webhook.office.com/webhookb2/SECRETPART"
        cfg = {"channels": {"teams": {"type": "teams", "url_env": "OW_T_URL"}, "mail": {"type": "smtp", "host": "smtp.office365.com", "from": "a", "to": ["b"]},
                            "push": {"type": "ntfy", "url_env": "OW_MISSING"}}}
        w = alerts.independence_warnings(cfg, "https://hooks.slack.com/x")
        self.assertEqual(len(w), 2); self.assertTrue(all("same outage" in x for x in w)); self.assertNotIn("SECRETPART", "".join(w))
        code, _, err = run("--config", cfgfile({"replace_defaults": True, "targets": {"x": ["http://127.0.0.1:9/", None]}, "alerts": cfg}),
                           "--once", "--timeout", "1", "--log", os.path.join(tempfile.mkdtemp(), "l"), "--alert-state", os.path.join(tempfile.mkdtemp(), "s"))
        self.assertEqual(err.count("WARNING: alert channel"), 2)        # warns loudly, does not block


class Routing(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.state = alerts.AlertState(os.path.join(tempfile.mkdtemp(), "s.json"))
        cfg = {"channels": {n: {"type": "webhook", "url_env": "X"} for n in ("a", "b", "boss")},
               "routes": {"caution": ["a"], "freeze": ["a", "b"]}, "escalate_after_min": 10, "escalate_to": ["boss"],
               "repeat_every_min": 0, "min_interval_s": 0, "base_url": "https://status.example.org/"}
        self.cfg = cfg
        self.m = self.mgr()

    def mgr(self):
        def sender(c, text, level):
            name = [n for n, v in self.cfg["channels"].items() if v is c][0]
            self.sent.append((name, text)); return None
        return alerts.AlertManager(self.cfg, self.state, sender)

    def names(self): return [n for n, _ in self.sent]

    def test_one_message_per_incident_then_recovery(self):
        t = 1000.0
        self.assertEqual(self.m.step("caution", {"x": "warning", "y": "up"}, now=t), [("opened", ["a"])])
        for i in range(1, 6):                                            # more rounds, other services join: no new message
            self.assertEqual(self.m.step("caution", {"x": "warning", "y": "suspect" if i > 2 else "up"}, now=t + 60 * i), [])
        self.assertEqual(self.names(), ["a"])
        self.assertEqual(self.m.step("freeze", {"x": "down", "y": "up"}, ["z"], now=t + 400)[0][0], "raised")
        self.assertEqual(self.names(), ["a", "a", "b"])
        text = self.sent[-1][1]
        for part in ("FREEZE", "x down", "At risk", "z", "https://status.example.org/", "Cause not confirmed"): self.assertIn(part, text)
        self.assertEqual(self.m.step("ok", {"x": "up", "y": "up"}, now=t + 900)[0], ("resolved", ["a", "b"]))
        self.assertIn("RESOLVED", self.sent[-1][1]); self.assertIsNone(self.state.load()["incident"])
        self.assertEqual(self.m.step("ok", {"x": "up"}, now=t + 960), [])

    def test_escalation_unless_acked(self):
        t = 5000.0
        self.m.step("freeze", {"x": "down"}, now=t)
        self.assertEqual(self.m.step("freeze", {"x": "down"}, now=t + 9 * 60), [])
        self.assertEqual(self.m.step("freeze", {"x": "down"}, now=t + 11 * 60), [("escalation", ["boss"])])
        self.assertEqual(self.m.step("freeze", {"x": "down"}, now=t + 30 * 60), [])        # only once
        self.m.step("ok", {"x": "up"}, now=t + 31 * 60); self.sent.clear()
        self.m.step("freeze", {"x": "down"}, now=t + 40 * 60)
        self.assertTrue(self.state.ack("alice")); self.assertFalse(self.state.ack("bob"))
        self.assertEqual(self.m.step("freeze", {"x": "down"}, now=t + 60 * 60), [])
        self.assertNotIn("boss", self.names())
        self.assertEqual(self.m.public()["incident"]["acked_by"], "alice")

    def test_state_persists_across_restart(self):
        self.m.step("freeze", {"x": "down"}, now=100.0); self.state.ack("cli"); self.state.snooze("y", 30, now=100.0)
        m2 = self.mgr(); self.sent.clear()
        self.assertEqual(m2.step("freeze", {"x": "down"}, now=200.0), [])                    # no duplicate "opened" after restart
        self.assertEqual(self.sent, []); self.assertTrue(self.state.load()["incident"]["acked"])
        self.assertIn("y", self.state.snoozed(now=200.0)); self.assertEqual(self.state.snoozed(now=100.0 + 31 * 60), {})

    def test_snooze_and_maintenance_mute(self):
        self.state.snooze("x", 60, now=0.0)
        self.assertEqual(self.m.step("freeze", {"x": "down", "y": "up"}, now=10.0), [])
        self.assertEqual(self.m.step("freeze", {"z": "down", "y": "up"}, muted={"z": "patching"}, now=20.0), [])
        self.assertEqual(self.m.step("freeze", {"x": "down", "y": "warning"}, now=30.0), [("opened", ["a"])])   # only caution is visible
        self.assertNotIn("x down", self.sent[-1][1])
        self.state.snooze("x", 0)
        self.assertEqual(self.m.step("freeze", {"x": "down", "y": "warning"}, now=40.0)[0][0], "raised")

    def test_rate_limit_and_reminder(self):
        self.cfg.update(min_interval_s=300, repeat_every_min=5, escalate_after_min=60)
        self.m.step("caution", {"x": "warning"}, now=0.0)
        self.assertEqual(self.m.step("caution", {"x": "warning"}, now=299.0), [])
        self.assertEqual(self.m.step("caution", {"x": "warning"}, now=301.0), [("reminder", ["a"])])
        self.m.last_sent["a"] = 600.0
        self.assertEqual(self.m.step("caution", {"x": "warning"}, now=602.0), [("reminder", [])])    # rate-limited
        self.assertEqual(self.m.log[-1]["result"], "rate-limited")

    def test_failed_channel_and_corrupt_state_do_not_raise(self):
        m = alerts.AlertManager(self.cfg, self.state, lambda c, t, l: "URLError")
        self.assertEqual(m.step("freeze", {"x": "down"}, now=1.0), [("opened", [])])
        open(self.state.path, "w").write("{broken")
        self.assertEqual(self.state.load(), {"incident": None, "snooze": {}})
        pub = m.public()
        self.assertNotIn("http", json.dumps(pub).lower()); self.assertEqual(pub["heartbeat"], "off")

    def test_run_cycle_survives_alert_crash_and_pings_heartbeat(self):
        srv, url, got = http_mock()
        os.environ["OW_T_HB"] = url + "/ping/abc"
        class Boom:
            def step(self, *a, **k): raise RuntimeError("x")
            def public(self): return None
        try:
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                res, st = ow.run_cycle({"t": (url + "/", None)}, None, extras={"alerts": Boom(), "heartbeat_env": "OW_T_HB"})
            self.assertEqual(st, {"t": "up"}); self.assertIn("alerting failed", err.getvalue())
            ow.run_cycle({"t": (url + "/", None)}, None, extras={"heartbeat_env": "OW_T_HB"})
            for _ in range(40):
                if any(g["path"] == "/ping/abc" for g in got): break
                time.sleep(0.05)
            self.assertTrue(any(g["path"] == "/ping/abc" for g in got))
            os.environ["OW_T_HB"] = "http://127.0.0.1:1/dead"
            t = alerts.heartbeat("OW_T_HB", timeout=1); t.join(5)
            self.assertIsNotNone(alerts.HEARTBEAT["error"])                              # recorded, not raised
            self.assertIsNone(alerts.heartbeat("OW_NOT_SET"))
        finally:
            os.environ.pop("OW_T_HB", None); alerts.HEARTBEAT.update(error=None, last_ok=None); srv.shutdown(); srv.server_close()

    def test_cli_ack_and_snooze(self):
        sp = self.state.path
        self.m.step("freeze", {"x": "down"}, now=time.time())
        self.assertIn("acknowledged", run("--ack", "--alert-state", sp)[1]); self.assertIn("no open", run("--ack", "--alert-state", sp)[1])
        self.assertEqual(run("--snooze", "x", "15", "--alert-state", sp)[0], 0); self.assertIn("x", self.state.snoozed())
        self.assertEqual(run("--snooze", "x", "0", "--alert-state", sp)[0], 0); self.assertEqual(self.state.snoozed(), {})
        self.assertEqual(run("--snooze", "x", "soon", "--alert-state", sp)[0], 2)


class Maintenance(unittest.TestCase):
    def test_one_off_and_weekly_with_timezone(self):
        w = maint.validate([{"services": ["exchange"], "start": "2026-12-01T22:00", "end": "2026-12-02T02:00", "tz": "Europe/Berlin", "note": "patching"},
                            {"services": ["*"], "weekly": {"day": "sun", "start": "23:00", "duration_min": 120}, "tz": "UTC"}])
        at = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        names = ["exchange", "teams"]
        self.assertEqual(maint.active(w, names, at("2026-12-01T21:30")), {"exchange": "patching"})     # 22:30 Berlin
        self.assertEqual(maint.active(w, names, at("2026-12-01T20:59")), {})
        self.assertEqual(maint.active(w, names, at("2026-12-02T01:00")), {})                           # 02:00 Berlin = end
        self.assertEqual(set(maint.active(w, names, at("2026-12-06T23:30"))), {"exchange", "teams"})   # Sunday
        self.assertEqual(set(maint.active(w, names, at("2026-12-07T00:59"))), {"exchange", "teams"})   # crosses midnight
        self.assertEqual(maint.active(w, names, at("2026-12-07T01:00")), {})

    def test_rejects_bad_windows(self):
        for bad in ("x", [{"services": []}], [{"services": ["a"], "start": "2026-01-02", "end": "2026-01-01"}],
                    [{"services": ["a"], "start": "nope", "end": "x"}], [{"services": ["a"], "weekly": {"day": "someday", "start": "1:00", "duration_min": 5}}],
                    [{"services": ["a"], "weekly": {"day": "mon", "start": "25:00", "duration_min": 5}}],
                    [{"services": ["a"], "start": "2026-01-01", "end": "2026-01-02", "tz": "Mars/Olympus"}]):
            with self.assertRaises(ValueError, msg=str(bad)): maint.validate(bad)

    def test_maintenance_does_not_freeze_or_alert_but_is_recorded(self):
        d = tempfile.mkdtemp(); log = os.path.join(d, "l.jsonl")
        win = maint.validate([{"services": ["dead"], "weekly": {"day": DAY, "start": "00:00", "duration_min": 1440}}])
        auto, sent = ow.Automation(), []
        st = alerts.AlertState(os.path.join(d, "s.json"))
        mgr = alerts.AlertManager({"channels": {"a": {"type": "webhook", "url_env": "X"}}}, st, lambda c, t, l: sent.append(t))
        snap, db = server.Snapshot(edges=[]), store.connect(os.path.join(d, "s.db"))
        mon = ow.Monitor(confirm=1)
        for _ in range(2):
            ow.run_cycle({"dead": ("http://127.0.0.1:9/", None)}, None, log, None, 1, mon, auto, snap,
                         {"maintenance": win, "alerts": mgr, "db": db})
        self.assertEqual((auto.level, sent), ("ok", []))
        rec = json.loads(open(log).read().splitlines()[-1])
        self.assertEqual((rec["published"]["dead"], rec["maintenance"]), ("down", ["dead"])); self.assertIn("maintenance", rec["verdict"])
        self.assertEqual(snap.get()["services"]["dead"]["maintenance"], "planned maintenance")
        inc = report.incidents(report.load(log)); self.assertTrue(inc[0]["maintenance"])
        self.assertIn("(planned maintenance)", report.markdown(report.load(log), inc))
        self.assertEqual(store.sla(db)["dead"]["24h"], {"uptime": None, "samples": 0, "maint": 2, "p50": None, "p95": None})
        self.assertEqual(store.sla(db, exclude_maintenance=False)["dead"]["24h"]["uptime"], 0.0)


DAY = maint.DAYS[datetime.now(timezone.utc).weekday()]


class SlaStore(unittest.TestCase):
    def fill(self, db, now):
        rows = []
        for i in range(200):                                              # one sample per hour, 200 h back
            ts = (now - timedelta(hours=i)).isoformat(timespec="seconds")
            st = "down" if i in (1, 2) else "blocked" if i == 3 else "warning" if i == 4 else "up"
            store.add_round(db, ts, [{"name": "a", "state": st, "ms": 100 + i}, {"name": "b", "state": "up", "ms": 10}], {}, {"a"} if i == 5 else ())

    def test_windows_percentiles_blocked_and_maintenance(self):
        db, now = store.connect(":memory:"), datetime(2026, 6, 1, tzinfo=timezone.utc)
        self.fill(db, now)
        d = store.sla(db, now.timestamp())
        a = d["a"]["24h"]                                                 # 25 samples: 2 down, 1 blocked, 1 maint -> 21/23
        self.assertEqual((a["samples"], a["maint"], a["uptime"]), (23, 1, round(100 * 21 / 23, 3)))
        self.assertEqual(d["a"]["7d"]["samples"], 169 - 2); self.assertEqual(d["b"]["30d"], {"uptime": 100.0, "samples": 200, "maint": 0, "p50": 10, "p95": 10})
        self.assertLess(a["p50"], a["p95"]); self.assertEqual(a["p95"], sorted(100 + i for i in range(25) if i not in (1, 2, 3, 5))[int(.95 * 21)])
        self.assertEqual(store.sla(db, now.timestamp(), exclude_maintenance=False)["a"]["24h"]["samples"], 24)

    def test_retention_and_import_and_csv(self):
        db, now = store.connect(":memory:"), datetime.now(timezone.utc)
        self.fill(db, now)
        self.assertEqual(store.purge(db, 2, now.timestamp()), 2 * (200 - 49)); self.assertEqual(db.execute("SELECT COUNT(*) FROM samples").fetchone()[0], 98)
        log = os.path.join(tempfile.mkdtemp(), "l.jsonl")
        for i in range(3):
            ow.append_log(log, {"ts": (now - timedelta(minutes=i)).isoformat(timespec="seconds"), "verdict": "v", "published": {'=cmd|"x"': "up"},
                                "results": [{"name": '=cmd|"x"', "state": "up", "code": 200, "ms": 5, "error": None}]})
        open(log, "a").write("GARBAGE\n")
        db2 = store.connect(":memory:"); self.assertEqual(store.import_jsonl(db2, log), 3)
        csv = store.sla_csv(store.sla(db2))
        self.assertIn("service,window,uptime_percent", csv); self.assertIn("\"'=cmd|\"\"x\"\"\",24h,100.0,3,0,5,5", csv)   # formula neutralised
        out, csvp = io.StringIO(), os.path.join(tempfile.mkdtemp(), "o.csv")
        with contextlib.redirect_stdout(out): self.assertEqual(report.main([log, "--sla", "--csv", csvp]), 0)
        self.assertIn("## Uptime / SLA", out.getvalue()); self.assertIn("100.000% (3)", out.getvalue()); self.assertTrue(open(csvp).read().count("\n") >= 4)

    def test_cli_mirrors_rounds_and_status_json_gets_sla(self):
        d = tempfile.mkdtemp(); dbp = os.path.join(d, "s.db")
        srv, url, _ = http_mock()
        try:
            code, _, _ = run("--config", cfgfile({"replace_defaults": True, "targets": {"t": [url + "/", None]}}), "--once", "--db", dbp,
                             "--log", os.path.join(d, "l"), "--alert-state", os.path.join(d, "s"))
        finally:
            srv.shutdown(); srv.server_close()
        self.assertEqual(code, 0); self.assertEqual(store.sla(store.connect(dbp))["t"]["24h"]["uptime"], 100.0)
        snap = server.Snapshot(edges=[]); snap.sla = {"t": {}}; self.assertEqual(snap.get()["sla"], {"t": {}})


class Divergence(unittest.TestCase):
    """Against a LOCAL MOCK of Microsoft Graph only. Not verified against the real API."""
    def setUp(self):
        self.health = [{"service": "Exchange Online", "status": "serviceOperational"}, {"service": "Microsoft Teams", "status": "serviceDegradation"}]
        self.routes = {"/tid/oauth2/v2.0/token": (200, {"access_token": "AT-SECRET", "expires_in": 3600}),
                       "/v1.0/admin/serviceAnnouncement/healthOverviews": (200, {"value": self.health})}
        self.srv, self.url, self.got = http_mock(self.routes)
        os.environ.update(OW_T_TEN="tid", OW_T_CID="cid", OW_T_SEC="s3cr3t")
        self.cfg = graphhealth.validate({"tenant_env": "OW_T_TEN", "client_id_env": "OW_T_CID", "client_secret_env": "OW_T_SEC",
                                         "login_base": self.url, "graph_base": self.url})

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        for k in ("OW_T_TEN", "OW_T_CID", "OW_T_SEC"): os.environ.pop(k, None)

    def test_token_flow_and_divergence(self):
        h = graphhealth.ServiceHealth(self.cfg)
        self.assertIsNone(h.poll()); self.assertIsNone(h.poll())
        self.assertEqual(len([g for g in self.got if "token" in g["path"]]), 1)                    # token cached
        self.assertIn("client_secret=s3cr3t", self.got[0]["body"]); self.assertIn("grant_type=client_credentials", self.got[0]["body"])
        self.assertEqual(self.got[1]["headers"]["Authorization"], "Bearer AT-SECRET")
        c = h.compare({"exchange": "down", "teams": "down", "auth": "up", "custom": "down"}, "T1")
        self.assertEqual(c["divergent"], {"exchange": "T1"})                                      # teams: Microsoft agrees
        self.assertEqual((c["ms"]["teams"], c["ms"]["auth"]), ("serviceDegradation", "unknown")); self.assertNotIn("custom", c["ms"])
        self.assertEqual(h.compare({"exchange": "warning"}, "T2")["divergent"], {"exchange": "T1"})   # keeps first-seen time
        self.assertEqual(h.compare({"exchange": "up"}, "T3")["divergent"], {})

    def test_unknown_is_never_healthy(self):
        os.environ["OW_T_SEC"] = ""
        h = graphhealth.ServiceHealth(self.cfg)
        self.assertEqual(h.poll(), "RuntimeError")
        c = h.compare({"exchange": "down"}, "T")
        self.assertEqual((c["divergent"], c["ms"]["exchange"], c["error"]), ({}, "unknown", "RuntimeError"))
        os.environ["OW_T_SEC"] = "s3cr3t"; self.routes["/v1.0"] = (403, {"error": "forbidden"})
        self.assertEqual(h.poll(), "HTTPError"); self.assertEqual(h.compare({"exchange": "down"}, "T")["divergent"], {})
        h2 = graphhealth.ServiceHealth(dict(self.cfg, poll_s=60)); self.routes["/v1.0"] = (200, {"value": self.health}); h2.poll()
        self.assertEqual(h2.compare({"exchange": "down"}, "T", now=time.time() + 1000)["divergent"], {})   # stale data = unknown

    def test_config_validation(self):
        for bad in ({}, {"tenant_env": "A", "client_id_env": "B", "client_secret_env": "C", "client_secret": "inline"},
                    {"tenant_env": "A", "client_id_env": "B", "client_secret_env": "C", "poll_s": 1},
                    {"tenant_env": "A", "client_id_env": "B", "client_secret_env": "C", "graph_base": "file:///x"}):
            with self.assertRaises(ValueError): graphhealth.validate(bad)

    def test_recorded_in_log_status_and_report(self):
        h = graphhealth.ServiceHealth(self.cfg); h.poll()
        d = tempfile.mkdtemp(); log = os.path.join(d, "l.jsonl"); snap = server.Snapshot(edges=[])
        mon = ow.Monitor(confirm=1)
        ow.run_cycle({"exchange": ("http://127.0.0.1:9/", None)}, None, log, None, 1, mon, None, snap, {"health": h})
        s = snap.get()
        self.assertIn("exchange", s["health"]["divergent"]); self.assertEqual(s["services"]["exchange"]["ms_status"], "serviceOperational")
        self.assertIn("DIVERGENCE", s["verdict"])
        self.health[0]["status"] = "serviceInterruption"; h.poll(); time.sleep(1.1)
        ow.run_cycle({"exchange": ("http://127.0.0.1:9/", None)}, None, log, None, 1, mon, None, snap, {"health": h})
        self.assertEqual(snap.get()["health"]["divergent"], {})
        inc = report.incidents(report.load(log))[0]
        self.assertGreaterEqual(inc["ms_confirm_s"], 1); self.assertIn("Microsoft status confirmed after", report.markdown(report.load(log), [inc]))
        self.assertNotIn("s3cr3t", open(log).read() + json.dumps(s)); self.assertNotIn("AT-SECRET", open(log).read() + json.dumps(s))


class Access(unittest.TestCase):
    def start(self, **access):
        self.snap = server.Snapshot(edges=[], roles={"Email": ["exchange"], "Chat": ["teams"]}, labels={"exchange": "Mail servers"})
        res = [{"name": "exchange", "state": "down", "code": None, "ms": 9000, "error": "URLError"}, {"name": "teams", "state": "up", "code": 200, "ms": 120, "error": None}]
        self.snap.update("2026-01-01T00:00:00+00:00", "freeze", "partial outage: exchange https://internal.example/x", res, {"exchange": "down", "teams": "up"})
        self.acks = []
        admin = {"token": ADMIN, "targets": lambda: ["exchange", "teams"], "run_test": lambda o: {}, "test_alert": lambda: {},
                 "ack": lambda: self.acks.append("ack") or {"acked": True}, "snooze": lambda s, m: self.acks.append((s, m)) or {"service": s}}
        self.srv = server.make_server(self.snap, 0, admin=admin, access=access)
        self.base = f"http://127.0.0.1:{self.srv.server_port}"
        self.addCleanup(lambda: (self.srv.shutdown(), self.srv.server_close()))

    def req(self, path, data=None, **headers):
        if data is not None: headers.setdefault("Content-Type", "application/json")
        r = urllib.request.Request(self.base + path, data=data, headers=headers, method="POST" if data is not None else "GET")
        try:
            resp = urllib.request.urlopen(r)
        except urllib.error.HTTPError as e:
            resp = e
        body = resp.read().decode(); resp.close()
        return resp.status if hasattr(resp, "status") else resp.code, body, resp.headers

    def test_open_by_default(self):
        self.start()
        self.assertEqual(self.req("/status.json")[0], 200); self.assertEqual(self.req("/")[0], 200)
        self.assertEqual(self.req("/login", b'{"token":"x"}')[0], 403)                   # login disabled without a viewer token
        self.assertEqual(self.req("/status")[0], 404)                                     # staff page is opt-in

    def test_viewer_login_cookie_flow(self):
        self.start(viewer_token=VIEWER)
        code, body, _ = self.req("/")
        self.assertEqual(code, 401); self.assertIn("Viewer token", body); self.assertNotIn(VIEWER, body)
        for path in ("/status.json", "/metrics", "/status.json?history=1"): self.assertEqual(self.req(path)[0], 401)
        self.assertEqual(self.req("/healthz")[0], 200)
        self.assertEqual(self.req("/login", json.dumps({"token": VIEWER[:-1]}).encode())[0], 401)
        self.assertEqual(self.req("/login", json.dumps({"token": VIEWER}).encode(), Origin="https://evil.example")[0], 403)
        self.assertEqual(self.req("/login", json.dumps({"token": VIEWER}).encode(), **{"Content-Type": "text/plain"})[0], 403)
        code, _, h = self.req("/login", json.dumps({"token": VIEWER}).encode())
        cookie = h["Set-Cookie"]
        self.assertEqual(code, 200); self.assertIn("HttpOnly", cookie); self.assertIn("SameSite=Strict", cookie); self.assertNotIn(VIEWER, cookie)
        sid = cookie.split(";")[0]
        self.assertEqual(self.req("/status.json", Cookie=sid)[0], 200); self.assertEqual(self.req("/", Cookie=sid)[0], 200)
        self.assertEqual(self.req("/status.json", Cookie="ow_session=forged")[0], 401)
        self.assertEqual(self.req("/metrics", Authorization="Bearer " + VIEWER)[0], 200)   # for Prometheus
        self.assertEqual(self.req("/metrics", Authorization="Bearer " + ADMIN)[0], 200)
        self.assertEqual(self.req("/status.json?token=" + VIEWER)[0], 401)                 # never accepted in the URL
        self.assertEqual(self.req("/api/test", b"{}", Authorization="Bearer " + VIEWER)[0], 401)   # viewer is read-only
        self.assertEqual(self.req("/logout", b"{}", Cookie=sid)[0], 200); self.assertEqual(self.req("/status.json", Cookie=sid)[0], 401)

    def test_login_lockout(self):
        self.start(viewer_token=VIEWER)
        old, server.time.sleep = server.time.sleep, lambda s: None
        try:
            for _ in range(20): self.assertEqual(self.req("/login", b'{"token":"nope"}')[0], 401)
            self.assertEqual(self.req("/login", json.dumps({"token": VIEWER}).encode())[0], 429)
        finally:
            server.time.sleep = old

    def test_trusted_proxy_header_only_from_configured_ip(self):
        self.start(trusted_proxy="127.0.0.1", proxy_header="X-Auth-User")
        self.assertEqual(self.req("/status.json")[0], 401)
        self.assertEqual(self.req("/status.json", **{"X-Auth-User": "alice"})[0], 200)
        self.assertEqual(self.req("/status.json", **{"X-Auth-User": " "})[0], 401)
        self.srv.shutdown(); self.srv.server_close()
        self.start(trusted_proxy="10.9.8.7", proxy_header="X-Auth-User")                # we are not that proxy: header is ignored
        self.assertEqual(self.req("/status.json", **{"X-Auth-User": "alice"})[0], 401)

    def test_bind_and_token_rules(self):
        S = lambda **k: server.make_server(server.Snapshot(edges=[]), 0, **k)
        with self.assertRaises(ValueError): S(bind="0.0.0.0")
        with self.assertRaises(ValueError): S(access={"viewer_token": "short"})
        with self.assertRaises(ValueError): S(admin={"token": ADMIN}, access={"viewer_token": ADMIN})
        srv = S(bind="0.0.0.0", access={"viewer_token": VIEWER}); srv.shutdown(); srv.server_close()

    def test_public_status_page_leaks_nothing_internal(self):
        self.start(viewer_token=VIEWER, public_status=True)
        code, page, h = self.req("/status")
        self.assertEqual(code, 200); self.assertIn("default-src 'none'", h["Content-Security-Policy"]); self.assertLess(len(page), 8000)
        for bad in ("innerHTML", "api/", "token", "https://", "status.json?"): self.assertNotIn(bad, page.replace("status-public.json", ""))
        code, body, _ = self.req("/status-public.json")
        d = json.loads(body)
        self.assertEqual([(t["name"], t["status"]) for t in d["tasks"]], [("Email", "down"), ("Chat", "ok")])
        self.assertEqual(d["tasks"][0]["text"], "Unlikely to work right now (Mail servers)")
        for bad in ("exchange", "teams", "9000", "120", "internal.example", "URLError", "verdict", "http"): self.assertNotIn(bad, body)
        self.assertEqual(self.req("/status.json")[0], 401)                                 # the real data still needs login

    def test_role_view_logic(self):
        R = {"Mail": ["auth", "exchange"], "Files": ["sharepoint-online"], "Other": ["nope"]}
        v = lambda st: {t["name"]: t["status"] for t in ow.role_view(st, R)}
        self.assertEqual(v({"auth": "up", "exchange": "up", "sharepoint-online": "blocked"}), {"Mail": "ok", "Files": "unknown", "Other": "unmonitored"})
        self.assertEqual(v({"auth": "down", "exchange": "up", "sharepoint-online": "up"}), {"Mail": "down", "Files": "down", "Other": "unmonitored"})   # via sign-in
        self.assertEqual(v({"auth": "up", "exchange": "warning", "sharepoint-online": "up"})["Mail"], "shaky")
        self.assertNotIn("exchange", json.dumps(ow.role_view({"auth": "up", "exchange": "down"}, R)))

    def test_ack_and_snooze_api(self):
        self.start()
        A = {"Authorization": "Bearer " + ADMIN}
        self.assertEqual(self.req("/api/ack", b"{}")[0], 401)
        self.assertEqual(self.req("/api/ack", b"{}", Origin="https://evil.example", **A)[0], 403)
        self.assertEqual(self.req("/api/ack", b"{}", **A)[0], 200); self.assertEqual(self.req("/api/ack", b"{}", **A)[0], 200)   # not rate limited
        self.assertEqual(self.req("/api/snooze", b'{"service":"teams","minutes":30}', **A)[0], 200)
        for bad in (b'{"service":"nope","minutes":30}', b'{"service":"teams","minutes":-1}', b'{"service":"teams","minutes":"9"}',
                    b'{"service":"teams","minutes":999999}', b'{"service":"https://x/","minutes":1}', b'{}'):
            self.assertEqual(self.req("/api/snooze", bad, **A)[0], 400, bad)
        self.assertEqual(self.acks, ["ack", "ack", ("teams", 30)])

    def test_label_in_status_and_metrics(self):
        self.start(); self.snap.label = 'env "x"\n'
        self.assertEqual(json.loads(self.req("/status.json")[1])["label"], 'env "x"\n')
        self.assertIn('outagewatch_info{deployment="env \\"x\\" "} 1', self.req("/metrics")[1])


class CheckTypes(unittest.TestCase):
    def test_dns(self):
        r = ow.probe("d", "dns://localhost", None)
        self.assertEqual((r["state"], r["error"]), ("up", None)); self.assertIn("resolves to", r["info"])
        self.assertEqual(ow.probe("d", "dns://localhost?expect=127.0.0.1,::1", None)["state"], "up")
        r = ow.probe("d", "dns://localhost?expect=203.0.113.9", None)
        self.assertEqual((r["state"], r["error"]), ("degraded", "dns-mismatch"))
        self.assertEqual(ow.Monitor().step([r])["d"], "warning")
        self.assertEqual(ow.probe("d", "dns://does-not-exist.invalid", None)["state"], "down")

    def test_config_accepts_new_schemes_only_when_well_formed(self):
        c = ow.load_config(cfgfile({"targets": {"cert": ["tls://example.org:443?warn_days=30", None], "mx": ["dns://example.org?expect=1.2.3.4", None]}}))
        self.assertEqual(set(c["targets"]), {"cert", "mx"})
        for bad in ("tls://", "tls://host?warn_days=soon", "dns://user@host", "gopher://x"):
            with self.assertRaises(ValueError, msg=bad): ow.load_config(cfgfile({"targets": {"x": [bad, None]}}))

    @unittest.skipUnless(__import__("shutil").which("openssl"), "openssl not installed")
    def test_tls_expiry_against_local_server(self):
        import ssl
        d = tempfile.mkdtemp()

        def serve(days):
            crt, key = os.path.join(d, f"{days}.crt"), os.path.join(d, f"{days}.key")
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", str(days),
                            "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], check=True, capture_output=True)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(crt, key)
            raw = socket.socket(); raw.bind(("127.0.0.1", 0)); raw.listen(5)

            def loop():
                while True:
                    try:
                        c, _ = raw.accept()
                    except OSError:
                        return
                    try:
                        ctx.wrap_socket(c, server_side=True).close()
                    except Exception:
                        pass
            threading.Thread(target=loop, daemon=True).start()
            return raw, crt
        s1, crt1 = serve(90); s2, crt2 = serve(5)
        try:
            r = ow.probe("c", f"tls://localhost:{s1.getsockname()[1]}?cafile={crt1}", None)
            self.assertEqual(r["state"], "up", r); self.assertRegex(r["info"], r"valid for (89|90) more day")
            r = ow.probe("c", f"tls://localhost:{s2.getsockname()[1]}?cafile={crt2}&warn_days=21", None)
            self.assertEqual(r["state"], "degraded"); self.assertRegex(r["error"], r"cert-expires-in-[45]d")
            r = ow.probe("c", f"tls://localhost:{s1.getsockname()[1]}", None)                # untrusted cert: verification fails
            self.assertEqual((r["state"], r["error"]), ("down", "SSLCertVerificationError"))
            self.assertEqual(ow.probe("c", "tls://127.0.0.1:1", None, timeout=2)["state"], "down")
        finally:
            s1.close(); s2.close()


if __name__ == "__main__":
    unittest.main()

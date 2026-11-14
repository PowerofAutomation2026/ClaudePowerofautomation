"""36 services, the neutral 'unconfigured' state, tenant handling, concurrent probing, family summaries."""
import contextlib, io, json, os, tempfile, threading, time, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import alerts, graphhealth, outagewatch as ow, report, server, store


def R(n, s="up", ms=100):
    return {"name": n, "state": s, "code": 200, "ms": ms, "error": None}


ALL = dict(ow.DEFAULT_TARGETS, **ow.tenant_targets("contoso"))


class Catalogue(unittest.TestCase):
    def test_36_services_with_tenant_34_without(self):
        self.assertEqual((len(ow.DEFAULT_TARGETS), len(ALL)), (34, 36))
        self.assertEqual(set(ow.TENANT_SERVICES), {"sharepoint-online", "onedrive-business"})
        for name, (url, codes) in ALL.items():
            self.assertTrue(url.startswith("https://"), name); self.assertRegex(name, r"^[a-z0-9-]+$")
        self.assertEqual(len({u for u, _ in ALL.values()}), 36)                    # no duplicate URL

    def test_families_dependencies_and_roles_only_name_real_services(self):
        fam = [n for _, names in ow.FAMILIES for n in names]
        self.assertEqual(sorted(fam), sorted(ALL)); self.assertEqual(len(fam), len(set(fam)))
        self.assertEqual(len(ow.FAMILIES), 9)
        for group in (ow.DEPENDS_ON_AUTH, ow.COPILOT_NEEDS, set(graphhealth.DEFAULT_MAP), *map(set, ow.DEFAULT_ROLES.values())):
            self.assertLessEqual(set(group), set(ALL), group)
        self.assertLessEqual({"sharepoint-online", "onedrive-business", "graph", "exchange", "teams"}, ow.COPILOT_NEEDS)
        self.assertFalse({"office-cdn", "teams-cdn", "onedrive-sync", "auth"} & ow.DEPENDS_ON_AUTH)
        self.assertEqual(ow.DEFAULT_ROLES["Files & sharing"], ["auth", "sharepoint-online", "onedrive-business", "onedrive-sync"])
        for role in ("Dashboards & reporting", "Forms & tasks", "Security & compliance admin", "Teams admin", "Email & calendar"):
            self.assertIn(role, ow.DEFAULT_ROLES)
        self.assertIn("power-bi", ow.DEFAULT_ROLES["Dashboards & reporting"])
        edges = ow.dependency_edges()
        self.assertIn(["auth", "power-bi"], edges); self.assertIn(["sharepoint-online", "m365-copilot"], edges)
        self.assertEqual(len(edges), len(ow.DEPENDS_ON_AUTH) + len(ow.COPILOT_NEEDS))

    def test_page_knows_the_same_families(self):
        page = server.PAGE
        for n in ALL: self.assertIn("'" + n + "'", page, n)
        self.assertIn("unconfigured", page); self.assertNotIn("innerHTML", page)


class Tenant(unittest.TestCase):
    def test_valid_and_hostile_tenant_names(self):
        t = ow.tenant_targets("contoso-1")
        self.assertEqual(t["sharepoint-online"][0], "https://contoso-1.sharepoint.com/")
        self.assertEqual(t["onedrive-business"][0], "https://contoso-1-my.sharepoint.com/")
        for bad in ("", "contoso.com", "con toso", "evil.com/", "evil.com#", "a@b", "../x", "-contoso", "contoso-", "CONTOSO", "c" * 64,
                    "contoso\n", "ｃontoso", "a;b", "`id`", "$(id)", None, 5):
            with self.assertRaises(ValueError, msg=repr(bad)): ow.tenant_targets(bad)

    def test_cli_rejects_bad_tenant_before_probing(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = ow.main(["--tenant", "evil.example/", "--once"])
        self.assertEqual(code, 2); self.assertIn("short tenant name", err.getvalue())


class Unconfigured(unittest.TestCase):
    def setUp(self):
        self.un = ow.unconfigured_results(ow.TENANT_SERVICES)

    def test_is_neutral_everywhere(self):
        m = ow.Monitor(confirm=1)
        for _ in range(5): st = m.step([R("auth"), R("exchange")] + self.un)
        self.assertEqual(st["sharepoint-online"], "unconfigured"); self.assertEqual(m.fails["sharepoint-online"], 0)
        self.assertEqual(ow.Automation.target_level(st), "ok")
        self.assertEqual(ow.Automation.target_level({"a": "unconfigured", "b": "blocked"}), "ok")
        st_down = dict(st, auth="down")
        self.assertNotIn("sharepoint-online", ow.impact(st_down)); self.assertIn("exchange", ow.impact(st_down))
        self.assertEqual(ow.copilot_note({"m365-copilot": "down", "sharepoint-online": "unconfigured", "graph": "up"}), "")
        v = ow.diagnose([R("auth"), R("exchange")] + self.un)
        self.assertTrue(v.startswith("all healthy")); self.assertIn("2 not set up", v); self.assertIn("--tenant contoso", v)
        self.assertTrue(ow.diagnose([R("a", "down"), R("b")] + self.un).startswith("partial outage: a"))

    def test_freeze_file_alerts_report_store_ignore_it(self):
        d = tempfile.mkdtemp(); ff, log = os.path.join(d, "f.json"), os.path.join(d, "l.jsonl")
        sent = []
        mgr = alerts.AlertManager({"channels": {"a": {"type": "webhook", "url_env": "X"}}}, alerts.AlertState(os.path.join(d, "s.json")),
                                  lambda c, t, l: sent.append(t))
        db, snap, auto = store.connect(":memory:"), server.Snapshot(edges=ow.dependency_edges(), roles=ow.DEFAULT_ROLES), ow.Automation(ff)
        for _ in range(3):
            ow.run_cycle({}, None, log, None, 1, ow.Monitor(), auto, snap, {"alerts": mgr, "db": db, "unconfigured": ow.TENANT_SERVICES})
        self.assertEqual((auto.level, sent, json.load(open(ff))["services"]), ("ok", [], []))
        self.assertEqual(report.incidents(report.load(log)), []); self.assertTrue(report.verify(log)["ok"])
        self.assertEqual(db.execute("SELECT COUNT(*) FROM samples").fetchone()[0], 0)
        db2 = store.connect(":memory:"); store.import_jsonl(db2, log); self.assertEqual(store.sla(db2), {})
        s = snap.get()
        self.assertEqual(s["services"]["onedrive-business"]["state"], "unconfigured"); self.assertIn("tenant name", s["services"]["onedrive-business"]["info"])
        self.assertEqual(s["services"]["onedrive-business"]["stress"], 0)
        m = server.metrics_text(s)
        self.assertIn('outagewatch_service_state{service="sharepoint-online"} 5', m); self.assertIn("outagewatch_unconfigured_services 2", m)

    def test_role_view_and_manual_test(self):
        roles = {"Files": ["auth", "sharepoint-online", "onedrive-sync"], "Mail": ["auth", "exchange"]}
        st = {"auth": "up", "exchange": "up", "onedrive-sync": "up", "sharepoint-online": "unconfigured"}
        v = {t["name"]: t for t in ow.role_view(st, roles)}
        self.assertEqual((v["Files"]["status"], v["Mail"]["status"]), ("unknown", "ok")); self.assertIn("tenant name not set up", v["Files"]["text"])
        self.assertEqual({t["name"]: t["status"] for t in ow.role_view(dict(st, auth="down"), roles)}, {"Files": "down", "Mail": "down"})
        t = ow.manual_test({}, unconfigured=ow.TENANT_SERVICES)
        self.assertEqual((t["probed"], t["unconfigured"], t["level_would_set"], t["healthy"]), (0, 2, "ok", True))
        self.assertIn("2 need a tenant name", ow.format_test(t))

    def test_status_page_and_history_carry_families(self):
        snap = server.Snapshot(edges=[]); snap.families = ow.FAMILIES
        self.assertEqual(len(snap.get(history=True)["families"]), 9); self.assertNotIn("families", snap.get())


class Concurrency(unittest.TestCase):
    def test_round_takes_about_one_delay_and_keeps_order(self):
        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                time.sleep(0.6); self.send_response(200); self.end_headers()
            def log_message(self, *a): pass
        srv = ThreadingHTTPServer(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
        targets = {f"s{i:02d}": (f"http://127.0.0.1:{srv.server_port}/{i}", None) for i in range(36)}
        targets["dead"] = ("http://127.0.0.1:1/", None)
        try:
            t0 = time.monotonic(); res = ow.probe_all(targets, timeout=5); took = time.monotonic() - t0
            t1 = time.monotonic(); ow.probe_all(dict(list(targets.items())[:8]), timeout=5, workers=4); took4 = time.monotonic() - t1
        finally:
            srv.shutdown(); srv.server_close()
        self.assertEqual([r["name"] for r in res], list(targets))                     # deterministic order
        self.assertEqual([r["state"] for r in res], ["up"] * 36 + ["down"])
        self.assertLess(took, 3.0, took)                                               # sequential would be > 21 s
        self.assertGreater(took4, 1.1)                                                 # the pool really is bounded
        self.assertEqual(ow.probe_all({}), [])

    def test_workers_config(self):
        p = os.path.join(tempfile.mkdtemp(), "c.json")
        json.dump({"workers": 8}, open(p, "w")); self.assertEqual(ow.load_config(p)["workers"], 8)
        for bad in (0, 65, "8", 2.5):
            json.dump({"workers": bad}, open(p, "w"))
            with self.assertRaises(ValueError): ow.load_config(p)


class FamilySummary(unittest.TestCase):
    def test_alert_stays_short_with_many_services(self):
        state = {n: "up" for n in ALL}
        for n in list(ALL)[:30]: state[n] = "down"
        state["onedrive-business"] = "unconfigured"
        text = alerts.format_message("opened", "freeze", state, [n for n in ALL if n in ow.DEPENDS_ON_AUTH], "https://s.example/", "T", families=ow.FAMILY_OF)
        self.assertLess(len(text), 900); self.assertLessEqual(text.count("\n"), 6)
        for part in ("30 services in", "Exchange: 3 down", "sign-in (auth) down", "30 services, including"): self.assertIn(part, text)
        self.assertNotIn("onedrive-business", text)
        small = alerts.format_message("opened", "caution", {"exchange": "warning", "teams": "up"}, families=ow.FAMILY_OF)
        self.assertIn("Probes saw: exchange warning", small)

    def test_verdict_stays_short(self):
        v = ow.diagnose([R(n, "down") for n in list(ALL)[1:25]] + [R("auth")] + [R(n) for n in list(ALL)[25:]])
        self.assertIn("and 16 more", v); self.assertLess(len(v), 200)
        v = ow.diagnose([R("a", "blocked"), R("b", "down"), R("c")])
        self.assertIn("partial outage: b", v); self.assertIn("not a Microsoft outage", v)   # blocked no longer hides a real failure


if __name__ == "__main__":
    unittest.main()

import json, os, stat, subprocess, sys, tempfile, time, unittest, urllib.request, urllib.error
import install

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


def run(*args):
    return subprocess.run([sys.executable, os.path.join(HERE, "install.py"), *args], capture_output=True, text=True, timeout=300)


class Validation(unittest.TestCase):
    def test_good(self):
        self.assertEqual(install.validate_env_id(ENV.upper()), ENV)

    def test_hostile_env_ids(self):
        bad = ["", " ", ENV + "\n", "\n" + ENV, ENV + " ", "../" + ENV, ENV + "/..", ENV.replace("-", ""),
               "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4g", "'; rm -rf /; '", "`calc`", "$(calc)", '"' + ENV + '"',
               "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4١", ENV[:-1], ENV + "0", "..\\..\\x", None, 5]
        for b in bad:
            with self.assertRaises(install.Bad, msg=repr(b)):
                install.validate_env_id(b)

    def test_tenant_port(self):
        self.assertEqual(install.validate_tenant("contoso"), "contoso")
        self.assertIsNone(install.validate_tenant(None))
        for b in ("contoso.onmicrosoft.com", "a b", "x;y", "-x", "a" * 64, "../x", "con\nso"):
            with self.assertRaises(install.Bad, msg=b): install.validate_tenant(b)
        for b in (0, 80, 70000, "8080", None):
            with self.assertRaises(install.Bad, msg=str(b)): install.validate_port(b)

    def test_cli_rejects_bad_id_without_touching_disk(self):
        d = tempfile.mkdtemp()
        r = run("--env-id", "../../etc", "--base-dir", d)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(os.listdir(d), [])


class Install(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp()
        self.dir = os.path.join(self.base, ENV)

    def inst(self, *extra):
        return run("--env-id", ENV, "--base-dir", self.base, "--no-live-test", *extra)

    def test_dry_run_changes_nothing(self):
        r = self.inst("--dry-run")
        self.assertEqual(r.returncode, 0); self.assertIn("Plan:", r.stdout)
        self.assertEqual(os.listdir(self.base), [])

    def test_full_install_and_idempotent_upgrade(self):
        r = self.inst("--skip-tests")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "app", "outagewatch.py")))
        cfg = json.load(open(os.path.join(self.dir, "config.json")))
        self.assertIn(ENV, cfg["targets"]["power-platform-env"][0])
        sys.path.insert(0, os.path.join(self.dir, "app"))
        try:
            import outagewatch
            outagewatch.load_config(os.path.join(self.dir, "config.json"))   # the real app accepts it
        finally:
            sys.path.pop(0)
        envfile = os.path.join(self.dir, "outagewatch.env")
        mode = stat.S_IMODE(os.stat(envfile).st_mode)
        self.assertEqual(mode, 0o600)
        token = open(envfile).read().strip().split("=", 1)[1]
        self.assertGreaterEqual(len(token), 40)
        self.assertNotIn(token, r.stdout + r.stderr)            # never printed
        # upgrade: tokens/config/data survive, app is refreshed
        open(os.path.join(self.dir, "data", "keep.txt"), "w").write("x")
        open(os.path.join(self.dir, "app", "stale.txt"), "w").write("old")
        r2 = self.inst("--skip-tests")
        self.assertEqual(r2.returncode, 0)
        self.assertEqual(open(envfile).read().strip().split("=", 1)[1], token)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "data", "keep.txt")))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "app", "stale.txt")))

    def test_tests_gate_runs_and_passes_on_real_package(self):
        r = self.inst()                                          # real gate, takes ~30s
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("unit tests passed", r.stdout)

    def test_broken_package_blocks_deploy(self):
        # simulate a failing gate by breaking the copied tests via a tampered package copy
        pkg = tempfile.mkdtemp()
        import shutil
        shutil.copytree(os.path.join(HERE, "app"), os.path.join(pkg, "app"))
        shutil.copy(os.path.join(HERE, "install.py"), pkg)
        open(os.path.join(pkg, "app", "test_broken.py"), "w").write(
            "import unittest\nclass T(unittest.TestCase):\n    def test_x(self): self.fail('boom')\n")
        r = subprocess.run([sys.executable, os.path.join(pkg, "install.py"), "--env-id", ENV, "--base-dir", self.base,
                            "--no-live-test"], capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 3)
        self.assertIn("deployment stopped", r.stdout)

    def test_uninstall_keeps_data_then_purge(self):
        self.inst("--skip-tests")
        r = run("--env-id", ENV, "--base-dir", self.base, "--uninstall")
        self.assertEqual(r.returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "app")))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "outagewatch.env")))
        run("--env-id", ENV, "--base-dir", self.base, "--uninstall", "--purge")
        self.assertFalse(os.path.exists(self.dir))

    def test_launcher_serves_and_protects_admin_api(self):
        port = 18931
        self.assertEqual(run("--env-id", ENV, "--base-dir", self.base, "--no-live-test", "--skip-tests",
                             "--port", str(port)).returncode, 0)
        pr = subprocess.Popen([sys.executable, os.path.join(HERE, "launch.py"), "--env-dir", self.dir],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            base = f"http://127.0.0.1:{port}"
            for _ in range(60):
                try:
                    if urllib.request.urlopen(base + "/healthz", timeout=2).read() == b"ok\n": break
                except Exception: time.sleep(0.5)
            else:
                self.fail("server did not come up")
            self.assertEqual(urllib.request.urlopen(base + "/").status, 200)
            self.assertIn("services", json.loads(urllib.request.urlopen(base + "/status.json").read()))
            req = urllib.request.Request(base + "/api/test", data=b"{}", method="POST",
                                         headers={"Content-Type": "application/json"})
            with self.assertRaises(urllib.error.HTTPError) as c: urllib.request.urlopen(req)
            self.assertIn(c.exception.code, (401, 403))          # no token -> refused
            tok = open(os.path.join(self.dir, "outagewatch.env")).read().strip().split("=", 1)[1]
            req2 = urllib.request.Request(base + "/api/test", data=b"{}", method="POST",
                                          headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok})
            self.assertEqual(urllib.request.urlopen(req2, timeout=120).status, 200)   # token enables it
        finally:
            pr.kill(); pr.wait()


class Tenant(unittest.TestCase):
    def test_live_probe_gets_the_tenant(self):
        base = tempfile.mkdtemp()
        calls = []
        real = subprocess.run
        def fake(cmd, *a, **k):
            calls.append(cmd)
            class R: returncode = 0; stdout = json.dumps({"results": [{"state": "up"}]}); stderr = ""
            return R()
        subprocess.run = fake
        try:
            rc = install.main(["--env-id", ENV, "--base-dir", base, "--skip-tests", "--tenant", "contoso"])
        finally:
            subprocess.run = real
        self.assertEqual(rc, 0)
        probe = [c for c in calls if "--test" in c][0]
        self.assertEqual(probe[probe.index("--tenant") + 1], "contoso")


class Launch(unittest.TestCase):
    def test_webhook_comes_from_env_file_only_and_must_be_http(self):
        import launch
        d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, "data"))
        json.dump({"port": 8080, "tenant": None}, open(os.path.join(d, "deploy.json"), "w"))
        old = os.environ.pop("OUTAGEWATCH_WEBHOOK", None)
        try:
            self.assertNotIn("--webhook", launch.build_argv(d))
            os.environ["OUTAGEWATCH_WEBHOOK"] = "file:///etc/passwd"
            self.assertNotIn("--webhook", launch.build_argv(d))
            os.environ["OUTAGEWATCH_WEBHOOK"] = "https://hooks.example.com/x"
            self.assertIn("--webhook", launch.build_argv(d))
        finally:
            os.environ.pop("OUTAGEWATCH_WEBHOOK", None)
            if old: os.environ["OUTAGEWATCH_WEBHOOK"] = old


if __name__ == "__main__":
    unittest.main()

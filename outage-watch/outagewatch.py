#!/usr/bin/env python3
"""outage-watch: independent Microsoft 365 / Outlook health probe.

Lessons from the 2026 Outlook / Exchange Online outages:
  * Provider status pages and post-incident reports lag behind reality, so
    probe the service yourself instead of waiting for them.
  * Authentication is a shared dependency (Aug 31 outage). Probe it
    separately from mail so you can tell "login is down" from "mail is down".
  * Keep your own timestamped timeline to compare with the final PIR.
  * Alert through a channel that does not depend on the failing service.

Standard library only. Early warning needs the continuous mode (it learns a baseline).
Usage:
  python3 outagewatch.py --once
  python3 outagewatch.py --interval 60 --webhook https://example/hook
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# name -> (url, alive HTTP codes). None = any answer below 500 (and not 429) counts
# as alive; used where the exact unauthenticated response is unverified.
DEFAULT_TARGETS = {
    "auth": ("https://login.microsoftonline.com/common/.well-known/openid-configuration", {200}),
    "exchange": ("https://autodiscover-s.outlook.com/autodiscover/autodiscover.xml", {200, 401, 403}),
    "outlook-web": ("https://outlook.office.com/mail/", None),
    "teams": ("https://teams.microsoft.com/", None),
    "m365-portal": ("https://www.office.com/", None),
    "admin-center": ("https://admin.microsoft.com/", None),
    "graph": ("https://graph.microsoft.com/v1.0/$metadata", {200, 401, 403}),
    "power-platform": ("https://api.powerapps.com/", None),
    "intune": ("https://enrollment.manage.microsoft.com/", None),
    # --- Copilot ---
    "m365-copilot": ("https://m365.cloud.microsoft/chat", None),
    "copilot-substrate": ("https://substrate.office.com/", None),
    "copilot-studio": ("https://copilotstudio.microsoft.com/", None),
    "copilot-web": ("https://copilot.microsoft.com/", None),
    "github-copilot": ("https://api.githubcopilot.com/", None),
    "office-cdn": ("https://res.cdn.office.net/", None),
}

# Services that cannot work for signed-in users when "auth" is down.
DEPENDS_ON_AUTH = {"exchange", "outlook-web", "teams", "m365-portal", "admin-center",
                   "graph", "power-platform", "intune", "sharepoint", "onedrive",
                   "m365-copilot", "copilot-substrate", "copilot-studio"}

# Copilot also needs the data services it reads from (mail, files, chats).
COPILOT_NEEDS = {"exchange", "teams", "sharepoint", "onedrive", "graph", "copilot-substrate"}


def tenant_targets(tenant):
    """SharePoint / OneDrive hosts are tenant-specific."""
    return {
        "sharepoint": (f"https://{tenant}.sharepoint.com/", None),
        "onedrive": (f"https://{tenant}-my.sharepoint.com/", None),
    }


def probe(name, url, ok_codes, timeout=10.0, slow=3.0):
    """Return one result dict: state is up | degraded | down."""
    start = time.monotonic()
    code, err = None, None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "outage-watch/1.0"})
        # Do not follow redirects: a 302 from the service is itself proof of life.
        opener = urllib.request.build_opener(_NoRedirect)
        with opener.open(req, timeout=timeout) as resp:
            code = resp.status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception as e:  # DNS failure, timeout, TLS error, refused
        err = type(e).__name__
    ms = round((time.monotonic() - start) * 1000)
    if err is not None or code is None or code >= 500 or code == 429:
        state = "down"
    elif ok_codes is not None and code not in ok_codes:
        state = "degraded"
    elif ms / 1000 > slow:
        state = "degraded"
    else:
        state = "up"
    return {"name": name, "state": state, "code": code, "ms": ms, "error": err}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Monitor:
    """Early-warning layer on top of raw probes.

    Published states: up | warning | suspect | down
      warning - still answering, but latency is far above this service's own baseline
                (often the first visible sign of trouble)
      suspect - first failed probe (could be a blip; alert the on-call, don't page all)
      down    - failed N probes in a row (confirmed)
    """

    def __init__(self, confirm=2, window=20, min_history=5, factor=3.0, floor_ms=800):
        self.confirm, self.window, self.min_history = confirm, window, min_history
        self.factor, self.floor_ms = factor, floor_ms
        self.hist, self.fails, self.state = {}, {}, {}

    def baseline(self, name):
        h = sorted(self.hist.get(name, []))
        return h[len(h) // 2] if len(h) >= self.min_history else None

    def step(self, results):
        """Feed one round of probe results; returns {name: published_state}."""
        for r in results:
            n = r["name"]
            if r["state"] == "down":
                self.fails[n] = self.fails.get(n, 0) + 1
                st = "down" if self.fails[n] >= self.confirm else "suspect"
            else:
                self.fails[n] = 0
                base = self.baseline(n)
                slow = base is not None and r["ms"] > max(base * self.factor, base + self.floor_ms)
                if r["state"] == "degraded" or slow:
                    st = "warning"
                else:
                    st = "up"
                if st == "up":  # only healthy samples shape the baseline
                    self.hist.setdefault(n, []).append(r["ms"])
                    del self.hist[n][:-self.window]
            self.state[n] = st
        return dict(self.state)


LEVELS = {"ok": 0, "caution": 1, "freeze": 2}


class Automation:
    """Automated early prevention.

    caution - something is warning/suspect: advisory, pipelines may still run
    freeze  - a service is confirmed down (or auth is suspect): block risky changes
    Recovery needs `recover_after` clean rounds in a row (avoids flapping).
    On every level change it writes a flag file that pipelines can check, and runs
    optional hook commands (so you can pause deployments, switch to a fallback, etc.).
    """

    def __init__(self, freeze_file=None, on_change=None, recover_after=3):
        self.freeze_file, self.on_change = freeze_file, on_change
        self.recover_after, self.level, self.clean = recover_after, "ok", 0

    @staticmethod
    def target_level(state):
        v = set(state.values())
        if "down" in v or state.get("auth") == "suspect":
            return "freeze"
        if v & {"suspect", "warning"}:
            return "caution"
        return "ok"

    def step(self, state, now=None):
        want = self.target_level(state)
        if LEVELS[want] > LEVELS[self.level]:
            new, self.clean = want, 0            # escalate at once
        elif LEVELS[want] < LEVELS[self.level]:
            self.clean += 1                       # de-escalate slowly
            new = want if self.clean >= self.recover_after else self.level
            if new != self.level:
                self.clean = 0
        else:
            self.clean, new = 0, self.level
        affected = sorted(n for n, v in state.items() if v != "up")
        changed = new != self.level
        self.level = new
        if self.freeze_file:
            self._write(affected, now)
        if changed and self.on_change:
            self._hook(new, affected)
        return new if changed else None

    def _write(self, affected, now):
        import os, tempfile
        doc = {"level": self.level, "services": affected,
               "updated": now or datetime.now(timezone.utc).isoformat(timespec="seconds")}
        d = os.path.dirname(os.path.abspath(self.freeze_file))
        fd, tmp = tempfile.mkstemp(dir=d)
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f)
        os.replace(tmp, self.freeze_file)         # atomic: readers never see a half file

    def _hook(self, level, affected):
        import os, shlex, subprocess
        env = dict(os.environ, OUTAGEWATCH_LEVEL=level, OUTAGEWATCH_SERVICES=",".join(affected))
        try:
            subprocess.run(shlex.split(self.on_change), env=env, timeout=30, check=False)
        except Exception as e:
            print(f"hook failed: {type(e).__name__}", file=sys.stderr)


def check_freeze(path, block_on="freeze"):
    """For pipelines: 0 = safe to proceed, 1 = blocked. A missing file means safe;
    an unreadable/corrupt file blocks (fail closed)."""
    import os
    if not os.path.exists(path):
        return 0
    try:
        level = json.load(open(path))["level"]
    except Exception:
        return 1
    return 1 if LEVELS.get(level, 2) >= LEVELS[block_on] else 0


def copilot_note(state):
    """Explain Copilot problems that are really caused by something underneath."""
    if state.get("m365-copilot", "up") == "up":
        return ""
    under = sorted(n for n in COPILOT_NEEDS if state.get(n, "up") != "up")
    return "Copilot affected; underlying services also unhealthy: " + ", ".join(under) if under else ""


def impact(state):
    """Which downstream services are at risk, given published states."""
    if state.get("auth") in ("down", "suspect"):
        return sorted(n for n in state if n in DEPENDS_ON_AUTH and n != "auth")
    return []


def diagnose(results):
    """Turn per-target states into a plain-language verdict."""
    s = {r["name"]: r["state"] for r in results}
    bad = [n for n, v in s.items() if v != "up"]
    if not bad:
        return "all healthy"
    if len(bad) == len(s):
        return "everything failing: check YOUR network/DNS first, then Microsoft"
    if s.get("auth") != "up":
        return "authentication degraded: sign-in dependent services will fail (Aug 31 pattern)"
    return "partial outage: " + ", ".join(bad)


def notify(webhook, text):
    body = json.dumps({"text": text}).encode()
    req = urllib.request.Request(webhook, data=body, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        print(f"webhook failed: {type(e).__name__}", file=sys.stderr)


def load_config(path):
    """JSON config: {"targets": {"name": ["https://url", [200,401] | null]}, "interval": 60,
    "confirm": 2, "recover_after": 3, "factor": 3.0, "floor_ms": 800, "replace_defaults": false}"""
    with open(path) as f:
        c = json.load(f)
    if not isinstance(c, dict):
        raise ValueError("config must be a JSON object")
    targets = {}
    for name, spec in (c.get("targets") or {}).items():
        if not isinstance(spec, list) or len(spec) != 2:
            raise ValueError(f"target {name!r}: expected [url, codes-or-null]")
        url, codes = spec
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            raise ValueError(f"target {name!r}: url must start with http:// or https://")
        if codes is not None and not (isinstance(codes, list) and all(isinstance(x, int) for x in codes)):
            raise ValueError(f"target {name!r}: codes must be a list of ints or null")
        targets[name] = (url, None if codes is None else set(codes))
    for k, lo in (("interval", 5), ("confirm", 1), ("recover_after", 1)):
        if k in c and (not isinstance(c[k], int) or c[k] < lo):
            raise ValueError(f"{k} must be an integer >= {lo}")
    c["targets"] = targets
    return c


def run_cycle(targets, prev, log_path=None, webhook=None, timeout=10.0, monitor=None, automation=None, snapshot=None):
    """One probe round. Returns (results, new_state_map). Alerts only on change."""
    results = [probe(n, u, c, timeout=timeout) for n, (u, c) in targets.items()]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    verdict = diagnose(results)
    state = monitor.step(results) if monitor else {r["name"]: r["state"] for r in results}
    hit = impact(state)
    if hit:
        verdict += " | at risk: " + ", ".join(hit)
    note = copilot_note(state)
    if note:
        verdict += " | " + note
    if automation:
        lvl = automation.step(state, now)
        if lvl:
            verdict += f" | LEVEL -> {lvl}"
    if snapshot:
        snapshot.update(now, automation.level if automation else "ok", verdict, results, state)
    if log_path:
        with open(log_path, "a") as f:
            f.write(json.dumps({"ts": now, "verdict": verdict, "published": state, "results": results}) + "\n")
    if prev is not None and state != prev and webhook:
        notify(webhook, f"[outage-watch {now}] {verdict}")
    return results, state


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--once", action="store_true", help="probe once and exit (exit 1 if not healthy)")
    p.add_argument("--interval", type=int, default=60)
    p.add_argument("--timeout", type=float, default=10.0)
    p.add_argument("--log", default="outagewatch.jsonl")
    p.add_argument("--tenant", help="tenant name, adds SharePoint/OneDrive probes (contoso -> contoso.sharepoint.com)")
    p.add_argument("--freeze-file", help="write ok/caution/freeze state here for pipelines to check")
    p.add_argument("--on-change", help="command run on level change; sees OUTAGEWATCH_LEVEL / OUTAGEWATCH_SERVICES")
    p.add_argument("--check-freeze", metavar="FILE", help="pipeline gate: exit 1 if FILE says freeze, then quit")
    p.add_argument("--config", help="JSON file: extra/replacement targets and thresholds")
    p.add_argument("--serve", type=int, metavar="PORT", help="live dashboard, /status.json and /metrics on PORT")
    p.add_argument("--bind", default="127.0.0.1", help="address for --serve (default localhost only)")
    p.add_argument("--webhook", help="Teams/Slack-style incoming webhook (use one NOT hosted on M365)")
    a = p.parse_args(argv)
    if a.check_freeze:
        return check_freeze(a.check_freeze)
    cfg = {}
    if a.config:
        try:
            cfg = load_config(a.config)
        except (OSError, ValueError) as e:
            print(f"bad config: {e}", file=sys.stderr)
            return 2
    auto = Automation(a.freeze_file, a.on_change, cfg.get("recover_after", 3)) \
        if (a.freeze_file or a.on_change) else None
    targets = {} if cfg.get("replace_defaults") else dict(DEFAULT_TARGETS)
    targets.update(cfg.get("targets", {}))
    if a.interval == 60 and "interval" in cfg:
        a.interval = cfg["interval"]
    snap = None
    if a.serve:
        from server import Snapshot, make_server
        snap = Snapshot()
        make_server(snap, a.serve, a.bind)
        print(f"dashboard: http://{a.bind}:{a.serve}/  (metrics at /metrics)")
    if a.tenant:
        targets.update(tenant_targets(a.tenant))
    mon = Monitor(confirm=cfg.get("confirm", 2), factor=cfg.get("factor", 3.0),
                  floor_ms=cfg.get("floor_ms", 800))
    prev = None
    while True:
        results, prev_new = run_cycle(targets, prev, a.log, a.webhook, a.timeout, mon, auto, snap)
        for r in results:
            print(f"{r['name']:<16}{prev_new[r['name']]:<9}{r['code']!s:<6}{r['ms']}ms {r['error'] or ''}")
        print("verdict:", diagnose(results))
        prev = prev_new
        if a.once:
            return 0 if all(r["state"] == "up" for r in results) else 1
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())

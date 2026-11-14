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
    "office-cdn": ("https://res.cdn.office.net/", None),
}

# Services that cannot work for signed-in users when "auth" is down.
DEPENDS_ON_AUTH = {"exchange", "outlook-web", "teams", "m365-portal", "admin-center",
                   "graph", "power-platform", "intune", "sharepoint", "onedrive"}


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


def run_cycle(targets, prev, log_path=None, webhook=None, timeout=10.0, monitor=None):
    """One probe round. Returns (results, new_state_map). Alerts only on change."""
    results = [probe(n, u, c, timeout=timeout) for n, (u, c) in targets.items()]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    verdict = diagnose(results)
    state = monitor.step(results) if monitor else {r["name"]: r["state"] for r in results}
    hit = impact(state)
    if hit:
        verdict += " | at risk: " + ", ".join(hit)
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
    p.add_argument("--webhook", help="Teams/Slack-style incoming webhook (use one NOT hosted on M365)")
    a = p.parse_args(argv)
    targets = dict(DEFAULT_TARGETS)
    if a.tenant:
        targets.update(tenant_targets(a.tenant))
    mon, prev = Monitor(), None
    while True:
        results, prev_new = run_cycle(targets, prev, a.log, a.webhook, a.timeout, mon)
        for r in results:
            print(f"{r['name']:<16}{prev_new[r['name']]:<9}{r['code']!s:<6}{r['ms']}ms {r['error'] or ''}")
        print("verdict:", diagnose(results))
        prev = prev_new
        if a.once:
            return 0 if all(r["state"] == "up" for r in results) else 1
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())

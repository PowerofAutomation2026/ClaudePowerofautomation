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
import hashlib
import json
import os
import re
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


# "Can I do my job?" view: task -> services it needs (override with "roles" in --config).
DEFAULT_ROLES = {
    "Email & calendar": ["auth", "exchange", "outlook-web"],
    "Meetings": ["auth", "teams"],
    "Files & sharing": ["auth", "sharepoint", "onedrive"],
    "Copilot assistance": ["auth", "m365-copilot", "copilot-substrate"],
    "Admin tasks": ["auth", "admin-center", "graph"],
    "Device management": ["auth", "intune"],
    "Low-code apps": ["auth", "power-platform"],
}


def stress_score(samples, baseline, warn_ms):
    """Transparent early-warning heuristic, 0-100. NOT a prediction and not machine learning.

    samples: [(state, ms), ...] oldest first; only the last 10 rounds are used.
      drift  D = how far the median of the last 3 answered probes sits between the learned
                 baseline (0) and the warning threshold (1), clamped to 0..1
      jitter J = mean absolute change between consecutive answered probes / baseline, clamped 0..1
      fails  F = failed probes (suspect/down) in the last 5 rounds x 0.5, capped at 1
      score    = round(100 x min(1, 0.5 D + 0.2 J + F))
    Blocked probes are ignored. Without a baseline, D and J are 0.
    """
    win = list(samples)[-10:]
    ok = [ms for st, ms in win if st in ("up", "warning")]
    d = j = 0.0
    if baseline and ok:
        last = sorted(ok[-3:])
        if warn_ms and warn_ms > baseline:
            d = min(1.0, max(0.0, (last[len(last) // 2] - baseline) / (warn_ms - baseline)))
        if len(ok) >= 3:
            j = min(1.0, sum(abs(a - b) for a, b in zip(ok[1:], ok)) / (len(ok) - 1) / baseline)
    f = min(1.0, 0.5 * sum(1 for st, _ in win[-5:] if st in ("down", "suspect")))
    return int(100 * min(1.0, 0.5 * d + 0.2 * j + f) + 0.5)


# ---- tamper-evident log: each record carries the hash of the previous one -------------
GENESIS = "0" * 64


def chain_hash(rec):
    """sha256 over the record's canonical JSON (everything except its own "hash")."""
    body = {k: v for k, v in rec.items() if k != "hash"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def log_head(path):
    """Hash the next record must point at: last record's hash, or sha256 of a legacy last line."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 262144))
            lines = [l for l in f.read().split(b"\n") if l.strip()]
    except OSError:
        return GENESIS
    if not lines:
        return GENESIS
    try:
        h = json.loads(lines[-1]).get("hash")
        if isinstance(h, str) and len(h) == 64:
            return h
    except (ValueError, AttributeError):
        pass
    return hashlib.sha256(lines[-1].strip()).hexdigest()


def append_log(path, rec):
    rec = dict(rec, prev=log_head(path))
    rec["hash"] = chain_hash(rec)
    with open(path, "a") as f:
        f.write(json.dumps(rec) + "\n")
    return rec["hash"]


def _text(v, limit, what, required=True):
    if v is None and not required:
        return ""
    if not isinstance(v, str) or not v.strip() or len(v) > limit:
        raise ValueError(f"{what}: expected text of 1..{limit} characters")
    return v


def _checklist(items, what):
    if not isinstance(items, list) or len(items) > 30:
        raise ValueError(f"{what}: expected a list of at most 30 steps")
    out = []
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            raise ValueError(f"{what}[{i}]: expected an object")
        out.append({"title": _text(it.get("title"), 160, f"{what}[{i}].title"),
                    "detail": _text(it.get("detail"), 400, f"{what}[{i}].detail", False),
                    "owner": _text(it.get("owner"), 80, f"{what}[{i}].owner", False)})
    return out


def load_drills(path):
    """Fire-drill scenarios + response checklists (see drills.example.json). Drills only ever
    run in the dashboard's SIMULATION layer in the browser; nothing here probes or alerts."""
    with open(path) as f:
        c = json.load(f)
    if not isinstance(c, dict) or not isinstance(c.get("drills"), list) or not 0 < len(c["drills"]) <= 20:
        raise ValueError('drills file must be {"drills": [1..20 drills]}')
    out = {"common_checklist": _checklist(c.get("common_checklist", []), "common_checklist"), "drills": []}
    for i, d in enumerate(c["drills"]):
        w = f"drills[{i}]"
        if not isinstance(d, dict) or not isinstance(d.get("id"), str) or not re.fullmatch(r"[a-z0-9-]{1,40}", d["id"]):
            raise ValueError(f"{w}.id: expected lowercase letters, digits, dashes")
        script = d.get("script")
        if not isinstance(script, list) or not 0 < len(script) <= 100:
            raise ValueError(f"{w}.script: expected 1..100 events")
        ev = []
        for k, e in enumerate(script):
            ok = (isinstance(e, dict) and isinstance(e.get("service"), str) and 0 < len(e["service"]) <= 64
                  and e.get("effect") in ("slow", "fail", "heal")
                  and type(e.get("t")) in (int, float) and 0 <= e["t"] <= 3600
                  and type(e.get("add_ms", 0)) in (int, float) and 0 <= e.get("add_ms", 0) <= 20000)
            if not ok:
                raise ValueError(f'{w}.script[{k}]: need {{"t": 0..3600, "service": name, "effect": slow|fail|heal, "add_ms": 0..20000}}')
            ev.append({"t": e["t"], "service": e["service"], "effect": e["effect"], "add_ms": e.get("add_ms", 1500)})
        out["drills"].append({"id": d["id"], "title": _text(d.get("title"), 120, w + ".title"),
                              "pattern": _text(d.get("pattern"), 300, w + ".pattern", False),
                              "description": _text(d.get("description"), 600, w + ".description", False),
                              "script": sorted(ev, key=lambda e: e["t"]),
                              "checklist": _checklist(d.get("checklist", []), w + ".checklist")})
    return out


def dependency_edges():
    """[upstream, dependent] pairs: what is at risk when the upstream service fails."""
    return ([["auth", n] for n in sorted(DEPENDS_ON_AUTH)] +
            [[n, "m365-copilot"] for n in sorted(COPILOT_NEEDS)])


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
        reason = str(getattr(e, "reason", e))
        if "Tunnel connection failed: 40" in reason or "ProxyError" in err:
            err = "proxy-denied"   # YOUR proxy/firewall refused, not a Microsoft outage
    ms = round((time.monotonic() - start) * 1000)
    if err == "proxy-denied":
        state = "blocked"
    elif err is not None or code is None or code >= 500 or code == 429:
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
            if r["state"] == "blocked":
                self.fails[n] = 0          # local policy, not an outage: never escalates
                st = "blocked"
            elif r["state"] == "down":
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
        v = set(state.values()) - {"blocked"}
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
        import tempfile
        doc = {"level": self.level, "services": affected,
               "updated": now or datetime.now(timezone.utc).isoformat(timespec="seconds")}
        d = os.path.dirname(os.path.abspath(self.freeze_file))
        fd, tmp = tempfile.mkstemp(dir=d)
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f)
        os.replace(tmp, self.freeze_file)         # atomic: readers never see a half file

    def _hook(self, level, affected):
        import shlex, subprocess
        env = dict(os.environ, OUTAGEWATCH_LEVEL=level, OUTAGEWATCH_SERVICES=",".join(affected))
        try:
            subprocess.run(shlex.split(self.on_change), env=env, timeout=30, check=False)
        except Exception as e:
            print(f"hook failed: {type(e).__name__}", file=sys.stderr)


def check_freeze(path, block_on="freeze"):
    """For pipelines: 0 = safe to proceed, 1 = blocked. A missing file means safe;
    an unreadable/corrupt file blocks (fail closed)."""
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
    blocked = [n for n, v in s.items() if v == "blocked"]
    if blocked:
        return "BLOCKED by your proxy/firewall (not a Microsoft outage): " + ", ".join(blocked)
    bad = [n for n, v in s.items() if v != "up"]
    if not bad:
        return "all healthy"
    if len(bad) == len(s):
        return "everything failing: check YOUR network/DNS first, then Microsoft"
    if s.get("auth") != "up":
        return "authentication degraded: sign-in dependent services will fail (Aug 31 pattern)"
    return "partial outage: " + ", ".join(bad)


def notify(webhook, text):
    """POST text to the webhook. Returns None on success, else the error type name."""
    body = json.dumps({"text": text}).encode()
    req = urllib.request.Request(webhook, data=body, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        print(f"webhook failed: {type(e).__name__}", file=sys.stderr)
        return type(e).__name__
    return None


def manual_test(targets, only=None, timeout=10.0, monitor=None):
    """One manual probe round for admins. Pure dry run: reads the monitor's baseline but
    changes nothing (no monitor history, freeze file, hook, webhook or log).
    `only` limits it to known target NAMES; unknown names raise ValueError.
    A manual test is a single probe, so a failure is reported as `down` without the
    two-in-a-row confirmation the continuous mode uses."""
    from concurrent.futures import ThreadPoolExecutor
    names = list(targets) if not only else list(dict.fromkeys(only))
    unknown = [n for n in names if n not in targets]
    if unknown:
        raise ValueError("unknown service: " + ", ".join(sorted(map(str, unknown))))
    with ThreadPoolExecutor(max_workers=min(16, len(names) or 1)) as ex:
        raw = list(ex.map(lambda n: probe(n, targets[n][0], targets[n][1], timeout=timeout), names))
    rows, state = [], {}
    for r in raw:
        base = monitor.baseline(r["name"]) if monitor else None
        slow = base is not None and r["ms"] > max(base * monitor.factor, base + monitor.floor_ms)
        st = "warning" if r["state"] == "degraded" or (r["state"] == "up" and slow) else r["state"]
        state[r["name"]] = st
        rows.append({"name": r["name"], "state": st, "code": r["code"], "ms": r["ms"],
                     "error": r["error"], "baseline": base})
    verdict = diagnose(raw)
    hit = impact(state)
    if hit:
        verdict += " | at risk: " + ", ".join(hit)
    level = Automation.target_level(state)
    return {"kind": "manual-test", "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "partial": len(names) < len(targets), "results": rows, "verdict": verdict,
            "level_would_set": level, "healthy": level == "ok", "applied": False}


def format_test(t):
    lines = [f"MANUAL TEST  {t['ts']}  ({'selected services only' if t['partial'] else 'all services'})", "",
             f"{'service':<20}{'state':<9}{'http':<6}{'ms':>7}  {'baseline':>9}  error"]
    for r in t["results"]:
        base = f"{r['baseline']} ms" if r["baseline"] is not None else "unknown"
        lines.append(f"{r['name']:<20}{r['state']:<9}{r['code']!s:<6}{r['ms']:>7}  {base:>9}  {r['error'] or '-'}")
    lines += ["", f"verdict: {t['verdict']}", f"freeze level this would set: {t['level_would_set']}",
              "applied: freeze file / hook / webhook updated" if t["applied"] else
              "dry run: freeze file, hooks, webhook and log NOT touched (use --apply to act on it)"]
    if any(r["state"] == "blocked" for r in t["results"]):
        lines.append("note: 'blocked' = your own proxy/firewall refused the probe; it is not counted as a problem")
    return "\n".join(lines)


def test_alert(webhook=None, on_change=None):
    """Send a clearly labelled TEST alert and run the hook once with OUTAGEWATCH_LEVEL=test."""
    import shlex, subprocess
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    text = f"[outage-watch TEST {now}] This is a manual TEST alert. No outage is implied; no action needed."
    out = {"kind": "test-alert", "ts": now, "message": text, "webhook": "not configured",
           "hook": "not configured", "hook_exit": None}
    if webhook:
        err = notify(webhook, text)
        out["webhook"] = "sent" if err is None else f"failed ({err})"
    if on_change:
        env = dict(os.environ, OUTAGEWATCH_LEVEL="test", OUTAGEWATCH_SERVICES="")
        try:
            out["hook_exit"] = subprocess.run(shlex.split(on_change), env=env, timeout=30, check=False).returncode
            out["hook"] = "ran"
        except Exception as e:
            out["hook"] = f"failed ({type(e).__name__})"
    out["ok"] = (bool(webhook) or bool(on_change)) and out["webhook"] in ("sent", "not configured") \
        and (not on_change or out["hook_exit"] == 0)
    return out


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
    roles = c.get("roles")
    if roles is not None and not (isinstance(roles, dict) and len(roles) <= 30 and all(
            isinstance(k, str) and 0 < len(k) <= 80 and isinstance(v, list) and 0 < len(v) <= 30
            and all(isinstance(x, str) for x in v) for k, v in roles.items())):
        raise ValueError('roles must be {"task name": ["service", ...]}')
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
        snapshot.update(now, automation.level if automation else "ok", verdict, results, state, monitor)
    if log_path:
        append_log(log_path, {"ts": now, "verdict": verdict, "published": state, "results": results})
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
    p.add_argument("--test", action="store_true", help="manual test: one detailed probe round, dry run (exit 0 ok, 1 problem)")
    p.add_argument("--only", nargs="+", metavar="NAME", help="with --test: probe only these service names")
    p.add_argument("--json", action="store_true", help="with --test / --test-alert: print JSON")
    p.add_argument("--apply", action="store_true", help="with --test: also write the freeze file, run the hook, send the webhook")
    p.add_argument("--test-alert", action="store_true", help="send a labelled TEST message to --webhook and run --on-change once")
    p.add_argument("--drills", metavar="FILE", help="fire-drill scenarios for the dashboard (default: drills.example.json)")
    p.add_argument("--admin-token", help="enable the dashboard's manual-test API (prefer env OUTAGEWATCH_ADMIN_TOKEN)")
    try:
        a = p.parse_args(argv)
    except SystemExit as e:
        return e.code
    if a.check_freeze:
        return check_freeze(a.check_freeze)
    if (a.only or a.apply) and not a.test:
        print("--only and --apply need --test", file=sys.stderr)
        return 2
    if a.test_alert:
        if not (a.webhook or a.on_change):
            print("--test-alert needs --webhook and/or --on-change", file=sys.stderr)
            return 2
        t = test_alert(a.webhook, a.on_change)
        print(json.dumps(t, indent=2) if a.json else
              f"sent: {t['message']}\nwebhook: {t['webhook']}\nhook: {t['hook']}\nhook exit code: {t['hook_exit']}")
        return 0 if t["ok"] else 1
    cfg = {}
    if a.config:
        try:
            cfg = load_config(a.config)
        except (OSError, ValueError) as e:
            print(f"bad config: {e}", file=sys.stderr)
            return 2
    auto = Automation(a.freeze_file, a.on_change, cfg.get("recover_after", 3)) \
        if (a.freeze_file or a.on_change or a.serve) else None   # the dashboard always shows a real level
    targets = {} if cfg.get("replace_defaults") else dict(DEFAULT_TARGETS)
    targets.update(cfg.get("targets", {}))
    if a.interval == 60 and "interval" in cfg:
        a.interval = cfg["interval"]
    if a.tenant:
        targets.update(tenant_targets(a.tenant))
    mon = Monitor(confirm=cfg.get("confirm", 2), factor=cfg.get("factor", 3.0),
                  floor_ms=cfg.get("floor_ms", 800))
    if a.test:
        try:
            t = manual_test(targets, a.only, a.timeout)
        except ValueError as e:
            print(f"{e} (known: {', '.join(sorted(targets))})", file=sys.stderr)
            return 2
        if a.apply:
            state = {r["name"]: r["state"] for r in t["results"]}
            if a.freeze_file or a.on_change:
                Automation(a.freeze_file, a.on_change).step(state, t["ts"])
            if a.webhook:
                notify(a.webhook, f"[outage-watch MANUAL TEST {t['ts']}] {t['verdict']} | level {t['level_would_set']}")
            t["applied"] = True
        print(json.dumps(t, indent=2) if a.json else format_test(t))
        return 0 if t["healthy"] else 1
    snap = None
    if a.serve:
        dpath = a.drills or os.path.join(os.path.dirname(os.path.abspath(__file__)), "drills.example.json")
        try:
            drills = load_drills(dpath) if (a.drills or os.path.exists(dpath)) else None
        except (OSError, ValueError) as e:
            print(f"bad drills file: {e}", file=sys.stderr)
            return 2
        from server import Snapshot, make_server
        token = os.environ.get("OUTAGEWATCH_ADMIN_TOKEN") or a.admin_token
        if a.admin_token:
            print("warning: --admin-token is visible in the process list; prefer env OUTAGEWATCH_ADMIN_TOKEN", file=sys.stderr)
        admin = {"token": token, "targets": lambda: list(targets),
                 "run_test": lambda only: manual_test(targets, only, a.timeout, mon),
                 "test_alert": lambda: test_alert(a.webhook, a.on_change)} if token else None
        snap = Snapshot(dependency_edges(), a.interval, cfg.get("roles") or DEFAULT_ROLES, drills)
        try:
            make_server(snap, a.serve, a.bind, admin)
        except ValueError as e:
            print(f"refusing to start dashboard: {e}", file=sys.stderr)
            return 2
        print(f"dashboard: http://{a.bind}:{a.serve}/  (metrics at /metrics; manual test "
              f"{'ENABLED, token required' if admin else 'disabled, set OUTAGEWATCH_ADMIN_TOKEN to enable'})")
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

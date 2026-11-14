#!/usr/bin/env python3
"""outage-watch installer logic (cross-platform, stdlib only).

Does everything except registering the OS service (the PowerShell script does that):
validate the environment ID, copy the app, generate config + tokens, run the unit
tests as a gate, run a live dry-run probe, write the launch settings.
Exit codes: 0 ok | 2 bad input | 3 tests failed | 4 other failure.
Secrets are written to a file and NEVER printed.
"""
import argparse
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
GUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
TENANT = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,62}")


class Bad(Exception):
    pass


def validate_env_id(value):
    """Strict GUID check. fullmatch + explicit ASCII classes: no newline, unicode digit or path tricks."""
    if not isinstance(value, str) or not GUID.fullmatch(value):
        raise Bad("environment ID must be a GUID like 00000000-0000-0000-0000-000000000000")
    return value.lower()


def validate_tenant(value):
    if value in (None, ""):
        return None
    if not TENANT.fullmatch(value):
        raise Bad("tenant must be the short tenant name, letters/digits/hyphens only (contoso, not contoso.onmicrosoft.com)")
    return value


def validate_port(value):
    if not isinstance(value, int) or not (1024 <= value <= 65535):
        raise Bad("port must be an integer between 1024 and 65535")
    return value


def paths(base_dir, env_id):
    env_dir = os.path.join(os.path.abspath(base_dir), env_id)
    if os.path.dirname(env_dir) != os.path.abspath(base_dir):   # containment guard
        raise Bad("refusing path outside the base directory")
    return {"env": env_dir, "app": os.path.join(env_dir, "app"), "data": os.path.join(env_dir, "data"),
            "config": os.path.join(env_dir, "config.json"), "envfile": os.path.join(env_dir, "outagewatch.env"),
            "deploy": os.path.join(env_dir, "deploy.json")}


def say(msg, level="ok"):
    print(f"    [{level}] {msg}", flush=True)


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def default_config(env_id):
    return {
        "interval": 60, "confirm": 2, "recover_after": 3,
        "environment_id": env_id,
        "targets": {
            "power-platform-env": [f"https://make.powerapps.com/environments/{env_id}/home", None]
        },
    }


def install(a):
    env_id = validate_env_id(a.env_id)
    tenant = validate_tenant(a.tenant)
    port = validate_port(a.port)
    p = paths(a.base_dir, env_id)
    app_src = os.path.join(HERE, "app")
    if not os.path.isfile(os.path.join(app_src, "outagewatch.py")):
        raise Bad("package is incomplete: app/outagewatch.py not found")
    name = f"outagewatch-{env_id[:8]}"
    plan = [f"copy app -> {p['app']}", f"write config -> {p['config']} (kept if it exists)",
            f"write tokens -> {p['envfile']} (kept if it exists, never printed)",
            "run unit tests (gate)" if not a.skip_tests else "SKIP unit tests",
            "live dry-run probe of Microsoft 365 / Copilot endpoints" if not a.no_live_test else "SKIP live probe"]
    print(f"Deployment name: {name}\nEnvironment ID : {env_id}\nPort           : {port} (localhost only)")
    print("Plan:")
    for i, s in enumerate(plan, 1):
        print(f"  {i}. {s}")
    if a.dry_run:
        print("Dry run: nothing changed.")
        return 0

    os.makedirs(p["data"], exist_ok=True)
    # 1. app copy (upgrade keeps config, tokens and data, which live outside app/)
    if os.path.isdir(p["app"]):
        shutil.rmtree(p["app"])
    shutil.copytree(app_src, p["app"], ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.jsonl"))
    say("app copied")

    # 2. config
    if os.path.exists(p["config"]):
        say("existing config kept")
    else:
        with open(p["config"], "w") as f:
            json.dump(default_config(env_id), f, indent=2)
        say("config created")

    # 3. tokens
    if os.path.exists(p["envfile"]):
        say("existing tokens kept")
    else:
        write_private(p["envfile"], f"OUTAGEWATCH_ADMIN_TOKEN={secrets.token_urlsafe(32)}\n")
        say(f"admin token generated; stored in {p['envfile']} (not shown)")

    # 4. launch settings
    meta = {"env_id": env_id, "name": name, "port": port, "tenant": tenant,
            "installed_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    with open(p["deploy"], "w") as f:
        json.dump(meta, f, indent=2)

    # 5. tests gate
    if a.skip_tests:
        say("unit tests skipped by request", "warn")
    else:
        print("    running unit tests (about 20-30 s)...", flush=True)
        r = subprocess.run([sys.executable, "-W", "ignore", "-m", "unittest"], cwd=p["app"],
                           capture_output=True, text=True, timeout=600,
                           env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-6:])
        if r.returncode != 0:
            print(tail)
            say("unit tests FAILED: deployment stopped before anything was started", "fail")
            return 3
        say("unit tests passed")

    # 6. live probe (never fails the deploy; tells you what it saw)
    if not a.no_live_test:
        try:
            r = subprocess.run([sys.executable, "outagewatch.py", "--test", "--json", "--timeout", "10"],
                               cwd=p["app"], capture_output=True, text=True, timeout=180,
                               env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
            data = json.loads(r.stdout)
            states = [x.get("state") for x in data.get("results", [])]
            n = {k: states.count(k) for k in ("up", "warning", "suspect", "down", "blocked")}
            say(f"live probe: {n['up']} up, {n['blocked']} blocked, {n['down']} down, "
                f"{n['warning'] + n['suspect']} warning/suspect (of {len(states)})")
            if states and n["down"] == len(states):
                say("everything failed: check this machine's internet, DNS and proxy before trusting the monitor", "warn")
            elif n["blocked"]:
                say("some probes were refused by your proxy/firewall (not a Microsoft outage). "
                    "Allow those hosts outbound for full coverage", "warn")
        except Exception as e:
            say(f"live probe could not run ({type(e).__name__}); continuing", "warn")
    print(f"INSTALLED name={name} dir={p['env']}")
    return 0


def uninstall(a):
    env_id = validate_env_id(a.env_id)
    p = paths(a.base_dir, env_id)
    if not os.path.isdir(p["env"]):
        say("nothing installed here")
        return 0
    if a.purge:
        shutil.rmtree(p["env"])
        say("removed everything including config, tokens, data and logs")
    else:
        if os.path.isdir(p["app"]):
            shutil.rmtree(p["app"])
        say(f"removed the app; kept config, tokens and data in {p['env']} (use --purge to delete)")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--env-id", required=True)
    ap.add_argument("--base-dir", required=True)
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--tenant")
    ap.add_argument("--skip-tests", action="store_true")
    ap.add_argument("--no-live-test", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--purge", action="store_true")
    a = ap.parse_args(argv)
    try:
        return uninstall(a) if a.uninstall else install(a)
    except Bad as e:
        print(f"    [fail] {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"    [fail] {type(e).__name__}: {e}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())

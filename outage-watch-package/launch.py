#!/usr/bin/env python3
"""Service entry point. Loads secrets from the private env file (so they never appear in
the process arguments), then runs outage-watch with the settings written by install.py."""
import argparse
import json
import os
import sys


def load_env_file(path):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()


def build_argv(env_dir):
    meta = json.load(open(os.path.join(env_dir, "deploy.json")))
    data = os.path.join(env_dir, "data")
    argv = ["--config", os.path.join(env_dir, "config.json"), "--serve", str(meta["port"]),
            "--log", os.path.join(data, "outagewatch.jsonl"),
            "--freeze-file", os.path.join(data, "freeze.json")]
    if meta.get("tenant"):
        argv += ["--tenant", meta["tenant"]]
    hook = os.environ.get("OUTAGEWATCH_WEBHOOK", "").strip()
    if hook.startswith(("https://", "http://")):      # Slack/Teams/Discord incoming webhook
        argv += ["--webhook", hook]
    return argv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-dir", required=True)
    a = ap.parse_args()
    env_dir = os.path.abspath(a.env_dir)
    load_env_file(os.path.join(env_dir, "outagewatch.env"))
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.dont_write_bytecode = True
    app = os.path.join(env_dir, "app")
    sys.path.insert(0, app)
    os.chdir(app)
    import outagewatch
    return outagewatch.main(build_argv(env_dir))


if __name__ == "__main__":
    sys.exit(main())

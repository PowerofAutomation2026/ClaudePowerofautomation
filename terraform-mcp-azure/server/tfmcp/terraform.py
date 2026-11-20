"""Terraform CLI wrapper. The server only ever talks to Terraform through ``TerraformRunner.run``,
so tests inject a fake runner and never need the binary or Azure."""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import signal
import subprocess
import threading
import time
from typing import Any


class TerraformError(RuntimeError):
    def __init__(self, step: str, output: str) -> None:
        self.step = step
        self.output = output
        super().__init__(f"terraform {step} failed:\n{output[-3000:]}")


class Cancelled(RuntimeError):
    """The operation was interrupted (replica shutting down or it lost its lease)."""


class TerraformRunner:
    def __init__(self, binary: str = "terraform", base_env: dict[str, str] | None = None) -> None:
        self.binary = binary
        self.base_env = base_env or {}

    def run(self, args: list[str], cwd: pathlib.Path, *, env: dict[str, str] | None = None, timeout: float = 3300,
            cancel: threading.Event | None = None) -> tuple[int, str]:
        """Run ``terraform <args>``; returns (exit code, combined output). On ``cancel`` Terraform gets
        SIGINT (it stops gracefully, writes state and releases its state lock), then SIGKILL after 60s."""
        full_env = {**os.environ, "TF_IN_AUTOMATION": "1", "TF_INPUT": "0", **self.base_env, **(env or {})}
        proc = subprocess.Popen([self.binary, *args], cwd=str(cwd), env=full_env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, start_new_session=True)
        chunks: list[str] = []
        reader = threading.Thread(target=lambda: chunks.extend(iter(proc.stdout.readline, "")), daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout
        interrupted_at = None
        reason = ""
        while proc.poll() is None:
            now = time.monotonic()
            if interrupted_at is None and ((cancel is not None and cancel.is_set()) or now > deadline):
                reason = "cancelled" if cancel is not None and cancel.is_set() else "timed out"
                interrupted_at = now
                proc.send_signal(signal.SIGINT)
            elif interrupted_at is not None and now - interrupted_at > 60:
                proc.kill()
            time.sleep(0.2)
        reader.join(5)
        out = "".join(chunks)
        if interrupted_at is not None:
            raise Cancelled(f"terraform {args[0]} {reason}:\n{out[-2000:]}")
        return proc.returncode, out


def backend_args(state_account: str, state_key: str, subscription_id: str) -> list[str]:
    return ["-backend-config=storage_account_name=" + state_account,
            "-backend-config=container_name=tfstate",
            "-backend-config=key=" + state_key,
            "-backend-config=use_azuread_auth=true",
            "-backend-config=use_msi=true",
            "-backend-config=subscription_id=" + subscription_id]


def prepare_workdir(workdir: pathlib.Path, template_path: pathlib.Path, common_file: pathlib.Path, variables: dict) -> None:
    shutil.copytree(template_path, workdir, dirs_exist_ok=True)
    shutil.copy(common_file, workdir / "common.tf")
    (workdir / "template.json").unlink(missing_ok=True)
    (workdir / "terraform.tfvars.json").write_text(json.dumps(variables))


# ------------------------------------------------------------------ plan JSON helpers
REDACTED = "(sensitive)"


def _redact(value: Any, mask: Any) -> Any:
    if mask is True:
        return REDACTED if value is not None else None
    if isinstance(value, dict) and isinstance(mask, dict):
        return {k: _redact(v, mask.get(k)) for k, v in value.items()}
    if isinstance(value, list) and isinstance(mask, list):
        return [_redact(v, mask[i] if i < len(mask) else None) for i, v in enumerate(value)]
    return value


def slim_plan(plan: dict) -> dict:
    """Keep only what policy / cost / explain need, with sensitive values masked. The result is safe
    to store next to the plan and to return to the agent; the full plan JSON never leaves the worker."""
    out: dict[str, Any] = {"format_version": plan.get("format_version"), "terraform_version": plan.get("terraform_version"),
                           "resource_changes": [], "resource_drift": [], "output_changes": {}}
    for section in ("resource_changes", "resource_drift"):
        for rc in plan.get(section) or []:
            ch = rc.get("change") or {}
            out[section].append({
                "address": rc.get("address"), "mode": rc.get("mode", "managed"), "type": rc.get("type"), "name": rc.get("name"),
                "action_reason": rc.get("action_reason"),
                "change": {"actions": ch.get("actions") or [],
                           "before": _redact(ch.get("before"), ch.get("before_sensitive")),
                           "after": _redact(ch.get("after"), ch.get("after_sensitive")),
                           "after_unknown": ch.get("after_unknown") or {},
                           "replace_paths": ch.get("replace_paths") or []}})
    for name, ch in (plan.get("output_changes") or {}).items():
        out["output_changes"][name] = {"actions": ch.get("actions") or []}
    return out


def state_resources(state: dict) -> list[dict]:
    """Flatten ``terraform show -json`` (state) into [{address, type, name, id}] - ids only, no attributes."""
    found: list[dict] = []

    def walk(module: dict) -> None:
        for r in module.get("resources") or []:
            if r.get("mode", "managed") != "managed":
                continue
            found.append({"address": r.get("address"), "type": r.get("type"), "name": r.get("name"),
                          "id": (r.get("values") or {}).get("id")})
        for child in module.get("child_modules") or []:
            walk(child)

    walk((state.get("values") or {}).get("root_module") or {})
    return found


def public_outputs(raw: dict) -> dict:
    """``terraform output -json`` -> plain values, with sensitive outputs masked."""
    return {k: (REDACTED if v.get("sensitive") else v.get("value")) for k, v in (raw or {}).items() if isinstance(v, dict)}

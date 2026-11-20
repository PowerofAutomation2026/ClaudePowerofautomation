"""Per-user audit trail. Every tool call becomes one structured JSON line on stdout (collected by
Container Apps into Log Analytics) and one small blob in the ``audit`` container.

Fields: who (Entra object id + sign-in name), tool, a SHA-256 of the arguments (so identical calls
can be correlated without logging values), a few safe routing arguments, the outcome and duration."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import sys
import threading
import time
import uuid
from typing import Any, Callable, TextIO

from .identity import Identity
from .storage import Store

SAFE_ARGS = ("environment", "deployment_name", "template", "plan_id", "operation_id", "ttl_hours", "hours")
_print_lock = threading.Lock()


def args_hash(args: dict) -> str:
    return hashlib.sha256(json.dumps(args, sort_keys=True, default=str).encode()).hexdigest()


class AuditLog:
    def __init__(self, store: Store | None, stream: TextIO | None = None, clock: Callable[[], float] = time.time) -> None:
        self.store = store
        self.stream = stream
        self.clock = clock

    def emit(self, event: dict) -> None:
        """Write one structured log line (also used for non-audit events such as drift or TTL notices)."""
        event = {"ts": dt.datetime.fromtimestamp(self.clock(), dt.timezone.utc).isoformat(timespec="milliseconds"),
                 "app": "azure-terraform-mcp", **event}
        line = json.dumps(event, default=str, sort_keys=True)
        with _print_lock:
            stream = self.stream or sys.stdout
            stream.write(line + "\n")
            stream.flush()

    def record(self, identity: Identity, tool: str, args: dict, outcome: str, *, error: str | None = None,
               duration_ms: float = 0.0, extra: dict[str, Any] | None = None) -> dict:
        now = self.clock()
        event = {"type": "audit", "audit_id": uuid.uuid4().hex, "user": identity.name, "user_oid": identity.oid,
                 "auth": identity.source, "client_app": identity.app_id, "tool": tool, "args_sha256": args_hash(args),
                 "args": {k: args[k] for k in SAFE_ARGS if args.get(k) is not None}, "outcome": outcome,
                 "duration_ms": round(duration_ms, 1)}
        if error:
            event["error"] = error[:500]
        if extra:
            event.update(extra)
        self.emit(event)
        if self.store is not None:
            day = dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime("%Y/%m/%d")
            try:
                self.store.put_json(f"{day}/{int(now * 1000)}-{event['audit_id'][:8]}.json", event)
            except Exception as e:  # the stdout line is the primary record; never fail the call
                self.emit({"type": "audit_write_failed", "audit_id": event["audit_id"], "error": str(e)[:300]})
        return event

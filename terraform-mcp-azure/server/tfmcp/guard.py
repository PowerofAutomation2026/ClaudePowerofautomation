"""Kill switch, change windows, rate limits, blast-radius quotas and anomaly auto-freeze.

None of this depends on the agent behaving. Two freeze flags exist on purpose:

* ``control/freeze.json``   - set/cleared only through the admin endpoint of the approval service
  (the MCP front-end identity has read-only access to the ``control`` container);
* ``auto-freeze.json``      - written by the front-end itself when its anomaly detection trips.
  Clearing it also needs the admin endpoint. (A fully compromised front-end process could delete
  its own auto-freeze flag; it can never clear the admin freeze, and it has no Azure write rights.)

Frozen = no plans, approvals, applies, destroys, TTL changes. Reads keep working.
Quotas that bound real damage (applies per hour, resources deleted per day) are counted by the
privileged executor in the ``control`` container, out of the front-end's reach."""
from __future__ import annotations

import datetime as dt
import threading
import time
from typing import Callable

from .config import WEEKDAYS, EnvironmentConfig, Settings
from .identity import Identity
from .storage import Conflict, NotFound, Store


class GuardError(Exception):
    """A server-side limit refused the call. ``kind`` becomes the audit outcome."""

    def __init__(self, message: str, kind: str = "limited") -> None:
        super().__init__(message)
        self.kind = kind


class Guard:
    def __init__(self, settings: Settings, data: Store, control: Store, *, clock: Callable[[], float] = time.time,
                 emit: Callable[[dict], None] | None = None) -> None:
        self.s = settings
        self.data = data
        self.control = control
        self.clock = clock
        self.emit = emit or (lambda e: None)
        self._calls: dict[str, list[float]] = {}
        self._mu = threading.Lock()
        self._freeze_cache: tuple[float, dict | None] = (-1e9, None)

    # ------------------------------------------------------------------ freeze
    def frozen(self, fresh: bool = False) -> dict | None:
        now = time.monotonic()
        if not fresh and now - self._freeze_cache[0] < 3:
            return self._freeze_cache[1]
        state = None
        for store, key, source in ((self.control, "freeze.json", "admin"), (self.data, "auto-freeze.json", "auto")):
            try:
                doc = store.get_json(key)
                if doc.get("frozen", True):
                    state = {"source": source, "reason": doc.get("reason", ""), "since": doc.get("at"), "by": doc.get("by")}
                    break
            except (NotFound, ValueError):
                continue
        self._freeze_cache = (now, state)
        return state

    def require_unfrozen(self) -> None:
        state = self.frozen()
        if state:
            raise GuardError("The server is FROZEN: no plans, approvals or changes are possible until an administrator "
                             f"lifts the freeze. Reason: {state['reason'] or 'not given'}", "frozen")

    def set_freeze(self, frozen: bool, by: Identity, reason: str) -> dict:
        """Admin action (approval service only: needs write access to the control container)."""
        now = self.clock()
        if frozen:
            self.control.put_json("freeze.json", {"frozen": True, "reason": reason[:300], "by": by.name, "by_oid": by.oid, "at": now})
        else:
            self.control.delete("freeze.json")
            self.data.delete("auto-freeze.json")
        self._freeze_cache = (-1e9, None)
        self.emit({"type": "freeze_set" if frozen else "freeze_lifted", "user": by.name, "user_oid": by.oid, "reason": reason[:300]})
        return {"frozen": frozen, "reason": reason[:300]}

    def trip(self, reason: str, identity: Identity | None = None) -> None:
        """Anomaly detected: freeze automatically."""
        try:
            self.data.put_json("auto-freeze.json", {"frozen": True, "reason": reason, "at": self.clock(),
                                                    "by": "anomaly-detection"}, if_none_match=True)
        except Conflict:
            return
        self._freeze_cache = (-1e9, None)
        self.emit({"type": "freeze_tripped", "reason": reason, "user": identity.name if identity else None,
                   "user_oid": identity.oid if identity else None})

    # ------------------------------------------------------------------ counters
    @staticmethod
    def _bump(store: Store, key: str, n: int = 1) -> int:
        for _ in range(10):
            try:
                doc, etag = store.get_json_etag(key)
                doc["n"] = int(doc.get("n", 0)) + n
                try:
                    store.put_json(key, doc, if_match=etag)
                    return doc["n"]
                except Conflict:
                    continue
            except NotFound:
                try:
                    store.put_json(key, {"n": n}, if_none_match=True)
                    return n
                except Conflict:
                    continue
        raise GuardError("Too much contention on a rate counter; try again shortly.")

    @staticmethod
    def _read(store: Store, key: str) -> int:
        try:
            return int(store.get_json(key).get("n", 0))
        except (NotFound, ValueError):
            return 0

    def _window(self, seconds: int) -> int:
        return int(self.clock() // seconds)

    # ------------------------------------------------------------------ per-call limits (front-end)
    def call(self, identity: Identity) -> None:
        """Per-user calls per minute (in memory, per replica - cheap first line of defence)."""
        if identity.is_system:
            return
        now = self.clock()
        with self._mu:
            recent = [t for t in self._calls.get(identity.oid, []) if now - t < 60]
            if len(recent) >= self.s.user_calls_per_minute:
                self._calls[identity.oid] = recent
                raise GuardError(f"Rate limit: at most {self.s.user_calls_per_minute} calls per minute. Wait and retry.")
            recent.append(now)
            self._calls[identity.oid] = recent

    def plan_started(self, identity: Identity, destroy: bool) -> None:
        """Counted in storage so the limits hold across replicas and restarts."""
        if identity.is_system:
            return
        hour, ten = self._window(3600), self._window(600)
        n = self._bump(self.data, f"limits/h{hour}/plans-{identity.oid}.json")
        if n > self.s.user_plans_per_hour:
            raise GuardError(f"Rate limit: at most {self.s.user_plans_per_hour} plans per hour per person.")
        if self._bump(self.data, f"limits/t{ten}/plans-all.json") > self.s.anomaly_plans_per_10min:
            self.trip(f"burst of more than {self.s.anomaly_plans_per_10min} plans in 10 minutes", identity)
            self.require_unfrozen()
        if destroy and self._bump(self.data, f"limits/h{hour}/destroy-{identity.oid}.json") > self.s.anomaly_destroy_plans_per_hour:
            self.trip(f"{identity.name} requested more than {self.s.anomaly_destroy_plans_per_hour} destroy plans in one hour", identity)
            self.require_unfrozen()

    def denied(self, identity: Identity) -> None:
        """Called for every denied call; many denials from one user look like probing."""
        if identity.is_system:
            return
        try:
            n = self._bump(self.data, f"limits/t{self._window(600)}/denied-{identity.oid}.json")
        except Exception:  # noqa: BLE001 - never mask the original denial
            return
        if n > self.s.anomaly_denied_per_10min:
            self.trip(f"more than {self.s.anomaly_denied_per_10min} denied calls from {identity.name} in 10 minutes", identity)

    # ------------------------------------------------------------------ change windows
    def check_window(self, env: EnvironmentConfig) -> None:
        if not env.change_windows:
            return
        now = dt.datetime.fromtimestamp(self.clock(), dt.timezone.utc)
        day, hhmm = WEEKDAYS[now.weekday()], now.strftime("%H:%M")
        for w in env.change_windows:
            if day in (w.get("days") or WEEKDAYS) and w["start"] <= hhmm < w["end"]:
                return
        text = "; ".join(f"{','.join(w.get('days') or ['every day'])} {w['start']}-{w['end']} UTC" for w in env.change_windows)
        raise GuardError(f"Outside the change window for environment '{env.name}'. Changes are allowed: {text}.", "window")

    # ------------------------------------------------------------------ damage quotas (executor, trusted store)
    def reserve_apply(self, deletes: int) -> None:
        """Called by the privileged executor right before an apply. Raises if a global quota is exhausted."""
        hour, day = self._window(3600), self._window(86400)
        used = self._read(self.control, f"quota/d{day}/deletes.json")
        if deletes and used + deletes > self.s.global_deletes_per_day:
            raise GuardError(f"Daily deletion quota reached: this plan deletes or replaces {deletes} resource(s); "
                             f"{used} of {self.s.global_deletes_per_day} allowed today are already used. An administrator must raise the quota.", "quota")
        if self._bump(self.control, f"quota/h{hour}/applies.json") > self.s.global_applies_per_hour:
            raise GuardError(f"Hourly apply quota reached ({self.s.global_applies_per_hour} applies per hour for all users).", "quota")
        if deletes:
            self._bump(self.control, f"quota/d{day}/deletes.json", deletes)

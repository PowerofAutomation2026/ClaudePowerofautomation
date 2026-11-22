"""Durable, horizontally-safe long-running operations.

Why: Copilot Studio tool calls time out after a short while, but ``terraform plan/apply`` can take
many minutes. So every plan / apply / drift check is an *operation* that is pollable by id.

How it survives restarts and scale-out (no state lives only in one replica's memory):

* The operation document lives in the store (``ops/<id>.json``). Any replica can answer ``get``.
* A worker *claims* an operation with a compare-and-swap (ETag) write and then renews a lease
  (``lease_expires_at``) every few seconds. Two replicas can never run the same operation.
* One operation at a time per deployment: ``locks/<env>/<deployment>.json`` points at the holder.
  A lock whose holder is finished or gone is taken over with a compare-and-swap.
* Every replica runs ``tick()``: it adopts queued operations when it has capacity and recovers
  operations whose lease expired (their worker died):
    - plan / drift (read-only, repeatable) are re-queued, at most ``max_attempts`` times;
    - apply is NEVER re-run automatically. It is marked ``interrupted`` and the caller is told to
      plan again (Terraform refuses a stale saved plan anyway).
  In both cases the Terraform state-blob lease left behind by the dead process is broken, which is
  safe because the per-deployment lock guarantees no live operation holds it.
* On SIGTERM the replica cancels its operations: Terraform gets SIGINT, finishes the resource it is
  on, writes state and unlocks. The Container App's termination grace period is raised for this.
"""
from __future__ import annotations

import datetime as dt
import threading
import time
import traceback
import uuid
from typing import Any, Callable

from .storage import Conflict, NotFound, Store
from .terraform import Cancelled

TERMINAL = ("succeeded", "failed", "interrupted")


class Busy(RuntimeError):
    """Another operation is in flight for the same deployment."""


class OperationFailed(RuntimeError):
    """Raise inside a handler for an expected, user-facing failure (no stack trace is logged)."""


def iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def short_etag(tag: str) -> str:
    """Opaque change marker for cheap polling ("unchanged since etag X")."""
    import hashlib
    return hashlib.sha256(str(tag).encode()).hexdigest()[:8]


class OpContext:
    def __init__(self, engine: "OperationEngine", op: dict, cancel: threading.Event) -> None:
        self.engine = engine
        self.op = op
        self.cancel = cancel

    def progress(self, message: str) -> None:
        """Best-effort progress note, visible through get_operation."""
        try:
            def mutate(doc):
                if doc.get("owner") != self.engine.owner or doc["status"] != "running":
                    raise Conflict("not the owner")
                doc["progress"] = message
                return doc
            self.engine.store.update_json(f"ops/{self.op['operation_id']}.json", mutate)
        except Exception:
            pass


class OperationEngine:
    def __init__(self, store: Store, *, state_store: Store | None = None, owner: str | None = None,
                 clock: Callable[[], float] = time.time, lease_seconds: float = 120, heartbeat_seconds: float = 20,
                 max_workers: int = 2, max_attempts: int = 3, log: Callable[[dict], None] | None = None) -> None:
        self.store = store
        self.state_store = state_store
        self.owner = owner or uuid.uuid4().hex[:12]
        self.clock = clock
        self.lease_seconds = lease_seconds
        self.heartbeat_seconds = heartbeat_seconds
        self.max_attempts = max_attempts
        self.log = log or (lambda event: None)
        self._handlers: dict[str, tuple[Callable[[dict, OpContext], Any], bool]] = {}
        self._accepted: set[str] = set()
        self._inline_only: set[str] = set()   # kinds this process may QUEUE without being able to RUN them
        self._slots = threading.Semaphore(max_workers)
        self._running: dict[str, tuple[threading.Event, threading.Event]] = {}   # op id -> (cancel, done)
        self._mu = threading.Lock()
        self._stop = threading.Event()
        self._poller: threading.Thread | None = None

    # ------------------------------------------------------------------ registration / public API
    def register(self, kind: str, handler: Callable[[dict, OpContext], Any], *, retryable: bool, adopt: bool = True) -> None:
        """``adopt=False``: this process can run the kind inline (its own jobs) but never picks up queued ones."""
        self._handlers[kind] = (handler, retryable)
        if not adopt:
            self._inline_only.add(kind)

    def accept(self, *kinds: str) -> None:
        """Allow queuing these kinds. A process only RUNS the kinds it registered a handler for: the MCP
        front-end queues 'apply' but has no handler (and no Azure write rights); the privileged executor has."""
        self._accepted.update(kinds)

    def submit(self, kind: str, params: dict, *, actor: dict, environment: str = "", deployment: str = "",
               lock: str | None = None, state_key: str | None = None, wait: float = 0.0, inline: bool = False) -> dict:
        """Queue an operation and start it on this replica if there is capacity. Waits up to ``wait``
        seconds for it to finish, then returns its current public view (poll ``get`` afterwards).
        ``inline=True`` runs it on the calling thread (scheduled jobs)."""
        if kind not in self._handlers and kind not in self._accepted:
            raise ValueError(f"unknown operation kind {kind}")
        if inline and kind not in self._handlers:
            raise ValueError(f"this process cannot run '{kind}' operations")
        op_id = uuid.uuid4().hex[:12]
        now = self.clock()
        doc = {"operation_id": op_id, "kind": kind, "params": params, "status": "queued", "actor": actor,
               "environment": environment, "deployment": deployment, "lock": lock, "state_key": state_key,
               "created_at": now, "queued_at": now, "started_at": None, "finished_at": None, "owner": None,
               "lease_expires_at": None, "attempts": 0, "result": None, "error": None, "progress": None}
        # Order matters for crash safety: record + "active" marker first, lock last. If this replica dies
        # anywhere in between, tick() on another replica still finds the operation and runs or cleans it.
        self.store.put_json(f"ops/{op_id}.json", doc, if_none_match=True)
        self.store.put_json(f"ops-active/{op_id}", {"created_at": now})
        if lock:
            try:
                self._acquire_lock(lock, op_id)
            except Busy:
                self.store.delete(f"ops-active/{op_id}")
                self.store.delete(f"ops/{op_id}.json")
                raise
        if inline:
            self._slots.acquire()
            self._execute(op_id, threading.Event(), threading.Event(), holds_slot=True)
            return self.get(op_id)
        done = self._start_local(op_id) if kind in self._handlers and kind not in self._inline_only else None
        if done is not None and wait > 0:
            done.wait(wait)
        return self.get(op_id)

    def get(self, op_id: str) -> dict:
        try:
            doc, tag = self.store.get_json_etag(f"ops/{op_id}.json")
            return {**self.public(doc), "etag": short_etag(tag)}
        except NotFound:
            raise NotFound(f"No operation with id {op_id}") from None

    def public(self, doc: dict) -> dict:
        out = {"operation_id": doc["operation_id"], "kind": doc["kind"], "status": doc["status"],
               "environment": doc.get("environment"), "deployment": doc.get("deployment"),
               "requested_by": (doc.get("actor") or {}).get("name"),
               "created_at": iso(doc.get("created_at")), "started_at": iso(doc.get("started_at")),
               "finished_at": iso(doc.get("finished_at")), "attempts": doc.get("attempts", 0)}
        if doc["status"] in ("queued", "running"):
            out["progress"] = doc.get("progress")
            out["next"] = (f"Still {doc['status']}. Call get_operation('{doc['operation_id']}') again in about 20 seconds. "
                           "Do not start the same request again.")
        if doc.get("result") is not None:
            out["result"] = doc["result"]
        if doc.get("error"):
            out["error"] = doc["error"]
        return out

    # ------------------------------------------------------------------ locks
    def _acquire_lock(self, lock: str, op_id: str) -> None:
        key = f"locks/{lock}.json"
        body = {"operation_id": op_id, "acquired_at": self.clock()}
        try:
            self.store.put_json(key, body, if_none_match=True)
            return
        except Conflict:
            pass
        try:
            current, etag = self.store.get_json_etag(key)
        except NotFound:
            try:
                self.store.put_json(key, body, if_none_match=True)
                return
            except Conflict:
                raise Busy("Another operation just started for this deployment. Try again shortly.") from None
        holder_id = current.get("operation_id")
        try:
            holder = self.store.get_json(f"ops/{holder_id}.json")
        except NotFound:
            holder = None
        if holder is not None and holder["status"] not in TERMINAL:
            raise Busy(f"Deployment is busy: operation {holder_id} ({holder['kind']}, {holder['status']}) is in progress. "
                       f"Wait for it to finish (get_operation('{holder_id}')) before starting another.")
        try:
            self.store.put_json(key, body, if_match=etag)   # stale lock: take it over
        except Conflict:
            raise Busy("Another operation just started for this deployment. Try again shortly.") from None

    def _release_lock(self, lock: str | None, op_id: str) -> None:
        if not lock:
            return
        key = f"locks/{lock}.json"
        try:
            current, etag = self.store.get_json_etag(key)
            if current.get("operation_id") == op_id:
                self.store.delete(key, if_match=etag)   # conditional: never delete a lock someone else just took
        except (NotFound, Conflict):
            pass

    def lock_holder(self, lock: str) -> str | None:
        try:
            holder_id = self.store.get_json(f"locks/{lock}.json").get("operation_id")
            holder = self.store.get_json(f"ops/{holder_id}.json")
            return holder_id if holder["status"] not in TERMINAL else None
        except NotFound:
            return None

    # ------------------------------------------------------------------ execution
    def _start_local(self, op_id: str) -> threading.Event | None:
        if self._stop.is_set() or not self._slots.acquire(blocking=False):
            return None   # stays queued; any replica's tick() adopts it
        cancel, done = threading.Event(), threading.Event()
        with self._mu:
            self._running[op_id] = (cancel, done)
        threading.Thread(target=self._execute, args=(op_id, cancel, done), kwargs={"holds_slot": True},
                         name=f"op-{op_id}", daemon=True).start()
        return done

    def _claim(self, op_id: str) -> dict | None:
        key = f"ops/{op_id}.json"
        try:
            doc, etag = self.store.get_json_etag(key)
        except NotFound:
            return None
        if doc["status"] != "queued":
            return None
        now = self.clock()
        doc.update(status="running", owner=self.owner, started_at=doc.get("started_at") or now,
                   lease_expires_at=now + self.lease_seconds, attempts=doc.get("attempts", 0) + 1, progress="starting")
        try:
            self.store.put_json(key, doc, if_match=etag)
        except Conflict:
            return None   # another replica claimed it first
        return doc

    def _heartbeat(self, op_id: str, cancel: threading.Event, finished: threading.Event) -> None:
        key = f"ops/{op_id}.json"
        last_ok = self.clock()
        while not finished.wait(self.heartbeat_seconds):
            try:
                def mutate(doc):
                    if doc.get("owner") != self.owner or doc["status"] != "running":
                        raise Conflict("lease lost")
                    doc["lease_expires_at"] = self.clock() + self.lease_seconds
                    return doc
                self.store.update_json(key, mutate)
                last_ok = self.clock()
            except Conflict:
                cancel.set()      # someone else recovered this operation: stop touching the deployment
                return
            except Exception:
                if self.clock() - last_ok > self.lease_seconds:
                    cancel.set()  # cannot reach storage: our lease has expired, stop
                    return

    def _execute(self, op_id: str, cancel: threading.Event, done: threading.Event, holds_slot: bool = False) -> None:
        try:
            doc = self._claim(op_id)
            if doc is None:
                return
            handler, retryable = self._handlers[doc["kind"]]
            finished = threading.Event()
            hb = threading.Thread(target=self._heartbeat, args=(op_id, cancel, finished), daemon=True)
            hb.start()
            status, result, error = "succeeded", None, None
            try:
                result = handler(doc, OpContext(self, doc, cancel))
            except Cancelled as e:
                if retryable and doc["attempts"] < self.max_attempts:
                    status = "queued"
                else:
                    status, error = "interrupted", self._interrupted_message(doc["kind"], str(e))
            except OperationFailed as e:
                status, error = "failed", str(e)[-4000:]
            except Exception as e:  # noqa: BLE001 - reported to the caller, never crashes the worker
                status, error = "failed", f"{type(e).__name__}: {e}"[-4000:]
                self.log({"type": "operation_error", "operation_id": op_id, "kind": doc["kind"],
                          "trace": traceback.format_exc()[-4000:]})
            finally:
                finished.set()
            self._finish(doc, status, result, error)
        finally:
            with self._mu:
                self._running.pop(op_id, None)
            if holds_slot:
                self._slots.release()
            done.set()

    @staticmethod
    def _interrupted_message(kind: str, detail: str = "") -> str:
        msg = ("The worker running this operation stopped before it finished. Nothing was retried automatically. "
               "Some resources may have been changed: run a new plan for this deployment to see what is left to do.")
        if kind != "apply":
            msg = "The operation was interrupted and could not be retried. Start it again."
        return msg + (f"\n{detail[-1500:]}" if detail else "")

    def _finish(self, doc: dict, status: str, result: Any, error: str | None) -> None:
        op_id = doc["operation_id"]

        def mutate(current):
            if current.get("owner") != self.owner or current["status"] != "running":
                raise Conflict("no longer the owner")
            current.update(status=status, result=result, error=error, owner=None, lease_expires_at=None, progress=None)
            if status in TERMINAL:
                current["finished_at"] = self.clock()
            else:
                current["queued_at"] = self.clock()
            return current
        try:
            final = self.store.update_json(f"ops/{op_id}.json", mutate)
        except (Conflict, NotFound):
            return   # recovered by another replica while we were finishing; its verdict stands
        if status in TERMINAL:
            # Only the owner that wrote the terminal state gets here. The release is conditional on the
            # lock still pointing at this operation, so a lock taken over meanwhile is left alone.
            self._release_lock(doc.get("lock"), op_id)
            self.store.delete(f"ops-active/{op_id}")
        self.log({"type": "operation", "operation_id": op_id, "kind": doc["kind"], "status": status,
                  "environment": doc.get("environment"), "deployment": doc.get("deployment"),
                  "user": (doc.get("actor") or {}).get("name"), "attempts": final.get("attempts"),
                  "duration_s": round(self.clock() - (doc.get("started_at") or self.clock()), 1)})

    # ------------------------------------------------------------------ recovery / adoption
    def tick(self) -> dict:
        """Adopt queued operations and recover operations whose worker died. Safe to call from any replica."""
        stats = {"adopted": 0, "requeued": 0, "interrupted": 0, "cleaned": 0}
        now = self.clock()
        for marker in self.store.list("ops-active/"):
            op_id = marker.rsplit("/", 1)[-1]
            key = f"ops/{op_id}.json"
            try:
                doc, etag = self.store.get_json_etag(key)
            except NotFound:
                self.store.delete(marker)
                stats["cleaned"] += 1
                continue
            if doc["status"] in TERMINAL:
                self._release_lock(doc.get("lock"), op_id)
                self.store.delete(marker)
                stats["cleaned"] += 1
            elif doc["kind"] not in self._handlers or doc["kind"] in self._inline_only:
                continue        # another process type owns this kind (e.g. applies belong to the executor)
            elif doc["status"] == "running" and (doc.get("lease_expires_at") or 0) < now:
                retryable = self._handlers.get(doc["kind"], (None, False))[1]
                requeue = retryable and doc.get("attempts", 0) < self.max_attempts
                dead_owner = doc.get("owner")
                if requeue:
                    doc.update(status="queued", owner=None, lease_expires_at=None, queued_at=now,
                               progress="re-queued after its worker stopped")
                else:
                    doc.update(status="interrupted", owner=None, lease_expires_at=None, finished_at=now, progress=None,
                               error=self._interrupted_message(doc["kind"]))
                try:
                    self.store.put_json(key, doc, if_match=etag)
                except Conflict:
                    continue   # heartbeat arrived after all, or another replica recovered it
                broke = False
                if doc.get("state_key") and self.state_store is not None:
                    broke = self.state_store.break_lease(doc["state_key"])
                if not requeue:
                    self._release_lock(doc.get("lock"), op_id)
                    self.store.delete(marker)
                stats["requeued" if requeue else "interrupted"] += 1
                self.log({"type": "operation_recovered", "operation_id": op_id, "kind": doc["kind"],
                          "action": "requeued" if requeue else "interrupted", "dead_owner": dead_owner,
                          "state_lease_broken": broke, "environment": doc.get("environment"),
                          "deployment": doc.get("deployment")})
            if doc["status"] == "queued" and now - (doc.get("queued_at") or 0) >= 2:
                with self._mu:
                    mine = op_id in self._running
                if not mine and self._start_local(op_id) is not None:
                    stats["adopted"] += 1
        return stats

    def start(self, poll_seconds: float = 10.0) -> None:
        def loop():
            while not self._stop.wait(poll_seconds):
                try:
                    self.tick()
                except Exception as e:  # noqa: BLE001
                    self.log({"type": "engine_error", "error": str(e)})
        self._poller = threading.Thread(target=loop, name="op-poller", daemon=True)
        self._poller.start()

    def shutdown(self, grace_seconds: float = 100.0) -> None:
        """Stop adopting work and interrupt running operations (Terraform gets SIGINT)."""
        self._stop.set()
        with self._mu:
            running = list(self._running.values())
        for cancel, _ in running:
            cancel.set()
        deadline = time.monotonic() + grace_seconds
        for _, done in running:
            done.wait(max(0.0, deadline - time.monotonic()))

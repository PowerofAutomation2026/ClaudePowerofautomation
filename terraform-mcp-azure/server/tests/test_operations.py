import threading
import time

import pytest

from conftest import Clock
from tfmcp.operations import Busy, OperationEngine, OperationFailed
from tfmcp.storage import Conflict, MemoryStore, NotFound
from tfmcp.terraform import Cancelled

ACTOR = {"oid": "o1", "name": "alice"}


def engine(store, clock, owner, state=None, **kw):
    e = OperationEngine(store, state_store=state, clock=clock, owner=owner, lease_seconds=120, heartbeat_seconds=3600,
                        max_workers=kw.pop("max_workers", 2), **kw)
    return e


def wait_for(predicate, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_memory_store_conditional_writes():
    s = MemoryStore()
    etag = s.put("a", b"1", if_none_match=True)
    with pytest.raises(Conflict):
        s.put("a", b"2", if_none_match=True)
    with pytest.raises(Conflict):
        s.put("a", b"2", if_match='"nope"')
    s.put("a", b"2", if_match=etag)
    assert s.get("a")[0] == b"2" and s.list("") == ["a"]
    with pytest.raises(NotFound):
        s.get("missing")
    s.put_json("doc", {"n": 0})
    assert s.update_json("doc", lambda d: {"n": d["n"] + 1}) == {"n": 1}


def test_fast_operation_returns_result_inline_and_is_persisted():
    store, clock = MemoryStore(), Clock()
    e = engine(store, clock, "a")
    e.register("plan", lambda op, ctx: {"echo": op["params"]["x"]}, retryable=True)
    op = e.submit("plan", {"x": 7}, actor=ACTOR, environment="dev", deployment="demo", lock="dev/demo", wait=5)
    assert op["status"] == "succeeded" and op["result"] == {"echo": 7} and op["requested_by"] == "alice"
    # any other replica can answer get_operation: nothing lives only in memory
    other = engine(store, clock, "b")
    assert other.get(op["operation_id"])["result"] == {"echo": 7}
    assert store.list("locks/") == [] and store.list("ops-active/") == []


def test_slow_operation_returns_quickly_with_operation_id_and_can_be_polled():
    store, clock = MemoryStore(), Clock()
    release = threading.Event()
    e = engine(store, clock, "a")
    e.register("apply", lambda op, ctx: release.wait(5) and "done", retryable=False)
    t0 = time.time()
    op = e.submit("apply", {}, actor=ACTOR, lock="dev/demo", wait=0.1)
    assert time.time() - t0 < 2 and op["status"] in ("queued", "running") and "get_operation" in op["next"]
    release.set()
    assert wait_for(lambda: e.get(op["operation_id"])["status"] == "succeeded")
    assert e.get(op["operation_id"])["result"] == "done"


def test_one_operation_per_deployment():
    store, clock = MemoryStore(), Clock()
    release = threading.Event()
    e = engine(store, clock, "a")
    e.register("apply", lambda op, ctx: release.wait(5), retryable=False)
    first = e.submit("apply", {}, actor=ACTOR, lock="dev/demo")
    with pytest.raises(Busy, match=first["operation_id"]):
        e.submit("apply", {}, actor=ACTOR, lock="dev/demo")
    assert len(store.list("ops/")) == 1                      # the refused operation left nothing behind
    assert len(store.list("ops-active/")) == 1
    e.submit("apply", {}, actor=ACTOR, lock="dev/other")     # a different deployment is independent
    release.set()
    assert wait_for(lambda: store.list("locks/") == [])
    assert e.submit("apply", {}, actor=ACTOR, lock="dev/demo", wait=5)["status"] == "succeeded"


def test_failures_are_reported_and_release_the_lock():
    store, clock = MemoryStore(), Clock()
    e = engine(store, clock, "a")

    def boom(op, ctx):
        raise OperationFailed("terraform plan failed:\nError: quota exceeded")

    def crash(op, ctx):
        raise ZeroDivisionError("bug")
    e.register("plan", boom, retryable=True)
    e.register("drift", crash, retryable=True)
    op = e.submit("plan", {}, actor=ACTOR, lock="dev/demo", wait=5)
    assert op["status"] == "failed" and "quota exceeded" in op["error"]
    op2 = e.submit("drift", {}, actor=ACTOR, lock="dev/demo", wait=5)     # lock was released
    assert op2["status"] == "failed" and "ZeroDivisionError" in op2["error"]


def test_two_replicas_cannot_both_run_the_same_operation():
    store, clock = MemoryStore(), Clock()
    runs = []
    a, b = engine(store, clock, "a", max_workers=0), engine(store, clock, "b")
    for e in (a, b):
        e.register("plan", lambda op, ctx, e=e: runs.append(e.owner) or "ok", retryable=True)
    op = a.submit("plan", {}, actor=ACTOR, lock="dev/demo")      # replica A has no free worker: stays queued
    assert op["status"] == "queued"
    clock.advance(5)
    threads = [threading.Thread(target=b._execute, args=(op["operation_id"], threading.Event(), threading.Event())) for _ in range(5)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert runs == ["b"]                                         # claimed exactly once (compare-and-swap)
    assert a.get(op["operation_id"])["status"] == "succeeded"


def test_queued_operation_is_adopted_by_another_replica():
    store, clock = MemoryStore(), Clock()
    a, b = engine(store, clock, "a", max_workers=0), engine(store, clock, "b")
    for e in (a, b):
        e.register("plan", lambda op, ctx: "ok", retryable=True)
    op = a.submit("plan", {}, actor=ACTOR, lock="dev/demo")
    assert b.tick()["adopted"] == 0                              # too fresh: give the submitting replica a moment
    clock.advance(3)
    assert b.tick()["adopted"] == 1
    assert wait_for(lambda: b.get(op["operation_id"])["status"] == "succeeded")


def dead_worker_scenario(kind, retryable):
    """Replica A starts an operation and 'dies' (its thread hangs forever, no heartbeat)."""
    store, state, clock = MemoryStore(), MemoryStore(), Clock()
    hang, entered = threading.Event(), threading.Event()
    a = engine(store, clock, "a", state)

    def stuck(op, ctx):
        entered.set()
        hang.wait(30)
        return "zombie result"
    a.register(kind, stuck, retryable=retryable)
    op = a.submit(kind, {}, actor=ACTOR, environment="dev", deployment="demo", lock="dev/demo", state_key="dev/demo.tfstate")
    assert entered.wait(5)
    return store, state, clock, a, hang, op["operation_id"]


def test_dead_worker_plan_is_requeued_and_finished_by_another_replica():
    store, state, clock, a, hang, op_id = dead_worker_scenario("plan", True)
    b = engine(store, clock, "b", state)
    b.register("plan", lambda op, ctx: "recovered result", retryable=True)
    assert b.tick() == {"adopted": 0, "requeued": 0, "interrupted": 0, "cleaned": 0}    # lease still valid
    clock.advance(121)                                                                    # lease expired: worker is dead
    assert b.tick()["requeued"] == 1
    assert state.broken_leases == ["dev/demo.tfstate"]            # Terraform's orphaned state lock is cleared
    clock.advance(3)
    assert b.tick()["adopted"] == 1
    assert wait_for(lambda: b.get(op_id)["status"] == "succeeded")
    final = b.get(op_id)
    assert final["result"] == "recovered result" and final["attempts"] == 2
    hang.set()                                                    # the zombie wakes up: its result must be ignored
    time.sleep(0.2)
    assert b.get(op_id)["result"] == "recovered result"


def test_dead_worker_apply_is_never_retried():
    store, state, clock, a, hang, op_id = dead_worker_scenario("apply", False)
    b = engine(store, clock, "b", state)
    ran = []
    b.register("apply", lambda op, ctx: ran.append(1), retryable=False)
    clock.advance(121)
    assert b.tick()["interrupted"] == 1
    op = b.get(op_id)
    assert op["status"] == "interrupted" and "Nothing was retried automatically" in op["error"] and not ran
    assert state.broken_leases == ["dev/demo.tfstate"]
    assert store.list("locks/") == [] and store.list("ops-active/") == []   # deployment is usable again
    assert b.submit("apply", {}, actor=ACTOR, lock="dev/demo", wait=5)["status"] == "succeeded"
    hang.set()
    time.sleep(0.2)
    assert b.get(op_id)["status"] == "interrupted"                # zombie cannot overwrite the verdict


def test_plan_retry_limit():
    store, clock = MemoryStore(), Clock()
    b = engine(store, clock, "b", max_attempts=2)
    b.register("plan", lambda op, ctx: "x", retryable=True)
    store.put_json("ops/aaaaaaaaaaaa.json", {"operation_id": "aaaaaaaaaaaa", "kind": "plan", "status": "running", "owner": "dead",
                                             "lease_expires_at": clock() - 1, "attempts": 2, "lock": None, "state_key": None,
                                             "actor": ACTOR, "params": {}})
    store.put_json("ops-active/aaaaaaaaaaaa", {})
    assert b.tick()["interrupted"] == 1 and b.get("aaaaaaaaaaaa")["status"] == "interrupted"


def test_heartbeat_extends_lease_and_detects_takeover():
    store, clock = MemoryStore(), Clock()
    e = OperationEngine(store, clock=clock, owner="a", lease_seconds=120, heartbeat_seconds=0.02)
    cancelled = threading.Event()
    go = threading.Event()

    def work(op, ctx):
        go.wait(5)
        if ctx.cancel.wait(3):
            cancelled.set()
            raise Cancelled("lost lease")
        return "finished"
    e.register("apply", work, retryable=False)
    op = e.submit("apply", {}, actor=ACTOR, lock="dev/demo")
    key = f"ops/{op['operation_id']}.json"
    clock.advance(60)
    assert wait_for(lambda: store.get_json(key).get("lease_expires_at", 0) >= clock() + 119)   # heartbeat renewed the lease
    # another replica takes the operation over (as recovery would): the worker must notice and stop
    store.update_json(key, lambda d: {**d, "owner": "b"})
    go.set()
    assert cancelled.wait(5)
    assert wait_for(lambda: op["operation_id"] not in e._running)
    assert store.get_json(key)["owner"] == "b" and store.get_json(key)["status"] == "running"   # not overwritten by the loser


def test_shutdown_cancels_and_requeues_plans_but_marks_apply_interrupted():
    store, clock = MemoryStore(), Clock()
    e = engine(store, clock, "a")

    def work(op, ctx):
        if ctx.cancel.wait(5):
            raise Cancelled("SIGINT sent to terraform")
        return "x"
    e.register("plan", work, retryable=True)
    e.register("apply", work, retryable=False)
    p = e.submit("plan", {}, actor=ACTOR, lock="dev/one")
    a = e.submit("apply", {}, actor=ACTOR, lock="dev/two")
    assert wait_for(lambda: e.get(a["operation_id"])["status"] == "running" and e.get(p["operation_id"])["status"] == "running")
    e.shutdown(grace_seconds=5)
    assert e.get(p["operation_id"])["status"] == "queued"            # another replica will pick it up
    assert store.list("locks/") == ["locks/dev/one.json"]            # ...and it keeps its lock meanwhile
    interrupted = e.get(a["operation_id"])
    assert interrupted["status"] == "interrupted" and "SIGINT" in interrupted["error"]
    assert e.submit("plan", {}, actor=ACTOR, lock="dev/three")["status"] == "queued"   # a stopping replica starts nothing


def test_stale_lock_from_a_vanished_operation_is_taken_over():
    store, clock = MemoryStore(), Clock()
    e = engine(store, clock, "a")
    e.register("plan", lambda op, ctx: "ok", retryable=True)
    store.put_json("locks/dev/demo.json", {"operation_id": "gone00000000"})
    assert e.submit("plan", {}, actor=ACTOR, lock="dev/demo", wait=5)["status"] == "succeeded"


def test_inline_mode_runs_on_the_calling_thread():
    store, clock = MemoryStore(), Clock()
    e = engine(store, clock, "job")
    seen = []
    e.register("plan", lambda op, ctx: seen.append(threading.current_thread().name) or "ok", retryable=True)
    op = e.submit("plan", {}, actor=ACTOR, lock="dev/demo", inline=True)
    assert op["status"] == "succeeded" and seen == [threading.current_thread().name]
    with pytest.raises(ValueError):
        e.submit("nope", {}, actor=ACTOR)
    with pytest.raises(NotFound):
        e.get("ffffffffffff")


def test_zombie_worker_cannot_release_the_lock_of_the_recovered_run():
    store, state, clock, a, hang, op_id = dead_worker_scenario("plan", True)
    b = engine(store, clock, "b", state)
    b_release, b_entered = threading.Event(), threading.Event()
    b.register("plan", lambda op, ctx: (b_entered.set(), b_release.wait(5), "from b")[2], retryable=True)
    clock.advance(121)
    b.tick()
    clock.advance(3)
    b.tick()
    assert b_entered.wait(5)
    hang.set()                                   # zombie on replica A finishes while B is still working
    assert wait_for(lambda: op_id not in a._running)
    assert store.list("locks/") == ["locks/dev/demo.json"]     # B's lock is untouched
    with pytest.raises(Busy):
        b.submit("plan", {}, actor=ACTOR, lock="dev/demo")
    b_release.set()
    assert wait_for(lambda: b.get(op_id)["status"] == "succeeded") and b.get(op_id)["result"] == "from b"


def test_operation_submitted_by_a_replica_that_died_before_locking_is_still_run():
    """Crash window: the record and marker exist, the lock was never written, nobody is running it."""
    store, clock = MemoryStore(), Clock()
    b = engine(store, clock, "b")
    b.register("plan", lambda op, ctx: "ok", retryable=True)
    store.put_json("ops/aaaaaaaaaaaa.json", {"operation_id": "aaaaaaaaaaaa", "kind": "plan", "status": "queued", "owner": None,
                                             "queued_at": clock() - 60, "attempts": 0, "lock": "dev/demo", "state_key": None,
                                             "actor": ACTOR, "params": {}, "created_at": clock() - 60})
    store.put_json("ops-active/aaaaaaaaaaaa", {})
    assert b.tick()["adopted"] == 1
    assert wait_for(lambda: b.get("aaaaaaaaaaaa")["status"] == "succeeded")
    assert store.list("ops-active/") == []

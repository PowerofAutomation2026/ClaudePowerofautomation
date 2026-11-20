"""Opt-in: runs BlobStore against the Azurite storage emulator to prove the conditional-write and
lease semantics the operation engine relies on. Skipped unless AZURITE_CONNECTION_STRING is set.
ci/run-azurite-tests.sh starts Azurite with a throw-away random account key and runs this file."""
import os
import threading
import uuid

import pytest

from tfmcp.operations import OperationEngine
from tfmcp.storage import BlobStore, Conflict, NotFound

CONN = os.environ.get("AZURITE_CONNECTION_STRING", "")
pytestmark = pytest.mark.skipif(not CONN, reason="set AZURITE_CONNECTION_STRING (see ci/run-azurite-tests.sh)")


@pytest.fixture
def store():
    return BlobStore.from_connection_string(CONN, "t" + uuid.uuid4().hex[:20], create=True)


def test_conditional_writes_and_deletes(store):
    etag = store.put("a/doc.json", b"1", if_none_match=True)
    with pytest.raises(Conflict):
        store.put("a/doc.json", b"2", if_none_match=True)
    with pytest.raises(Conflict):
        store.put("a/doc.json", b"2", if_match='"0x0000000000000000"')
    etag2 = store.put("a/doc.json", b"2", if_match=etag)
    assert etag2 != etag and store.get("a/doc.json") == (b"2", etag2)
    with pytest.raises(Conflict):
        store.delete("a/doc.json", if_match=etag)
    store.delete("a/doc.json", if_match=etag2)
    store.delete("a/doc.json")                       # deleting a missing key is fine
    with pytest.raises(NotFound):
        store.get("a/doc.json")
    store.put_json("b/1.json", {"n": 1})
    store.put_json("b/2.json", {"n": 2})
    store.put_json("c/3.json", {"n": 3})
    assert store.list("b/") == ["b/1.json", "b/2.json"] and len(store.list()) == 3
    assert store.update_json("b/1.json", lambda d: {"n": d["n"] + 1}) == {"n": 2}


def test_break_lease_clears_a_terraform_style_state_lock(store):
    from azure.storage.blob import BlobLeaseClient

    store.put("dev/demo.tfstate", b"{}")
    blob = store._c.get_blob_client("dev/demo.tfstate")
    BlobLeaseClient(blob).acquire(lease_duration=-1)                 # infinite lease, as the azurerm backend takes
    with pytest.raises(Exception):
        blob.upload_blob(b"{}", overwrite=True)                      # locked
    assert store.break_lease("dev/demo.tfstate") is True
    blob.upload_blob(b'{"ok":1}', overwrite=True)
    assert store.break_lease("dev/demo.tfstate") is False            # nothing to break any more
    assert store.break_lease("dev/missing.tfstate") is False


def test_only_one_of_many_racing_workers_claims_an_operation(store):
    runs = []
    engines = [OperationEngine(store, owner=f"w{i}", max_workers=0 if i == 0 else 1) for i in range(6)]
    for e in engines:
        e.register("plan", lambda op, ctx, e=e: runs.append(e.owner) or "ok", retryable=True)
    op = engines[0].submit("plan", {}, actor={"oid": "o", "name": "n"}, lock="dev/demo")
    threads = [threading.Thread(target=e._execute, args=(op["operation_id"], threading.Event(), threading.Event())) for e in engines[1:]]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(runs) == 1 and engines[0].get(op["operation_id"])["status"] == "succeeded"
    assert store.list("locks/") == [] and store.list("ops-active/") == []

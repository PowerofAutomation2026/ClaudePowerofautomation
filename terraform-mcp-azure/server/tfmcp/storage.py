"""Small key/value store abstraction with optimistic concurrency (ETags).

Everything the server must remember (operations, locks, plans, approvals, deployment records,
audit entries) goes through this interface, so no state lives only in one replica's memory.

* ``BlobStore``   - Azure Blob Storage container (production).
* ``MemoryStore`` - in-process dict with the same semantics (unit tests, local smoke runs).
"""
from __future__ import annotations

import itertools
import json
import threading
from typing import Any, Iterable


class NotFound(KeyError):
    """The key does not exist."""


class Conflict(RuntimeError):
    """A conditional write lost the race (ETag mismatch, or the key already exists)."""


class Store:
    """Interface. ``put`` returns the new ETag; ``get`` returns ``(bytes, etag)``."""

    def get(self, key: str) -> tuple[bytes, str]:
        raise NotImplementedError

    def put(self, key: str, data: bytes, *, if_match: str | None = None, if_none_match: bool = False) -> str:
        raise NotImplementedError

    def delete(self, key: str, *, if_match: str | None = None) -> None:
        """Delete ``key`` (a missing key is not an error). With ``if_match`` the delete only happens
        if the ETag still matches, otherwise ``Conflict`` is raised."""
        raise NotImplementedError

    def list(self, prefix: str = "") -> list[str]:
        raise NotImplementedError

    def break_lease(self, key: str) -> bool:
        """Break a blob lease (used to clear a Terraform state lock left by a dead process)."""
        return False

    # ---- JSON helpers -------------------------------------------------------
    def exists(self, key: str) -> bool:
        try:
            self.get(key)
            return True
        except NotFound:
            return False

    def get_json(self, key: str) -> Any:
        return json.loads(self.get(key)[0])

    def get_json_etag(self, key: str) -> tuple[Any, str]:
        data, etag = self.get(key)
        return json.loads(data), etag

    def put_json(self, key: str, value: Any, **conditions) -> str:
        return self.put(key, json.dumps(value, sort_keys=True, default=str).encode(), **conditions)

    def update_json(self, key: str, mutate, *, attempts: int = 8) -> Any:
        """Read-modify-write with ETag retry. ``mutate(doc)`` returns the new document.
        Raising inside ``mutate`` aborts the update."""
        for _ in range(attempts):
            doc, etag = self.get_json_etag(key)
            new = mutate(doc)
            try:
                self.put_json(key, new, if_match=etag)
                return new
            except Conflict:
                continue
        raise Conflict(f"could not update {key}: too much contention")


class MemoryStore(Store):
    def __init__(self) -> None:
        self._data: dict[str, tuple[bytes, str]] = {}
        self._lock = threading.RLock()
        self._seq = itertools.count(1)
        self.broken_leases: list[str] = []

    def get(self, key):
        with self._lock:
            if key not in self._data:
                raise NotFound(key)
            return self._data[key]

    def put(self, key, data, *, if_match=None, if_none_match=False):
        if isinstance(data, str):
            data = data.encode()
        with self._lock:
            current = self._data.get(key)
            if if_none_match and current is not None:
                raise Conflict(f"{key} already exists")
            if if_match is not None and (current is None or current[1] != if_match):
                raise Conflict(f"{key} was modified")
            etag = f'"{next(self._seq)}"'
            self._data[key] = (bytes(data), etag)
            return etag

    def delete(self, key, *, if_match=None):
        with self._lock:
            current = self._data.get(key)
            if if_match is not None and current is not None and current[1] != if_match:
                raise Conflict(f"{key} was modified")
            self._data.pop(key, None)

    def list(self, prefix=""):
        with self._lock:
            return sorted(k for k in self._data if k.startswith(prefix))

    def break_lease(self, key):
        self.broken_leases.append(key)
        return True


class BlobStore(Store):
    """Azure Blob container. Conditional writes map to ``If-Match`` / ``If-None-Match: *``."""

    def __init__(self, container_client) -> None:
        self._c = container_client

    @classmethod
    def from_account(cls, account: str, container: str, credential) -> "BlobStore":
        from azure.storage.blob import BlobServiceClient

        svc = BlobServiceClient(f"https://{account}.blob.core.windows.net", credential=credential)
        return cls(svc.get_container_client(container))

    @classmethod
    def from_connection_string(cls, conn: str, container: str, create: bool = False) -> "BlobStore":
        from azure.core.exceptions import ResourceExistsError
        from azure.storage.blob import BlobServiceClient

        client = BlobServiceClient.from_connection_string(conn).get_container_client(container)
        if create:
            try:
                client.create_container()
            except ResourceExistsError:
                pass
        return cls(client)

    def get(self, key):
        from azure.core.exceptions import ResourceNotFoundError

        try:
            dl = self._c.download_blob(key)
            return dl.readall(), dl.properties.etag
        except ResourceNotFoundError as e:
            raise NotFound(key) from e

    def put(self, key, data, *, if_match=None, if_none_match=False):
        from azure.core import MatchConditions
        from azure.core.exceptions import ResourceExistsError, ResourceModifiedError

        if isinstance(data, str):
            data = data.encode()
        kwargs: dict[str, Any] = {"overwrite": True}
        if if_none_match:
            kwargs = {"overwrite": False}
        elif if_match is not None:
            kwargs.update(etag=if_match, match_condition=MatchConditions.IfNotModified)
        try:
            return self._c.get_blob_client(key).upload_blob(data, **kwargs)["etag"]
        except (ResourceExistsError, ResourceModifiedError) as e:
            raise Conflict(key) from e

    def delete(self, key, *, if_match=None):
        from azure.core import MatchConditions
        from azure.core.exceptions import ResourceModifiedError, ResourceNotFoundError

        kwargs = {} if if_match is None else {"etag": if_match, "match_condition": MatchConditions.IfNotModified}
        try:
            self._c.get_blob_client(key).delete_blob(**kwargs)
        except ResourceNotFoundError:
            pass
        except ResourceModifiedError as e:
            raise Conflict(key) from e

    def list(self, prefix=""):
        return sorted(self._c.list_blob_names(name_starts_with=prefix or None))

    def break_lease(self, key):
        from azure.core.exceptions import HttpResponseError
        from azure.storage.blob import BlobLeaseClient

        try:
            BlobLeaseClient(self._c.get_blob_client(key)).break_lease(lease_break_period=0)
            return True
        except HttpResponseError:
            return False  # no blob, or no lease present: nothing to break


def iter_json(store: Store, prefix: str) -> Iterable[tuple[str, Any]]:
    for key in store.list(prefix):
        try:
            yield key, store.get_json(key)
        except (NotFound, ValueError):
            continue

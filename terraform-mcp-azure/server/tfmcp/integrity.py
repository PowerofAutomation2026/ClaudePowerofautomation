"""Integrity manifest for the files that decide what can be deployed: templates and policies.

``integrity.json`` (next to server.py) lists the SHA-256 of every file under ``templates/`` and
``policies/``. The image build verifies it and the server verifies it again at start-up and refuses
to run on any difference (changed, missing or extra file). Update it deliberately after a reviewed
change:  ``python -m tfmcp.integrity write``."""
from __future__ import annotations

import hashlib
import json
import pathlib
import sys

DIRS = ("templates", "policies")
MANIFEST = "integrity.json"


class IntegrityError(RuntimeError):
    pass


def compute(root: pathlib.Path) -> dict[str, str]:
    out = {}
    for d in DIRS:
        for f in sorted((root / d).rglob("*")):
            if f.is_file() and "__pycache__" not in f.parts and not f.name.startswith(".terraform"):
                out[f.relative_to(root).as_posix()] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


def write(root: pathlib.Path) -> int:
    files = compute(root)
    (root / MANIFEST).write_text(json.dumps({"version": 1, "files": files}, indent=1, sort_keys=True) + "\n")
    return len(files)


def verify(root: pathlib.Path) -> None:
    try:
        expected = json.loads((root / MANIFEST).read_text())["files"]
    except (OSError, ValueError, KeyError) as e:
        raise IntegrityError(f"integrity manifest {MANIFEST} is missing or unreadable: {e}") from e
    actual = compute(root)
    problems = [f"changed: {k}" for k in expected if k in actual and actual[k] != expected[k]]
    problems += [f"missing: {k}" for k in expected if k not in actual]
    problems += [f"not in manifest: {k}" for k in actual if k not in expected]
    if problems:
        raise IntegrityError("templates/policies do not match integrity.json (" + "; ".join(problems[:8]) +
                             "). Refusing to start. If the change is intended and reviewed: python -m tfmcp.integrity write")


if __name__ == "__main__":
    here = pathlib.Path(__file__).resolve().parent.parent
    if sys.argv[1:] == ["write"]:
        print(f"wrote {MANIFEST} with {write(here)} files")
    else:
        verify(here)
        print("integrity OK")

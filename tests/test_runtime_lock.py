"""The packaged copy must stay byte-identical to the checked-in lock."""

import hashlib
from pathlib import Path

from dswhale import runtime_lock

ROOT = Path(__file__).resolve().parents[1]


def test_packaged_copy_matches_root_lock():
    root = ROOT / "runtime-lock.json"
    bundled = ROOT / "dswhale" / "runtime-lock.json"
    assert root.read_bytes() == bundled.read_bytes()
    assert (
        hashlib.sha256(root.read_bytes()).digest() == hashlib.sha256(bundled.read_bytes()).digest()
    )


def test_default_path_prefers_checkout_then_bundled(tmp_path):
    assert runtime_lock.default_path() == ROOT / "runtime-lock.json"
    assert runtime_lock.default_path(tmp_path) == tmp_path / "runtime-lock.json"


def test_lock_and_dependency_constraints_agree():
    import tomllib

    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    locked = runtime_lock.load()["runtime"]["astrbot"]
    for group in ("host", "dev"):
        pin = next(
            requirement
            for requirement in project["project"]["optional-dependencies"][group]
            if requirement.startswith("astrbot==")
        )
        assert pin == f"astrbot=={locked}"
    runtime_source = (ROOT / "desktop/lib/runtime.cjs").read_text(encoding="utf-8")
    assert "runtimeLockModule.KEY" in runtime_source
    assert "lock?.runtime" in runtime_source

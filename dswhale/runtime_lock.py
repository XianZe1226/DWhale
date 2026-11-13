"""One version-lock source for the managed AstrBot core and desktop tools.

The desktop updater, bootstrap, install doctor and console cache key all read
this file instead of repeating version constants. It ships next to the Python
plugin so the packaged backend and the source checkout behave identically.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

LOCK_NAME = "runtime-lock.json"
MATRIX_KEYS = ("astrbot", "python", "node", "ffmpeg")
_TOP_KEYS = {"format", "product", "verifiedAt", "source", "runtime", "legacy"}
_VERSION = re.compile(r"^[0-9][0-9A-Za-z.+_-]{0,119}$")
_ASTRBOT = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")


class RuntimeLockError(ValueError):
    """The bundled runtime lock is missing or malformed."""


def default_path(root: str | Path | None = None) -> Path:
    if root is not None:
        return Path(root) / LOCK_NAME
    checkout = Path(__file__).resolve().parents[1] / LOCK_NAME
    if checkout.is_file():
        return checkout
    return Path(__file__).with_name(LOCK_NAME)


def _matrix(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != set(MATRIX_KEYS):
        raise RuntimeLockError("runtime lock matrix keys are invalid")
    matrix = {}
    for key in MATRIX_KEYS:
        item = value.get(key)
        if not isinstance(item, str) or not _VERSION.fullmatch(item):
            raise RuntimeLockError("runtime lock matrix values are invalid")
        matrix[key] = item
    if not _ASTRBOT.fullmatch(matrix["astrbot"]):
        raise RuntimeLockError("runtime lock AstrBot version is invalid")
    return matrix


def validate(data: object) -> dict:
    if not isinstance(data, dict) or set(data) != _TOP_KEYS:
        raise RuntimeLockError("runtime lock fields are invalid")
    if data.get("format") != 1 or data.get("product") != "DWhale":
        raise RuntimeLockError("runtime lock identity is invalid")
    for key in ("verifiedAt", "source"):
        if not isinstance(data.get(key), str) or not data[key]:
            raise RuntimeLockError("runtime lock metadata is invalid")
    if not str(data["source"]).startswith("https://"):
        raise RuntimeLockError("runtime lock source must be HTTPS")
    runtime = _matrix(data.get("runtime"))
    legacy = _matrix(data.get("legacy"))
    return {
        "format": 1,
        "product": "DWhale",
        "verifiedAt": data["verifiedAt"],
        "source": data["source"],
        "runtime": runtime,
        "legacy": legacy,
    }


def load(root: str | Path | None = None) -> dict:
    path = default_path(root)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeLockError("runtime lock is unreadable") from error
    return validate(value)


def runtime_matrix(root: str | Path | None = None) -> dict[str, str]:
    return load(root)["runtime"]


def legacy_matrix(root: str | Path | None = None) -> dict[str, str]:
    return load(root)["legacy"]


def astrbot_version(root: str | Path | None = None) -> str:
    return runtime_matrix(root)["astrbot"]


def digest(root: str | Path | None = None) -> str:
    """SHA-256 of the exact lock bytes used by release manifests."""
    import hashlib

    return hashlib.sha256(default_path(root).read_bytes()).hexdigest()

"""Observe the official stable AstrBot package and compare it with the lock.

This is the release/build-time half of the core policy: a candidate must know
whether the pinned AstrBot is still the latest installable stable release.
Offline builds keep the locked version and report the condition instead of
pretending it is current; a newer stable makes a release build fail unless a
maintainer explicitly overrides it after validating the SDK.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PYPI_JSON = "https://pypi.org/pypi/astrbot/json"
STABLE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
PRERELEASE = re.compile(r"(?:a|b|rc|alpha|beta|dev)", re.IGNORECASE)
INSTALLABLE = {"bdist_wheel", "sdist"}


class UpstreamError(ValueError):
    """The upstream observation or the local lock is malformed."""


def parse_stable(value: str):
    match = STABLE.fullmatch(value)
    return tuple(int(part) for part in match.groups()) if match else None


def load_lock(path: Path) -> tuple[dict, str]:
    try:
        raw = path.read_bytes()
        value = json.loads(raw)
    except (OSError, ValueError) as error:
        raise UpstreamError("runtime lock is unreadable") from error
    runtime = value.get("runtime") if isinstance(value, dict) else None
    locked = runtime.get("astrbot") if isinstance(runtime, dict) else None
    if not isinstance(locked, str) or not parse_stable(locked):
        raise UpstreamError("runtime lock does not pin a stable AstrBot version")
    if not isinstance(value.get("source"), str) or not value["source"].startswith(
        "https://pypi.org/"
    ):
        raise UpstreamError("runtime lock source is not the official PyPI project")
    return value, locked


def read_json(url: str, timeout: float) -> dict:
    request = urllib.request.Request(
        url, headers={"User-Agent": "DWhale-release-check", "Accept": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise UpstreamError(f"PyPI returned HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def stable_releases(payload: dict) -> tuple[list[str], str]:
    releases = payload.get("releases")
    info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
    latest_any = info.get("version") if isinstance(info.get("version"), str) else ""
    if not isinstance(releases, dict):
        raise UpstreamError("PyPI metadata has no releases")
    stable = []
    for version, files in releases.items():
        if not isinstance(version, str) or not parse_stable(version) or PRERELEASE.search(version):
            continue
        if not isinstance(files, list):
            continue
        installable = [
            item
            for item in files
            if isinstance(item, dict)
            and item.get("packagetype") in INSTALLABLE
            and item.get("url")
            and not item.get("yanked", False)
        ]
        if installable:
            stable.append(version)
    stable.sort(key=parse_stable)
    return stable, latest_any


def observe(
    lock_path: Path, *, url: str = PYPI_JSON, timeout: float = 10.0, fetch=read_json
) -> dict:
    _, locked = load_lock(lock_path)
    checked_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        payload = fetch(url, timeout)
        stable, latest_any = stable_releases(payload)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        return {
            "status": "offline",
            "locked": locked,
            "latestStable": None,
            "latestAny": None,
            "checkedAt": checked_at,
            "source": url,
            "detail": f"upstream not reachable: {type(error).__name__}",
        }
    if not stable:
        return {
            "status": "no-stable",
            "locked": locked,
            "latestStable": None,
            "latestAny": latest_any or None,
            "checkedAt": checked_at,
            "source": url,
            "detail": "no installable stable AstrBot release was published",
        }
    latest = stable[-1]
    if latest == locked:
        status = "current"
    elif parse_stable(latest) > parse_stable(locked):
        status = "newer"
    else:
        status = "behind"
    return {
        "status": status,
        "locked": locked,
        "latestStable": latest,
        "latestAny": latest_any or None,
        "checkedAt": checked_at,
        "source": url,
        "detail": "pinned core matches the latest installable stable release"
        if status == "current"
        else "pinned core is not the latest installable stable release",
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Compare runtime-lock AstrBot with official PyPI stable releases"
    )
    parser.add_argument(
        "--lock", default=str(Path(__file__).resolve().parents[1] / "runtime-lock.json")
    )
    parser.add_argument("--url", default=PYPI_JSON)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--json-out")
    parser.add_argument("--fail-on-newer", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = observe(Path(args.lock), url=args.url, timeout=args.timeout)
    except UpstreamError as error:
        print(f"Upstream core observation failed: {error}", file=sys.stderr)
        return 2
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.json_out:
        output = Path(args.json_out)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
    print(text, end="")
    if result["status"] == "newer" and args.fail_on_newer:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

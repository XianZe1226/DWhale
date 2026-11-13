"""Generate the signed-bridge transition lock from a frozen protocol-2 manifest.

The bridge installer is verified by the a14 updater, so its own bytes are bound
by the legacy signed manifest. The *full* target is bound separately here: the
transition lock pins the exact v2 manifest bytes, commit, runtime lock and each
platform installer digest. `desktop/lib/update-chain.cjs` refuses a continuation
whose downloaded bytes do not match this description.

Usage:
  python -m scripts.bridge_manifest \
    --final-manifest dist-v2/release-manifest.json \
    --bridge-version 0.4.0a0 \
    --installer-dir dist-v2 \
    --output desktop-resources/transition-lock.json

The input manifest must already be signed and published as immutable bytes; the
generator never fabricates digests. It writes deterministic JSON (sorted keys)
and verifies the referenced installers when --installer-dir is supplied.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import sys
from pathlib import Path

REPOSITORY = "XianZe1226/DWhale"
SUFFIXES = {
    "win32-x64": "Windows-x86_64-setup.exe",
    "darwin-arm64": "macOS-arm64.dmg",
    "linux-x64": "Linux-x86_64.deb",
}
VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:(a|b|rc)(0|[1-9]\d*))?")
NPM_VERSION = re.compile(
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?"
)
COMMIT = re.compile(r"[a-f0-9]{40}")
DIGEST = re.compile(r"[a-f0-9]{64}")
CHAIN_ID = re.compile(r"[a-f0-9]{32}")
ORIGIN = re.compile(r"0\.3\.0a14")
RUNTIME_KEYS = {"astrbot", "python", "node", "ffmpeg"}
TARGET_KEYS = {
    "version",
    "tag",
    "commit",
    "manifestSha256",
    "runtimeLockSha256",
    "assets",
}
ASSET_KEYS = {"name", "size", "sha256"}


class TransitionError(ValueError):
    """The bridge description cannot be generated from the supplied inputs."""


STAGES = {"a": "alpha", "b": "beta", "rc": "rc"}


def npm_for(version: str) -> str:
    match = VERSION.fullmatch(version)
    if not match:
        raise TransitionError("version is invalid")
    major, minor, patch, stage, number = match.groups()
    if stage is None:
        return version
    return f"{major}.{minor}.{patch}-{STAGES[stage]}.{number}"


def python_version(text: str) -> tuple[str, str, bool]:
    if not isinstance(text, str) or len(text) > 64 or not VERSION.fullmatch(text):
        raise TransitionError("final version is invalid")
    return text, npm_for(text), VERSION.fullmatch(text).group(4) is not None


def npm_version(text: str) -> str:
    if not isinstance(text, str) or len(text) > 64 or not NPM_VERSION.fullmatch(text):
        raise TransitionError("final npm version is invalid")
    return text


def expected_npm(version: str) -> str:
    return npm_for(version)


def read_json(path: Path, *, max_bytes: int = 65536) -> bytes:
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise TransitionError("input must be a regular file")
    if path.stat().st_size > max_bytes:
        raise TransitionError("input is too large")
    return path.read_bytes()


def load_final(
    path: Path, *, runtime_lock: Path | None, installer_dir: Path | None
) -> tuple[dict, bytes]:
    raw = read_json(path)
    try:
        value = json.loads(raw)
    except ValueError as error:
        raise TransitionError("final manifest is not valid JSON") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 2:
        raise TransitionError("final manifest must use schemaVersion 2")
    if value.get("product") != "DWhale" or value.get("repository") != REPOSITORY:
        raise TransitionError("final manifest identity is invalid")
    version = value.get("version")
    derived_npm = expected_npm(version) if isinstance(version, str) else None
    if (
        not derived_npm
        or value.get("npmVersion") != derived_npm
        or value.get("tag") != f"dwhale-v{derived_npm}"
    ):
        raise TransitionError("final manifest version fields are inconsistent")
    commit = value.get("commit")
    if not isinstance(commit, str) or not COMMIT.fullmatch(commit):
        raise TransitionError("final manifest commit is invalid")
    runtime = value.get("runtime")
    if not isinstance(runtime, dict) or set(runtime) != RUNTIME_KEYS:
        raise TransitionError("final manifest runtime is invalid")
    if any(not isinstance(item, str) or not item for item in runtime.values()):
        raise TransitionError("final manifest runtime is invalid")
    lock_sha = value.get("runtimeLockSha256")
    if not isinstance(lock_sha, str) or not DIGEST.fullmatch(lock_sha):
        raise TransitionError("final manifest runtime lock digest is invalid")
    if runtime_lock is not None:
        raw_lock = read_json(runtime_lock)
        if hashlib.sha256(raw_lock).hexdigest() != lock_sha:
            raise TransitionError("final manifest does not bind the supplied runtime lock")
    assets = value.get("assets")
    if not isinstance(assets, dict) or set(assets) != set(SUFFIXES):
        raise TransitionError("final manifest assets are incomplete")
    target_assets = {}
    for platform, suffix in SUFFIXES.items():
        asset = assets[platform]
        if not isinstance(asset, dict) or set(asset) != {"name", "url", "size", "sha256"}:
            raise TransitionError("final manifest asset fields are invalid")
        name = asset["name"]
        if name != f"DWhale-{derived_npm}-{suffix}":
            raise TransitionError("final manifest asset name is invalid")
        if (
            not isinstance(asset["size"], int)
            or isinstance(asset["size"], bool)
            or not 0 < asset["size"] <= 4 * 1024**3
        ):
            raise TransitionError("final manifest asset size is invalid")
        if not isinstance(asset["sha256"], str) or not DIGEST.fullmatch(asset["sha256"]):
            raise TransitionError("final manifest asset digest is invalid")
        url = f"https://github.com/{REPOSITORY}/releases/download/{value['tag']}/{name}"
        if asset.get("url") != url:
            raise TransitionError("final manifest asset URL is invalid")
        if installer_dir is not None:
            file = Path(installer_dir) / name
            if file.is_symlink() or not file.is_file() or file.stat().st_size != asset["size"]:
                raise TransitionError("installer does not match the final manifest")
            digest = hashlib.sha256()
            with file.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != asset["sha256"]:
                raise TransitionError("installer does not match the final manifest")
        target_assets[platform] = {"name": name, "size": asset["size"], "sha256": asset["sha256"]}
    target = {
        "version": version,
        "tag": value["tag"],
        "commit": commit,
        "manifestSha256": hashlib.sha256(raw).hexdigest(),
        "runtimeLockSha256": lock_sha,
        "assets": target_assets,
    }
    return target, raw


def build_transition(
    *,
    final_manifest: Path,
    bridge_version: str,
    origin_version: str,
    origin_runtime: dict,
    origin_v1_state: dict,
    chain_id: str | None,
    runtime_lock: Path | None,
    installer_dir: Path | None,
) -> dict:
    if not isinstance(bridge_version, str) or not VERSION.fullmatch(bridge_version):
        raise TransitionError("bridge version is invalid")
    bridge_parsed = python_version(bridge_version)
    if bridge_parsed[2] is False:
        raise TransitionError("bridge version must be a prerelease")
    if not isinstance(origin_version, str) or not ORIGIN.fullmatch(origin_version):
        raise TransitionError("origin version must be the a14 baseline")
    if not isinstance(origin_runtime, dict) or set(origin_runtime) != RUNTIME_KEYS:
        raise TransitionError("origin runtime is invalid")
    if any(not isinstance(item, str) or not item for item in origin_runtime.values()):
        raise TransitionError("origin runtime is invalid")
    if not isinstance(origin_v1_state, dict):
        raise TransitionError("origin v1 state must be an object")
    if chain_id is None:
        chain_id = secrets.token_hex(16)
    if not isinstance(chain_id, str) or not CHAIN_ID.fullmatch(chain_id):
        raise TransitionError("chain id must be 32 lowercase hex characters")
    target, _ = load_final(final_manifest, runtime_lock=runtime_lock, installer_dir=installer_dir)
    if not (target["version"].startswith("0.4.") or target["version"].startswith("0.5.")):
        raise TransitionError("final target is not a 0.4 series release")
    chain = {
        "format": 1,
        "chainId": chain_id,
        "bridge": {"version": bridge_version, "tag": f"v{bridge_parsed[0]}"},
        "originVersion": origin_version,
        "originRuntime": origin_runtime,
        "originV1State": origin_v1_state,
        "originBackup": None,
        "originInstaller": None,
        "fixedFinalTarget": target,
        "hops": [],
        "terminalState": "pending",
    }
    return chain


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--final-manifest", type=Path, required=True)
    parser.add_argument("--bridge-version", default="0.4.0a0")
    parser.add_argument("--origin-version", default="0.3.0a14")
    parser.add_argument(
        "--origin-runtime",
        type=json.loads,
        default={"astrbot": "4.29.3", "python": "3.12", "node": "22.23.4", "ffmpeg": "9.0.2"},
    )
    parser.add_argument("--origin-v1-state", default='{"format":1,"phase":"idle"}')
    parser.add_argument("--chain-id", default=None)
    parser.add_argument("--runtime-lock", type=Path, default=None)
    parser.add_argument("--installer-dir", type=Path, default=None)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args(argv)
    try:
        origin_state = json.loads(options.origin_v1_state)
        chain = build_transition(
            final_manifest=options.final_manifest,
            bridge_version=options.bridge_version,
            origin_version=options.origin_version,
            origin_runtime=options.origin_runtime,
            origin_v1_state=origin_state,
            chain_id=options.chain_id,
            runtime_lock=options.runtime_lock,
            installer_dir=options.installer_dir,
        )
        output = Path(options.output)
        if output.is_symlink():
            raise TransitionError("output must not be a symlink")
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_name(output.name + ".tmp")
        temporary.write_text(
            json.dumps(chain, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(output)
    except (TransitionError, OSError) as error:
        print(f"Bridge transition was not generated: {error}", file=sys.stderr)
        return 1
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

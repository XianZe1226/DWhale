"""Create signed desktop release metadata; the private signing key stays local.

Protocol 1 (schema1) is used only for legacy a14-compatible bridge releases:
  python -m scripts.release_manifest --protocol 1 --assets dist --key /secure/key.pem \
    --version 0.4.0a0 --commit <full-commit>

Protocol 2 (schema2) is the DWhale update protocol and reads the pinned runtime
from runtime-lock.json:
  python -m scripts.release_manifest --protocol 2 --assets dist --key /secure/key.pem \
    --version 0.4.0a1 --commit <full-commit>

Requires Node.js (already required for the desktop build). Outputs
release-manifest.json and its raw, 64-byte Ed25519 release-manifest.sig. This
authenticates release metadata; it is not OS code signing or notarization.
Upload both files alongside the exact three installers to the matching tag.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPOSITORY = "XianZe1226/DWhale"
MAX_INSTALLER_BYTES = 4 * 1024**3
SUFFIXES = {
    "win32-x64": "Windows-x86_64-setup.exe",
    "darwin-arm64": "macOS-arm64.dmg",
    "linux-x64": "Linux-x86_64.deb",
}
MINIMUM_OS = {
    "win32": "10.0.19045",
    "darwin": "13.0",
    "linux": ["ubuntu:22.04", "ubuntu:24.04"],
}
LEGACY_RUNTIME = {"astrbot": "4.29.3", "python": "3.12", "node": "22.23.4", "ffmpeg": "9.0.2"}
DEFAULT_TRUST = Path(__file__).resolve().parents[1] / "desktop/lib/release-trust.json"
DEFAULT_LOCK = Path(__file__).resolve().parents[1] / "runtime-lock.json"
PRODUCT_ID = "dev.dswhale.desktop"
VERSION_RE = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:(a|b|rc)(0|[1-9]\d*))?")
MATRIX_RE = re.compile(r"^[0-9][0-9A-Za-z.+_-]{0,119}$")


def parse_version(version):
    """Return canonical Python/npm versions and channel for one release."""
    match = (
        VERSION_RE.fullmatch(version) if isinstance(version, str) and len(version) <= 64 else None
    )
    if not match or any(
        int(part) > 9007199254740991
        for part in match.groups()
        if part is not None and part.isdigit()
    ):
        raise ValueError("Release version is invalid")
    major, minor, patch, stage, number = match.groups()
    if stage is None:
        npm_version = version
        pre = False
    else:
        suffix = {"a": "alpha", "b": "beta", "rc": "rc"}[stage]
        npm_version = f"{major}.{minor}.{patch}-{suffix}.{number}"
        pre = True
    return {
        "text": version,
        "npm": npm_version,
        "pre": pre,
        "channel": "alpha" if pre else "stable",
        "stage": {"a": "alpha", "b": "beta", "rc": "rc", None: "final"}[stage],
    }


def load_runtime_lock(path=DEFAULT_LOCK):
    raw = Path(path).read_bytes()
    try:
        value = json.loads(raw)
    except ValueError as error:
        raise ValueError("Runtime lock is unreadable") from error
    if not isinstance(value, dict) or set(value) != {
        "format",
        "product",
        "verifiedAt",
        "source",
        "runtime",
        "legacy",
    }:
        raise ValueError("Runtime lock fields are invalid")
    if (
        value["format"] != 1
        or value["product"] != "DWhale"
        or not isinstance(value["source"], str)
        or not value["source"].startswith("https://")
    ):
        raise ValueError("Runtime lock identity is invalid")
    for name in ("runtime", "legacy"):
        matrix = value[name]
        if not isinstance(matrix, dict) or set(matrix) != {"astrbot", "python", "node", "ffmpeg"}:
            raise ValueError("Runtime lock matrix is invalid")
        if any(
            not isinstance(item, str) or not MATRIX_RE.fullmatch(item) for item in matrix.values()
        ):
            raise ValueError("Runtime lock versions are invalid")
    return raw, value


def _installers(folder, *, prefix, npm_version, tag, runtime, runtime_lock_sha, product, protocol):
    assets = {}
    folder = Path(folder)
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError("Installer folder must be a regular directory")
    for platform, suffix in SUFFIXES.items():
        name = f"{prefix}-{npm_version}-{suffix}"
        file = folder / name
        if file.is_symlink() or not file.is_file():
            raise ValueError("A required regular installer is missing")
        size = file.stat().st_size
        if not 0 < size <= MAX_INSTALLER_BYTES:
            raise ValueError("Installer size is outside release limits")
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if file.stat().st_size != size:
            raise ValueError("Installer changed while preparing the manifest")
        assets[platform] = {
            "name": name,
            "url": f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}",
            "size": size,
            "sha256": digest.hexdigest(),
        }
    return assets


def _impact(impact):
    flags = {
        "runtime": True,
        "dataMigration": False,
        "configuration": False,
        "rollbackCompatible": True,
    }
    if impact is not None:
        if (
            not isinstance(impact, dict)
            or set(impact) != set(flags)
            or any(type(v) is not bool for v in impact.values())
        ):
            raise ValueError("Invalid release impact flags")
        flags = dict(impact)
    return flags


def build_manifest(
    assets,
    *,
    version,
    npm_version=None,
    commit,
    impact=None,
    protocol=1,
    runtime_lock=DEFAULT_LOCK,
    **legacy,
):
    """Build schema1 legacy/bridge or schema2 DWhale metadata for exact installers."""
    if legacy:
        raise TypeError(f"Unexpected arguments: {', '.join(sorted(legacy))}")
    parsed = parse_version(version)
    if npm_version is None:
        npm_version = parsed["npm"]
    if npm_version != parsed["npm"]:
        raise ValueError("Release versions do not match")
    if protocol not in (1, 2):
        raise ValueError("Release protocol must be 1 or 2")
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("A full release commit is required")
    flags = _impact(impact)
    lock_raw, lock_data = (None, None)
    if protocol == 1:
        if parsed["stage"] not in ("alpha", "final"):
            raise ValueError("Legacy protocol only accepts alpha or final versions")
        if parsed["stage"] != "alpha":
            # A stable bridge is allowed only for the later 0.4.0 route; it still
            # carries the legacy runtime and product identity.
            pass
        runtime = dict(LEGACY_RUNTIME)
        tag = f"v{version}"
        assets_map = _installers(
            assets,
            prefix="DSWhale",
            npm_version=npm_version,
            tag=tag,
            runtime=runtime,
            runtime_lock_sha=None,
            product="DSWhale",
            protocol=1,
        )
        return {
            "schemaVersion": 1,
            "product": "DSWhale",
            "repository": REPOSITORY,
            "version": version,
            "npmVersion": npm_version,
            "channel": parsed["channel"],
            "tag": tag,
            "commit": commit,
            "minimumOS": MINIMUM_OS,
            "runtime": runtime,
            "impact": flags,
            "assets": assets_map,
        }
    lock_raw, lock_data = load_runtime_lock(runtime_lock)
    runtime = dict(lock_data["runtime"])
    tag = f"dwhale-v{npm_version}"
    lock_sha = hashlib.sha256(lock_raw).hexdigest()
    assets_map = _installers(
        assets,
        prefix="DWhale",
        npm_version=npm_version,
        tag=tag,
        runtime=runtime,
        runtime_lock_sha=lock_sha,
        product="DWhale",
        protocol=2,
    )
    return {
        "schemaVersion": 2,
        "product": "DWhale",
        "productId": PRODUCT_ID,
        "repository": REPOSITORY,
        "tag": tag,
        "version": version,
        "pythonVersion": version,
        "npmVersion": npm_version,
        "channel": parsed["channel"],
        "commit": commit,
        "minimumOS": MINIMUM_OS,
        "runtime": runtime,
        "runtimeLockSha256": lock_sha,
        "impact": flags,
        "assets": assets_map,
    }


def sign_manifest(manifest_bytes, key, *, trust=DEFAULT_TRUST):
    """Keep key material in Node's crypto process; never expose dependency errors."""
    script = """
const fs = require('node:fs'), crypto = require('node:crypto');
try {
  const key = crypto.createPrivateKey(fs.readFileSync(process.argv[1]));
  if (key.asymmetricKeyType !== 'ed25519') process.exit(2);
  const trust = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (trust.repository !== 'XianZe1226/DWhale' || trust.algorithm !== 'ed25519') process.exit(2);
  const publicKey = crypto.createPublicKey(trust.publicKey);
  const bytes = fs.readFileSync(0), signature = crypto.sign(null, bytes, key);
  if (signature.length !== 64) process.exit(2);
  if (publicKey.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, bytes, publicKey, signature)) process.exit(2);
  process.stdout.write(signature);
} catch { process.exit(2); }
"""
    try:
        result = subprocess.run(
            ["node", "-e", script, str(Path(key)), str(Path(trust))],
            input=manifest_bytes,
            capture_output=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError("Release signing could not run") from error
    if result.returncode != 0 or len(result.stdout) != 64:
        raise ValueError("Release signing failed; check the local Ed25519 key")
    return result.stdout


def publish_manifest(
    assets,
    *,
    key,
    version,
    npm_version=None,
    commit,
    impact=None,
    trust=DEFAULT_TRUST,
    protocol=1,
    runtime_lock=DEFAULT_LOCK,
):
    key_path = Path(key).resolve()
    if key_path.is_relative_to(Path(assets).resolve()) or key_path.is_relative_to(
        Path(__file__).resolve().parents[1]
    ):
        raise ValueError("The signing key must stay outside source and release folders")
    manifest = build_manifest(
        assets,
        version=version,
        npm_version=npm_version,
        commit=commit,
        impact=impact,
        protocol=protocol,
        runtime_lock=runtime_lock,
    )
    raw = (
        json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n"
    ).encode("utf-8")
    signature = sign_manifest(raw, key, trust=trust)
    folder = Path(assets)
    # Sign successfully before touching published output. Exclusive staging files
    # prevent following a stale symlink; publishing the pair requires both assets.
    staged = []
    try:
        for name, data in (("release-manifest.json", raw), ("release-manifest.sig", signature)):
            target = folder / name
            if target.is_symlink():
                raise ValueError("Release output cannot be a symlink")
            temporary = folder / f".{name}.{os.getpid()}.tmp"
            with temporary.open("xb") as stream:
                staged.append((temporary, target))
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        for temporary, target in staged:
            temporary.replace(target)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument(
        "--trust",
        type=Path,
        default=DEFAULT_TRUST,
        help="Public trust file; defaults to the app's embedded release key",
    )
    parser.add_argument("--version", required=True)
    parser.add_argument("--protocol", type=int, choices=(1, 2), default=1)
    parser.add_argument("--runtime-lock", type=Path, default=DEFAULT_LOCK)
    parser.add_argument("--npm-version", default=None)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--data-migration", action="store_true")
    parser.add_argument("--configuration-change", action="store_true")
    parser.add_argument("--rollback-incompatible", action="store_true")
    options = parser.parse_args(argv)
    try:
        publish_manifest(
            options.assets,
            key=options.key,
            version=options.version,
            trust=options.trust,
            npm_version=options.npm_version,
            commit=options.commit,
            protocol=options.protocol,
            runtime_lock=options.runtime_lock,
            impact={
                "runtime": True,
                "dataMigration": options.data_migration,
                "configuration": options.configuration_change,
                "rollbackCompatible": not options.rollback_incompatible,
            },
        )
    except (ValueError, OSError):
        print(
            "Release manifest was not published. Check versions, installers and the local signing key.",
            file=sys.stderr,
        )
        return 1
    print("Signed release manifest written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

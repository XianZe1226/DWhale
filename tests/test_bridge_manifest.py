"""Transition-lock generator tests: only real v2 manifest bytes may bind a bridge."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SUFFIXES = {
    "win32-x64": "Windows-x86_64-setup.exe",
    "darwin-arm64": "macOS-arm64.dmg",
    "linux-x64": "Linux-x86_64.deb",
}


def require_module():
    from scripts import bridge_manifest

    return bridge_manifest


def asset_folder(tmp_path: Path) -> Path:
    folder = tmp_path / "assets"
    folder.mkdir()
    for suffix in SUFFIXES.values():
        (folder / f"DWhale-0.4.0-alpha.1-{suffix}").write_bytes(b"final installer fixture")
    return folder


def final_manifest(tmp_path: Path, **kwargs) -> tuple[Path, dict]:
    from scripts import release_manifest

    folder = asset_folder(tmp_path)
    manifest = release_manifest.build_manifest(
        folder, version="0.4.0a1", commit="b" * 40, protocol=2, **kwargs
    )
    raw = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    path = tmp_path / "release-manifest.json"
    path.write_bytes(raw)
    return path, manifest


def build(tmp_path: Path, **kwargs):
    module = require_module()
    manifest_path, manifest = final_manifest(tmp_path)
    chain = module.build_transition(
        final_manifest=manifest_path,
        bridge_version="0.4.0a0",
        origin_version="0.3.0a14",
        origin_runtime={
            "astrbot": "4.29.3",
            "python": "3.12",
            "node": "22.23.4",
            "ffmpeg": "9.0.2",
        },
        origin_v1_state={"format": 1, "phase": "idle"},
        chain_id="c" * 32,
        runtime_lock=ROOT / "runtime-lock.json",
        installer_dir=tmp_path / "assets",
        **kwargs,
    )
    return chain, manifest_path, manifest


def test_generator_binds_exact_final_manifest_bytes_and_installers(tmp_path):
    chain, manifest_path, manifest = build(tmp_path)
    assert manifest["repository"] == "XianZe1226/DWhale"
    assert manifest["assets"]["darwin-arm64"]["url"] == (
        "https://github.com/XianZe1226/DWhale/releases/download/"
        "dwhale-v0.4.0-alpha.1/DWhale-0.4.0-alpha.1-macOS-arm64.dmg"
    )
    assert chain["format"] == 1
    assert chain["terminalState"] == "pending"
    assert chain["bridge"] == {"version": "0.4.0a0", "tag": "v0.4.0a0"}
    assert chain["originVersion"] == "0.3.0a14"
    assert chain["originRuntime"]["astrbot"] == "4.29.3"
    assert chain["fixedFinalTarget"]["version"] == "0.4.0a1"
    assert chain["fixedFinalTarget"]["tag"] == "dwhale-v0.4.0-alpha.1"
    assert chain["fixedFinalTarget"]["commit"] == "b" * 40
    assert (
        chain["fixedFinalTarget"]["manifestSha256"]
        == hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    )
    assert set(chain["fixedFinalTarget"]["assets"]) == set(SUFFIXES)
    assert chain["fixedFinalTarget"]["assets"]["darwin-arm64"] == {
        "name": "DWhale-0.4.0-alpha.1-macOS-arm64.dmg",
        "size": len(b"final installer fixture"),
        "sha256": hashlib.sha256(b"final installer fixture").hexdigest(),
    }
    assert (
        chain["fixedFinalTarget"]["runtimeLockSha256"]
        == hashlib.sha256((ROOT / "runtime-lock.json").read_bytes()).hexdigest()
    )


def test_generator_rejects_mismatched_bytes_and_installers(tmp_path):
    module = require_module()
    manifest_path, _ = final_manifest(tmp_path)
    common = dict(
        final_manifest=manifest_path,
        origin_version="0.3.0a14",
        origin_runtime={
            "astrbot": "4.29.3",
            "python": "3.12",
            "node": "22.23.4",
            "ffmpeg": "9.0.2",
        },
        origin_v1_state={"format": 1, "phase": "idle"},
        chain_id="c" * 32,
        runtime_lock=ROOT / "runtime-lock.json",
        installer_dir=tmp_path / "assets",
    )
    with pytest.raises(module.TransitionError):
        module.build_transition(**common, bridge_version="0.4.0")  # the bridge must stay prerelease
    with pytest.raises(module.TransitionError):
        module.build_transition(**{**common, "chain_id": "not-a-chain"}, bridge_version="0.4.0a0")


def test_generator_rejects_foreign_runtime_lock_and_tampered_installer(tmp_path):
    module = require_module()
    manifest_path, _ = final_manifest(tmp_path)
    wrong_lock = tmp_path / "runtime-lock.json"
    wrong_lock.write_text("{}")
    with pytest.raises(module.TransitionError):
        module.build_transition(
            final_manifest=manifest_path,
            bridge_version="0.4.0a0",
            origin_version="0.3.0a14",
            origin_runtime={
                "astrbot": "4.29.3",
                "python": "3.12",
                "node": "22.23.4",
                "ffmpeg": "9.0.2",
            },
            origin_v1_state={"format": 1, "phase": "idle"},
            chain_id="c" * 32,
            runtime_lock=wrong_lock,
            installer_dir=tmp_path / "assets",
        )
    next((tmp_path / "assets").glob("*.dmg")).write_bytes(b"tampered")
    with pytest.raises(module.TransitionError):
        module.build_transition(
            final_manifest=manifest_path,
            bridge_version="0.4.0a0",
            origin_version="0.3.0a14",
            origin_runtime={
                "astrbot": "4.29.3",
                "python": "3.12",
                "node": "22.23.4",
                "ffmpeg": "9.0.2",
            },
            origin_v1_state={"format": 1, "phase": "idle"},
            chain_id="c" * 32,
            runtime_lock=ROOT / "runtime-lock.json",
            installer_dir=tmp_path / "assets",
        )


def test_cli_writes_deterministic_transition(tmp_path):
    manifest_path, _ = final_manifest(tmp_path)
    output = tmp_path / "transition-lock.json"
    command = [
        sys.executable,
        "-m",
        "scripts.bridge_manifest",
        "--final-manifest",
        str(manifest_path),
        "--bridge-version",
        "0.4.0a0",
        "--installer-dir",
        str(tmp_path / "assets"),
        "--runtime-lock",
        str(ROOT / "runtime-lock.json"),
        "--chain-id",
        "d" * 32,
        "--output",
        str(output),
    ]
    first = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    assert first.returncode == 0, first.stderr
    raw_first = output.read_bytes()
    second = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    assert second.returncode == 0, second.stderr
    assert output.read_bytes() == raw_first
    chain = json.loads(raw_first)
    assert chain["chainId"] == "d" * 32
    assert (
        chain["fixedFinalTarget"]["assets"]["linux-x64"]["name"]
        == "DWhale-0.4.0-alpha.1-Linux-x86_64.deb"
    )
    node = shutil.which("node")
    if node:
        parsed = subprocess.run(
            [
                node,
                "-e",
                "const fs=require('node:fs');const c=require('./desktop/lib/update-chain.cjs');c.parse(fs.readFileSync(process.argv[1]));",
                str(output),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        assert parsed.returncode == 0, parsed.stderr

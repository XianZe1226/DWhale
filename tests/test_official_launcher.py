"""Source launchers enforce the same official-only policy as the desktop."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def launcher():
    spec = importlib.util.spec_from_file_location("source_launcher", ROOT / "scripts/launch.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_source_start_disables_legacy_platform_before_host_execution(tmp_path, monkeypatch):
    module = launcher()
    host = tmp_path / "runtime/astrbot"
    data = host / "data"
    data.mkdir(parents=True)
    config = data / "cmd_config.json"
    config.write_text(json.dumps({"platform": [{"type": "aiocqhttp", "enable": True}]}))
    monkeypatch.setattr(module, "launch_environment", lambda _: {"ASTRBOT_ROOT": str(host)})
    monkeypatch.setattr(sys, "argv", ["launch.py"])
    calls = []

    def capture(args, **options):
        calls.append((args, options))
        assert json.loads(config.read_text())["platform"][0]["enable"] is False
        fish = json.loads((data / "config/astrbot_plugin_dswhale_config.json").read_text())
        assert fish["qq_connection_mode"] == "official"
        return 0

    monkeypatch.setattr(module.subprocess, "call", capture)
    assert module.main() == 0
    assert len(calls) == 1
    assert calls[0][0][-2:] == ["astrbot.cli", "run"]


def test_source_start_fails_closed_when_migration_cannot_read_config(tmp_path, monkeypatch):
    module = launcher()
    host = tmp_path / "runtime/astrbot"
    data = host / "data"
    data.mkdir(parents=True)
    config = data / "cmd_config.json"
    config.write_text("invalid synthetic JSON")
    monkeypatch.setattr(module, "launch_environment", lambda _: {"ASTRBOT_ROOT": str(host)})
    monkeypatch.setattr(sys, "argv", ["launch.py"])
    calls = []
    monkeypatch.setattr(module.subprocess, "call", lambda *args, **kwargs: calls.append(args))
    with pytest.raises(ValueError):
        module.main()
    assert calls == []
    assert config.read_text() == "invalid synthetic JSON"


def test_bili_settings_launcher_does_not_migrate_a_running_hosts_configuration(
    tmp_path, monkeypatch
):
    module = launcher()
    host = tmp_path / "runtime/astrbot"
    host.mkdir(parents=True)
    monkeypatch.setattr(module, "launch_environment", lambda _: {"ASTRBOT_ROOT": str(host)})
    monkeypatch.setattr(sys, "argv", ["launch.py", "--bili"])
    calls = []
    monkeypatch.setattr(module.subprocess, "call", lambda *args, **kwargs: calls.append(args) or 0)
    assert module.main() == 0
    assert "bili-open" in calls[0][0]
    assert not (host / "data").exists()


def test_source_launcher_loads_current_policy_ahead_of_an_old_installed_package(tmp_path):
    stale = tmp_path / "stale"
    package = stale / "dswhale"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (package / "runtime.py").write_text("raise RuntimeError('stale installed policy')")
    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            "import runpy,sys; sys.path.insert(0,sys.argv[1]); "
            "runpy.run_path(sys.argv[2],run_name='policy_inspection'); print('current source loaded')",
            str(stale),
            str(ROOT / "scripts/launch.py"),
        ],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=False,
    )
    assert probe.returncode == 0, probe.stderr
    assert probe.stdout.strip() == "current source loaded"

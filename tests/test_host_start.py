"""Stable lifecycle locks cover host execution and every installer generation."""

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest
from filelock import FileLock, Timeout

ROOT = Path(__file__).resolve().parents[1]


def host_start():
    spec = importlib.util.spec_from_file_location("host_start", ROOT / "dswhale/host_start.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_host_gate_covers_migration_and_execution_without_blocking_setup_reads(
    tmp_path, monkeypatch
):
    module = host_start()
    runtime = tmp_path / "runtime"
    host = runtime / "astrbot"
    host.mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ASTRBOT_ROOT", str(host))
    monkeypatch.setenv("DSWHALE_RUNTIME_DIR", str(runtime))
    events = []

    def locked_gate():
        with pytest.raises(Timeout):
            FileLock(runtime / "host-lifecycle.lock", timeout=0).acquire()
        with FileLock(runtime / "setup.lock", timeout=0):
            pass

    def migrate(root):
        assert root == host
        locked_gate()
        events.append("migrate")

    def run_module(name, *, run_name, alter_sys):
        assert name == "astrbot.cli"
        assert run_name == "__main__"
        assert alter_sys is True
        assert sys.argv == ["astrbot.cli", "run"]
        assert Path.cwd() == host
        locked_gate()
        events.append("run")

    monkeypatch.setattr(module, "migrate_settings", migrate)
    monkeypatch.setattr(module.runpy, "run_module", run_module)
    assert module.run_host(runtime) == 0
    assert events == ["migrate", "run"]
    assert Path.cwd() == tmp_path
    with FileLock(runtime / "host-lifecycle.lock", timeout=0):
        pass


def test_busy_gate_prevents_migration_and_host_execution(tmp_path, monkeypatch):
    module = host_start()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    events = []
    monkeypatch.setattr(module, "migrate_settings", lambda *_: events.append("migrate"))
    monkeypatch.setattr(module.runpy, "run_module", lambda *_args, **_kwargs: events.append("run"))
    with FileLock(runtime / "host-lifecycle.lock", timeout=0):
        with pytest.raises(Timeout):
            module.run_host(runtime)
    assert events == []


@pytest.mark.parametrize("failure", [KeyboardInterrupt(), SystemExit(0), SystemExit(2)])
def test_cancelled_host_releases_gate_and_restores_process_state(tmp_path, monkeypatch, failure):
    module = host_start()
    runtime = tmp_path / "runtime"
    (runtime / "astrbot").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DSWHALE_RUNTIME_DIR", "original-runtime")
    monkeypatch.setenv("ASTRBOT_ROOT", "original-host")
    previous_argv = sys.argv
    monkeypatch.setattr(module, "migrate_settings", lambda *_: None)

    def interrupt(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(module.runpy, "run_module", interrupt)
    with pytest.raises(type(failure)) as result:
        module.run_host(runtime)
    assert result.value is failure
    assert sys.argv is previous_argv
    assert os.environ["DSWHALE_RUNTIME_DIR"] == "original-runtime"
    assert os.environ["ASTRBOT_ROOT"] == "original-host"
    assert Path.cwd() == tmp_path
    with FileLock(runtime / "host-lifecycle.lock", timeout=0):
        pass


def test_host_script_reports_busy_gate_before_loading_upstream(tmp_path, monkeypatch):
    module = host_start()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    with FileLock(runtime / "host-lifecycle.lock", timeout=0):
        with pytest.raises(SystemExit, match="环境正在准备|服务已运行"):
            module.main(["--runtime", str(runtime)])


@pytest.mark.parametrize(
    "journal", [{"phase": "activating"}, {"phase": "activated"}, "invalid JSON"]
)
def test_uncommitted_generation_cannot_accept_host_writes(tmp_path, monkeypatch, journal):
    module = host_start()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    payload = journal if isinstance(journal, str) else json.dumps(journal)
    (runtime / "activation.json").write_text(payload, encoding="utf-8")
    events = []
    monkeypatch.setattr(module, "migrate_settings", lambda *_: events.append("migrate"))
    monkeypatch.setattr(module.runpy, "run_module", lambda *_args, **_kwargs: events.append("run"))
    with pytest.raises(SystemExit, match="重新准备环境"):
        module.run_host(runtime)
    assert events == []


@pytest.mark.parametrize("phase", ["committed", "finalizing"])
def test_committed_generation_can_start_while_old_cleanup_is_pending(tmp_path, monkeypatch, phase):
    module = host_start()
    runtime = tmp_path / "runtime"
    (runtime / "astrbot").mkdir(parents=True)
    (runtime / "activation.json").write_text(json.dumps({"phase": phase}), encoding="utf-8")
    monkeypatch.setattr(module, "migrate_settings", lambda *_: None)
    monkeypatch.setattr(module.runpy, "run_module", lambda *_args, **_kwargs: None)
    assert module.run_host(runtime) == 0

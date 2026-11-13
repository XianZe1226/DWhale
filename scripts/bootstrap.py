"""Idempotent setup for source launchers and the desktop's private runtime."""

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import stat
import string
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

from filelock import FileLock, Timeout

# This file also runs before DSWhale is installed. Load the bundled, standard-
# library-only policy directly, without relying on cwd or an installed package.
_network_spec = spec_from_file_location(
    "dswhale_bootstrap_network", Path(__file__).resolve().parents[1] / "dswhale/network.py"
)
_network = module_from_spec(_network_spec)
_network_spec.loader.exec_module(_network)


def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, timeout=1800, **kwargs)


def output(args, **kwargs):
    try:
        return subprocess.check_output(
            [str(a) for a in args],
            text=True,
            encoding="utf-8",
            errors="replace",
            stderr=subprocess.DEVNULL,
            timeout=900,
            **kwargs,
        )
    except subprocess.CalledProcessError as error:
        for line in (error.output or "").splitlines():
            if line.startswith("DSWHALE_NETWORK_ERROR "):
                try:
                    event = json.loads(line.removeprefix("DSWHALE_NETWORK_ERROR "))
                    safe = _network.NetworkError(event.get("code"), event.get("source"))
                except (ValueError, TypeError, AttributeError):
                    continue
                raise safe from None
        raise


def network_command(script):
    return (
        "import json,sys\nfrom dswhale.network import NetworkError\ntry:\n"
        f"    exec({script!r})\n"
        "except NetworkError as error:\n"
        "    print('DSWHALE_NETWORK_ERROR '+json.dumps({'code':error.code,'source':error.source}),flush=True)\n"
        "    sys.exit(1)\n"
    )


def progress(step, value):
    print("DSWHALE_PROGRESS " + json.dumps({"step": step, "progress": value}), flush=True)


def runtime_lock_matrix():
    path = Path(__file__).resolve().parents[1] / "runtime-lock.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit("runtime-lock.json 缺失或无效") from error
    matrix = data.get("runtime") if isinstance(data, dict) else None
    keys = ("astrbot", "python", "node", "ffmpeg")
    if (
        not isinstance(matrix, dict)
        or set(matrix) != set(keys)
        or not all(isinstance(matrix[key], str) and matrix[key] for key in keys)
    ):
        raise SystemExit("runtime-lock.json 版本矩阵无效")
    return matrix


def runtime_receipt(version, python, node, ffmpeg, env):
    script = """
import importlib.metadata as metadata, json, re, subprocess, sys
def probe(command, flag, pattern):
    result = subprocess.check_output([command, flag], text=True, stderr=subprocess.DEVNULL, timeout=10)
    match = re.match(pattern, result)
    return match[1] if match else ''
print(json.dumps({
    'dswhale': metadata.version('dswhale'), 'astrbot': metadata.version('astrbot'),
    'python': '.'.join(str(p) for p in sys.version_info[:3]),
    'node': probe(sys.argv[1], '--version', r'^v(\\d+\\.\\d+\\.\\d+)'),
    'ffmpeg': probe(sys.argv[2], '-version', r'^ffmpeg version (\\d+\\.\\d+(?:\\.\\d+)?(?:[-\\w.]*)?)'),
}))
"""
    data = json.loads(output([python, "-c", script, node, ffmpeg], env=env))
    versions = {}
    for key in ("dswhale", "astrbot", "python", "node", "ffmpeg"):
        value = data.get(key, "")
        versions[key] = (
            value
            if isinstance(value, str) and re.fullmatch(r"[0-9][0-9a-zA-Z.+_-]{0,119}", value)
            else ""
        )
    channel = "alpha" if re.search(r"[ab]|rc", version) else "stable"
    matrix = runtime_lock_matrix()
    expected = {
        "dswhale": version,
        "astrbot": matrix["astrbot"],
        "python": matrix["python"],
        "node": matrix["node"],
        "ffmpeg": matrix["ffmpeg"],
        "channel": channel,
    }
    return {
        "version": version,
        "format": 2,
        "versions": versions,
        "expected": expected,
        "channel": channel,
    }


def runtime_directory(source):
    return (
        Path(os.environ.get("DSWHALE_RUNTIME_DIR", str(Path(source) / ".runtime")))
        .expanduser()
        .resolve()
    )


def snapshot_data(host, runtime):
    """Take a restore-compatible snapshot even if the old interpreter is broken."""
    data = host / "data"
    paths = list(data.rglob("*"))
    if data.is_symlink() or any(path.is_symlink() for path in paths):
        raise ValueError("data 内存在符号链接，请先单独备份其目标")
    files = [path for path in paths if path.is_file()]
    if sum(path.stat().st_size for path in files) > 1024**3:
        raise ValueError("data 超过 1 GiB，请先手动备份")
    backups = runtime / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    archive = backups / (
        "before-upgrade-"
        + datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        + "-"
        + secrets.token_hex(16)
        + ".zip"
    )
    handle, temporary_name = tempfile.mkstemp(dir=backups, suffix=".zip")
    os.close(handle)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("manifest.json", json.dumps({"project": "DSWhale", "format": 1}))
            bundle.writestr("data/", "")
            for file in files:
                bundle.write(file, file.relative_to(host).as_posix())
        # Publish the complete, private ZIP without replacing an existing backup.
        os.link(temporary, archive)
    finally:
        temporary.unlink(missing_ok=True)
    return archive


def configure_desktop_dashboard(host):
    file = host / "data/cmd_config.json"
    config = json.loads(file.read_text(encoding="utf-8-sig"))
    config.setdefault("dashboard", {})["host"] = "127.0.0.1"
    config["disable_metrics"] = True
    temporary = file.with_suffix(".desktop.tmp")
    temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(file)


def repair_desktop_providers(host, python, env):
    # Bootstrap has only filelock installed. Host metadata and DSWhale belong to
    # the managed Python, including when upgrading an existing configuration.
    config = json.loads((host / "data/cmd_config.json").read_text(encoding="utf-8-sig"))
    if any(
        isinstance(record, dict) and record.get("type") and not record.get("provider_type")
        for group in ("provider_sources", "provider")
        if isinstance(config.get(group), list)
        for record in config.get(group, [])
    ):
        run(
            [
                python,
                "-c",
                "from dswhale.provider_compat import repair_host_providers; import sys; repair_host_providers(sys.argv[1])",
                host,
            ],
            cwd=host,
            env=env,
        )


def migrate_desktop_settings(host, python, env):
    # Additive config migrations run inside the managed Python's offline lock.
    # Bootstrap itself only has filelock and must not import astrbot.core.
    fish = host / "data/config/astrbot_plugin_dswhale_config.json"
    if not fish.is_file():
        return
    run(
        [python, "-m", "dswhale.desktop_settings", "migrate", "--host", str(host)],
        cwd=host,
        env=env,
    )


def verify_desktop_settings(host, python, env):
    # Validate the first fixed-SDK config read after the new plugin schema is
    # installed.  The child performs the read in an isolated ASTRBOT_ROOT and
    # archives legacy values the schema cannot represent.
    fish = host / "data/config/astrbot_plugin_dswhale_config.json"
    if not fish.is_file():
        return
    schema = host / "data/plugins/astrbot_plugin_dswhale/_conf_schema.json"
    if not schema.is_file():
        raise SystemExit("安装后的插件缺少配置 schema，无法验证升级结果。")
    run(
        [python, "-m", "dswhale.upgrade_verify", "--host", str(host)],
        cwd=host,
        env=env,
    )


def _sync_directory(directory):
    if os.name == "nt":
        return  # Windows does not support opening a directory for fsync.
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _private_record(path, value):
    """Publish a complete, durable mode-0600 record without replacing any file."""
    descriptor, name = tempfile.mkstemp(prefix=".desktop-auth-stage-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        # link() atomically creates a new name and refuses an existing symlink/file.
        os.link(temporary, path)
        _sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _read_login_record(path, *, pending=False):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("初始登录记录必须是普通文件")
        value = json.load(stream)
    fields = {"username", "password", "format", "purpose"} if pending else {"username", "password"}
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or not all(
            isinstance(value.get(key), str) and value[key] for key in ("username", "password")
        )
        or pending
        and (value.get("format") != 1 or value.get("purpose") != "dswhale-desktop-initial-login")
    ):
        raise ValueError("初始登录记录损坏，请先检查数据目录")
    return {key: value[key] for key in ("username", "password")}


def _login_matches(config, credential):
    dashboard = config.get("dashboard", {})
    if dashboard.get("username", "astrbot") != credential["username"]:
        return False
    try:
        algorithm, iterations, salt, expected = dashboard["pbkdf2_password"].split("$")
        iterations = int(iterations)
        if algorithm != "pbkdf2_sha256" or not 100_000 <= iterations <= 5_000_000:
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256", credential["password"].encode(), bytes.fromhex(salt), iterations
        )
        return hmac.compare_digest(actual, bytes.fromhex(expected))
    except (KeyError, ValueError, TypeError):
        return False


def _complete_initial_login(host, credential, pending_file, credential_file):
    config = json.loads((host / "data/cmd_config.json").read_text(encoding="utf-8-sig"))
    if not _login_matches(config, credential):
        raise ValueError("现有登录密码与待完成的初始登录记录不匹配，未更改现有配置")
    if credential_file.exists() and _read_login_record(credential_file) != credential:
        raise ValueError("现有初始登录记录不匹配，未更改现有配置")
    configure_desktop_dashboard(host)
    if not credential_file.exists():
        _private_record(credential_file, credential)
    pending_file.unlink()
    _sync_directory(pending_file.parent)


def initialize_host_config(host, python, env, *, desktop=False, migrate=True):
    config_file = host / "data/cmd_config.json"
    credential_file = host.parent / "desktop-auth.json"
    pending_file = host.parent / ".desktop-auth.pending.json"
    for candidate in (host.parent, host, host / "data", config_file, credential_file, pending_file):
        if candidate.is_symlink():
            raise ValueError("初始化配置不能包含符号链接")
    # Only our durable pending marker authorizes recovery of an interrupted fresh
    # setup. A genuine existing configuration never enters SDK initialization.
    if config_file.is_file():
        if desktop and pending_file.exists():
            credential = _read_login_record(pending_file, pending=True)
            _complete_initial_login(host, credential, pending_file, credential_file)
        if desktop:
            repair_desktop_providers(host, python, env)
            if migrate:
                migrate_desktop_settings(host, python, env)
        return
    if desktop:
        if pending_file.exists():
            credential = _read_login_record(pending_file, pending=True)
        else:
            if credential_file.exists():
                credential = _read_login_record(credential_file)
            else:
                alphabet = string.ascii_letters + string.digits
                chars = [
                    secrets.choice(string.ascii_uppercase),
                    secrets.choice(string.ascii_lowercase),
                    secrets.choice(string.digits),
                    *(secrets.choice(alphabet) for _ in range(29)),
                ]
                secrets.SystemRandom().shuffle(chars)
                credential = {"username": "astrbot", "password": "".join(chars)}
            _private_record(
                pending_file,
                {"format": 1, "purpose": "dswhale-desktop-initial-login", **credential},
            )
        env = {**env, "ASTRBOT_DASHBOARD_INITIAL_PASSWORD": credential["password"]}
    # The pending credential is durable before the SDK can persist its hash.
    run(
        [python, "-c", "from astrbot.core.config import AstrBotConfig; AstrBotConfig()"],
        cwd=host,
        env=env,
    )
    if desktop:
        _complete_initial_login(host, credential, pending_file, credential_file)
        repair_desktop_providers(host, python, env)
        if migrate:
            migrate_desktop_settings(host, python, env)


def main():
    source = Path(__file__).resolve().parents[1]
    runtime = runtime_directory(source)
    runtime.mkdir(parents=True, exist_ok=True)
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action in {"finalize", "rollback"}:
        with FileLock(runtime / "setup.lock", timeout=0):
            if action == "finalize":
                changed = _finalize_activation(runtime)
            else:
                with FileLock(runtime / "host-lifecycle.lock", timeout=0):
                    changed = rollback_activation(runtime)
        label = "finalized" if action == "finalize" else "rolled-back"
        print("DSWHALE_ACTIVATION " + (label if changed else "none"))
        return
    try:
        with FileLock(runtime / "setup.lock", timeout=0):
            prepare(source, runtime)
    except Timeout:
        raise SystemExit(
            "AstrBot 或另一个安装正在运行，请先停止服务再准备环境；QQ 无需退出。"
        ) from None
    except _network.NetworkError as error:
        print(
            "DSWHALE_NETWORK_ERROR " + json.dumps({"code": error.code, "source": error.source}),
            flush=True,
        )
        raise SystemExit(error.hint) from None


def _config_revision(host):
    digest = hashlib.sha256()
    for relative in ("data/cmd_config.json", "data/desktop-settings.json"):
        path = host / relative
        digest.update(relative.encode("utf-8"))
        digest.update(path.read_bytes() if path.is_file() else b"")
    return digest.hexdigest()


def _staged_verify(source, staging, staging_host, staging_python, env):
    script = """
import importlib.metadata as metadata, json, os, pathlib, sqlite3
root = pathlib.Path(os.environ["ASTRBOT_ROOT"])
payload = {
    "dswhale": metadata.version("dswhale"),
    "astrbot": metadata.version("astrbot"),
    "config": (root / "data/cmd_config.json").is_file(),
    "dswhale_plugin": (root / "data/plugins/astrbot_plugin_dswhale/main.py").is_file(),
    "memory_plugin": (root / "data/plugins/astrbot_plugin_livingmemory/main.py").is_file(),
    "db": "absent",
    "plugins_compile": True,
    "module": bool(__import__("astrbot")),
}
database = root / "data/data.db"
if database.is_file():
    connection = sqlite3.connect(database)
    try:
        payload["db"] = connection.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        connection.close()
for plugin in ("astrbot_plugin_dswhale", "astrbot_plugin_livingmemory"):
    main = root / "data/plugins" / plugin / "main.py"
    if main.is_file():
        compile(main.read_text(encoding="utf-8"), str(main), "exec")
    else:
        payload["plugins_compile"] = False
json.loads((root / "data/cmd_config.json").read_text(encoding="utf-8-sig"))
print(json.dumps(payload))
"""
    data = json.loads(output([staging_python, "-c", script], cwd=staging_host, env=env))
    project = (source / "pyproject.toml").read_text(encoding="utf-8")
    version = re.search(r'^version\s*=\s*"([^"]+)"', project, re.MULTILINE)[1]
    matrix = runtime_lock_matrix()
    if data.get("dswhale") != version or data.get("astrbot") != matrix["astrbot"]:
        raise RuntimeError("升级目标环境自检失败：版本与运行时锁不一致")
    if not all(data.get(key) for key in ("config", "dswhale_plugin", "memory_plugin")):
        raise RuntimeError("升级目标环境自检失败：配置或插件缺失")
    if (
        data.get("db") not in ("absent", "ok")
        or not data.get("plugins_compile")
        or not data.get("module")
    ):
        raise RuntimeError("升级目标环境自检失败：数据库、插件或 AstrBot 模块不可用")


_GENERATION_FILES = (
    "tool-env.json",
    "desktop-install.json",
    "desktop-auth.json",
    ".desktop-auth.pending.json",
)
_ACTIVATION = "activation.json"


def _fsync_directory(path):
    try:
        handle = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(handle)
    except OSError:
        pass
    finally:
        os.close(handle)


def _write_journal(runtime, journal):
    path = runtime / _ACTIVATION
    temporary = path.with_name(path.name + ".tmp-" + secrets.token_hex(4))
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(journal, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
    _fsync_directory(runtime)


def _read_journal(runtime):
    try:
        value = json.loads((runtime / _ACTIVATION).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) and value.get("format") == 1 else None


def _remove_path(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)


def _rename_happened(state, backup):
    """Infer whether a rename completed when the journal was interrupted."""
    return state is True or (state == "moving" and backup.exists())


def _cleanup_transaction(runtime, journal, *, strict=False):
    """Delete a retained previous generation and the activation journal.

    With ``strict`` a failure to remove the tree is surfaced instead of being
    swallowed, so a committed finalization can be retried on the next start.
    """
    transaction = runtime / "transactions" / journal["txid"]
    if transaction.exists():
        if strict:
            shutil.rmtree(transaction)
        else:
            _remove_path(transaction)
    try:
        (runtime / "transactions").rmdir()
    except OSError:
        pass
    (runtime / _ACTIVATION).unlink(missing_ok=True)
    _fsync_directory(runtime)


def _rollback_journal(runtime, journal):
    """Restore the generation recorded before activation. Safe to repeat."""
    if journal.get("phase") in ("committed", "finalizing"):
        raise RuntimeError("激活已提交，拒绝回滚到正在清理的旧代")
    backup = Path(journal["backup"])
    host = runtime / "astrbot"
    environment = runtime / "venv"
    staging = Path(journal.get("staging", ""))
    moved = journal.get("moved") or {}
    old_host = moved.get("oldHost")
    if _rename_happened(old_host, backup / "host"):
        previous = backup / "host"
        if previous.exists():
            _remove_path(host)
            previous.replace(host)
        elif not host.exists():
            raise RuntimeError("旧主目录备份缺失，已保留激活日志等待人工恢复")
    else:
        new_host = moved.get("newHost")
        if new_host is True or (new_host == "moving" and not staging.exists()):
            _remove_path(host)
        elif not journal.get("upgrade"):
            _remove_path(host)
    old_venv = moved.get("oldVenv")
    if _rename_happened(old_venv, backup / "venv"):
        previous = backup / "venv"
        if previous.exists():
            _remove_path(environment)
            previous.replace(environment)
        elif not environment.exists():
            raise RuntimeError("旧运行环境备份缺失，已保留激活日志等待人工恢复")
    else:
        new_venv = moved.get("newVenv")
        if new_venv is True or (new_venv == "moving" and not staging.exists()):
            _remove_path(environment)
        elif not journal.get("upgrade"):
            _remove_path(environment)
    for name, entry in (journal.get("metadata") or {}).items():
        live = runtime / name
        previous = backup / name
        if _rename_happened(entry.get("oldMoved"), previous):
            if previous.exists():
                _remove_path(live)
                previous.replace(live)
            elif not live.exists() and entry.get("existed"):
                raise RuntimeError("旧安装元数据备份缺失，已保留激活日志等待人工恢复")
        else:
            new_state = entry.get("newMoved")
            candidate = staging / name
            if new_state is True or (new_state == "moving" and not candidate.exists()):
                _remove_path(live)
    staging = Path(journal.get("staging", ""))
    if staging.exists() and staging != runtime:
        _remove_path(staging)
    _cleanup_transaction(runtime, journal)


def _recover_activation(runtime):
    """Resolve a crashed activation before any new host/staging tree is built."""
    journal = _read_journal(runtime)
    if not journal:
        return False
    # An "activated" journal without an explicit commit means the previous
    # process stopped before the setup call returned, so no user write could
    # have been accepted yet. Restore the retained generation.
    if journal.get("phase") in ("activating", "activated"):
        _rollback_journal(runtime, journal)
        return True
    if journal.get("phase") in ("committed", "finalizing"):
        # The new generation is already committed. Never replace it with a
        # half-deleted previous generation; only finish the cleanup.
        return _finalize_activation(runtime)
    (runtime / _ACTIVATION).unlink(missing_ok=True)
    return False


def _finalize_activation(runtime):
    """Commit the new generation, then reentrantly drop the old one."""
    journal = _read_journal(runtime)
    if not journal:
        return False
    phase = journal.get("phase")
    if phase == "activating":
        return False
    if phase not in ("activated", "committed", "finalizing"):
        return False
    if phase != "committed":
        journal["phase"] = "committed"
        _write_journal(runtime, journal)
    _cleanup_transaction(runtime, journal, strict=True)
    return True


def rollback_activation(runtime):
    """Explicitly restore the generation retained by the last activation."""
    journal = _read_journal(runtime)
    if not journal or journal.get("phase") in ("committed", "finalizing"):
        return False
    _rollback_journal(runtime, journal)
    return True


def _rewrite_venv_paths(environment, old_environment):
    """Make relocated console-script shebangs point at the live environment."""
    old = str(old_environment).encode("utf-8")
    new = str(environment).encode("utf-8")
    if old == new:
        return
    for directory in ("bin", "Scripts"):
        root = environment / directory
        if not root.is_dir():
            continue
        for path in root.iterdir():
            if not path.is_file() or path.is_symlink() or path.stat().st_size > 1024**2:
                continue
            try:
                data = path.read_bytes()
            except OSError:
                continue
            if old in data:
                path.write_bytes(data.replace(old, new))
                path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _post_activation_verify(source, runtime, host, environment, env):
    script = """
import importlib.metadata as metadata, json, os, pathlib, sqlite3, sys
root = pathlib.Path(os.environ["ASTRBOT_ROOT"])
payload = {"dswhale": metadata.version("dswhale"), "astrbot": metadata.version("astrbot"), "db": "absent", "plugins": True}
database = root / "data/data.db"
if database.is_file():
    connection = sqlite3.connect(database)
    try:
        payload["db"] = connection.execute("PRAGMA integrity_check").fetchone()[0]
        payload["tables"] = connection.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
    finally:
        connection.close()
for plugin in ("astrbot_plugin_dswhale", "astrbot_plugin_livingmemory"):
    main = root / "data/plugins" / plugin / "main.py"
    if not main.is_file():
        payload["plugins"] = False
        continue
    compile(main.read_text(encoding="utf-8"), str(main), "exec")
payload["module"] = bool(__import__("astrbot"))
print(json.dumps(payload))
"""
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file() or not os.access(python, os.X_OK):
        raise RuntimeError("激活后自检失败：运行环境不可执行")
    data = json.loads(output([python, "-c", script], cwd=host, env=env))
    project = (source / "pyproject.toml").read_text(encoding="utf-8")
    version = re.search(r'^version\s*=\s*"([^"]+)"', project, re.MULTILINE)[1]
    matrix = runtime_lock_matrix()
    if data.get("dswhale") != version or data.get("astrbot") != matrix["astrbot"]:
        raise RuntimeError("激活后自检失败：版本与运行时锁不一致")
    if data.get("db") not in ("absent", "ok") or not data.get("plugins") or not data.get("module"):
        raise RuntimeError("激活后自检失败：数据库、插件或 AstrBot 模块不可用")
    console = environment / ("Scripts/dswhale.exe" if os.name == "nt" else "bin/dswhale")
    if console.is_file() and os.access(console, os.X_OK):
        output([console, "--help"], cwd=host, env=env)
    return data


def _activate(runtime, host, staging, staging_host, staging_venv, upgrade):
    """Journaled swap of a validated staging generation into the live paths."""
    environment = runtime / "venv"
    txid = datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(8)
    transaction = runtime / "transactions" / txid
    backup = transaction / "previous"
    backup.mkdir(parents=True)
    journal = {
        "format": 1,
        "txid": txid,
        "phase": "activating",
        "upgrade": bool(upgrade),
        "backup": str(backup),
        "staging": str(staging),
        "moved": {
            "oldHost": False,
            "newHost": False,
            "oldVenv": False,
            "newVenv": False,
        },
        "metadata": {},
    }
    _write_journal(runtime, journal)

    def checkpoint():
        _write_journal(runtime, journal)

    try:
        if environment.exists():
            journal["moved"]["oldVenv"] = "moving"
            checkpoint()
            environment.replace(backup / "venv")
            journal["moved"]["oldVenv"] = True
            checkpoint()
        journal["moved"]["newVenv"] = "moving"
        checkpoint()
        staging_venv.replace(environment)
        journal["moved"]["newVenv"] = True
        checkpoint()
        if host.exists():
            journal["moved"]["oldHost"] = "moving"
            checkpoint()
            host.replace(backup / "host")
            journal["moved"]["oldHost"] = True
            checkpoint()
        journal["moved"]["newHost"] = "moving"
        checkpoint()
        staging_host.replace(host)
        journal["moved"]["newHost"] = True
        checkpoint()
        for name in _GENERATION_FILES:
            candidate = staging / name
            entry = {
                "existed": (runtime / name).exists(),
                "action": "install"
                if candidate.is_file()
                else "delete"
                if name == ".desktop-auth.pending.json"
                else "none",
                "oldMoved": False,
                "newMoved": False,
            }
            journal["metadata"][name] = entry
            checkpoint()
            if entry["existed"]:
                entry["oldMoved"] = "moving"
                checkpoint()
                (runtime / name).replace(backup / name)
                entry["oldMoved"] = True
                checkpoint()
            if entry["action"] == "install":
                entry["newMoved"] = "moving"
                checkpoint()
                candidate.replace(runtime / name)
                entry["newMoved"] = True
                checkpoint()
            elif entry["action"] == "delete":
                entry["newMoved"] = "moving"
                checkpoint()
                (runtime / name).unlink(missing_ok=True)
                entry["newMoved"] = True
                checkpoint()
        _rewrite_venv_paths(environment, staging_venv)
        journal["phase"] = "activated"
        checkpoint()
    except BaseException:
        try:
            _rollback_journal(runtime, journal)
        except BaseException:
            # Keep the journal for the next entry to retry; never hide the
            # original activation failure behind a second recovery failure.
            pass
        raise
    # The transaction backup stays until the installed runtime has actually
    # started; cleanup is an explicit finalize step, not part of the swap.
    _remove_path(staging)
    try:
        staging.parent.rmdir()
    except OSError:
        pass


def _record_upstream_observation(source, runtime):
    """Bounded, non-fatal observation before an installed upgrade.

    The validated runtime lock stays authoritative. Offline or a newer stable
    core is recorded for the desktop status page instead of changing the lock
    or aborting an otherwise valid install.
    """
    if os.environ.get("DSWHALE_DESKTOP") != "1" or os.environ.get("DSWHALE_SKIP_UPSTREAM") == "1":
        return None
    script = Path(source) / "scripts/check_upstream_core.py"
    lock = Path(source) / "runtime-lock.json"
    if not script.is_file() or not lock.is_file():
        return None
    try:
        spec = spec_from_file_location("dswhale_upstream_observer", script)
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        observation = module.observe(lock, timeout=3.0)
    except BaseException as error:  # Network/parser failures must not block upgrade.
        observation = {
            "status": "offline",
            "locked": None,
            "latestStable": None,
            "latestAny": None,
            "checkedAt": None,
            "source": None,
            "detail": f"upstream observation unavailable: {type(error).__name__}",
        }
    target = Path(runtime) / "upstream-core-observation.json"
    target.write_text(json.dumps(observation, ensure_ascii=False, indent=2), encoding="utf-8")
    print("DSWHALE_UPSTREAM " + json.dumps(observation, ensure_ascii=False), flush=True)
    return observation


def prepare(source, runtime):
    runtime.mkdir(parents=True, exist_ok=True)
    with FileLock(runtime / "host-lifecycle.lock", timeout=0):
        # Older hosts only hold the upstream lock. Reject them before recovery
        # can rename any generation, then keep the stable gate through commit.
        host = runtime / "astrbot"
        if host.exists():
            with FileLock(host / "astrbot.lock", timeout=0):
                pass
        _prepare(source, runtime)


def _prepare(source, runtime):
    # A previous process may have exited between any two activation renames.
    # Resolve that journal before creating a fresh host or staging tree.
    _recover_activation(runtime)
    _record_upstream_observation(source, runtime)
    host = runtime / "astrbot"
    host.mkdir(parents=True, exist_ok=True)
    uv = os.environ.get("DSWHALE_UV") or shutil.which("uv")
    if not uv:
        raise SystemExit("请从桌面应用或项目根目录的 Install 启动安装。")
    env = {
        **_network.network_environment(_network.read_network_config(runtime)),
        "PYTHONUTF8": "1",
        "DSWHALE_RUNTIME_DIR": str(runtime),
        "DSWHALE_NETWORK_CONFIG": str(runtime / "network.json"),
        "ASTRBOT_ROOT": str(host),
        "UV_PYTHON_INSTALL_DIR": str(runtime / "tools/python"),
        "UV_CACHE_DIR": str(runtime / "cache/uv"),
        "UV_TOOL_DIR": str(runtime / "tools/uv-tools"),
        "UV_NO_MODIFY_PATH": "1",
    }
    lock = FileLock(host / "astrbot.lock", timeout=0)
    lock.acquire()
    try:
        upgrade = (host / "data").exists()
        revision = _config_revision(host) if upgrade else None
        if upgrade:
            progress("backup", 0.16)
            snapshot_data(host, runtime)
        build_id = datetime.now().strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(6)
        staging = runtime / "staging" / build_id
        staging_host = staging / "host"
        staging_venv = staging / "venv"
        staging.mkdir(parents=True)
        for name in ("desktop-auth.json", ".desktop-auth.pending.json"):
            source_file = runtime / name
            if source_file.is_file():
                shutil.copy2(source_file, staging / name)
        try:
            if upgrade:
                shutil.copytree(
                    host,
                    staging_host,
                    ignore=shutil.ignore_patterns("astrbot.lock", "*.lock", "*.sock"),
                )
            else:
                staging_host.mkdir()
            staging_python = staging_venv / (
                "Scripts/python.exe" if os.name == "nt" else "bin/python"
            )
            staging_env = {
                **env,
                "ASTRBOT_ROOT": str(staging_host),
                "DSWHALE_STAGING": "1",
                "DSWHALE_DESKTOP": os.environ.get("DSWHALE_DESKTOP", ""),
            }
            progress("python", 0.2)
            compatible = False
            if staging_python.exists():
                try:
                    compatible = bool(
                        re.fullmatch(
                            r"Python 3\.12\.\d+", output([staging_python, "--version"]).strip()
                        )
                    )
                except (OSError, subprocess.SubprocessError):
                    pass
            if not compatible:
                run([uv, "venv", "--python", "3.12", "--clear", staging_venv], env=staging_env)
            progress("dependencies", 0.28)
            cache = runtime / "cache"
            cache.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="backend-build-", dir=cache) as directory:
                build_source = Path(directory) / "source"
                shutil.copytree(
                    source,
                    build_source,
                    ignore=shutil.ignore_patterns(
                        ".runtime",
                        ".private",
                        ".git",
                        ".superpowers",
                        "node_modules",
                        "__pycache__",
                        ".pytest_cache",
                        ".ruff_cache",
                        "desktop-dist",
                        "desktop-resources",
                        "build",
                        "dist",
                        "*.egg-info",
                        ".venv",
                    ),
                )
                run(
                    [
                        uv,
                        "pip",
                        "install",
                        "--python",
                        staging_python,
                        str(build_source) + "[host]",
                    ],
                    env=staging_env,
                )
            progress("node", 0.52)
            node = (
                output(
                    [
                        staging_python,
                        "-c",
                        network_command(
                            "from pathlib import Path; from dswhale.runtime import ensure_node; import sys; print(ensure_node(Path(sys.argv[1])))"
                        ),
                        runtime,
                    ],
                    cwd=staging_host,
                    env=staging_env,
                )
                .strip()
                .splitlines()[-1]
            )
            progress("media", 0.66)
            media = json.loads(
                output(
                    [
                        staging_python,
                        "-c",
                        network_command(
                            "from pathlib import Path; from dswhale.media_runtime import ensure_media; import sys,json; print(json.dumps({k:str(v) for k,v in ensure_media(Path(sys.argv[1])).items()}))"
                        ),
                        runtime,
                    ],
                    cwd=staging_host,
                    env=staging_env,
                )
                .strip()
                .splitlines()[-1]
            )
            settings = {"node": node, "ffmpeg": media["ffmpeg"], "ffprobe": media["ffprobe"]}
            temporary = staging / "tool-env.json"
            temporary.write_text(json.dumps(settings, ensure_ascii=False), encoding="utf-8")
            staging_env.update(
                {
                    "DSWHALE_NODE": node,
                    "PATH": os.pathsep.join(
                        [
                            *dict.fromkeys(str(Path(value).parent) for value in settings.values()),
                            staging_env.get("PATH", ""),
                        ]
                    ),
                }
            )
            if not (staging_host / "data/cmd_config.json").is_file():
                progress("initialize", 0.76)
                run(
                    [staging_python, "-m", "astrbot.cli", "init", "--yes"],
                    cwd=staging_host,
                    env=staging_env,
                )
            if os.environ.get("DSWHALE_DESKTOP") == "1":
                initialize_host_config(
                    staging_host, staging_python, staging_env, desktop=True, migrate=False
                )
            progress("plugins", 0.82)
            if os.environ.get("DSWHALE_DESKTOP") == "1":
                migrate_desktop_settings(staging_host, staging_python, staging_env)
            run(
                [
                    staging_python,
                    "-m",
                    "dswhale",
                    "install",
                    "--astrbot-dir",
                    staging_host,
                    "--with-memory",
                    "--node",
                    node,
                ],
                cwd=staging_host,
                env=staging_env,
            )
            if os.environ.get("DSWHALE_DESKTOP") == "1":
                verify_desktop_settings(staging_host, staging_python, staging_env)
            run(
                [
                    uv,
                    "pip",
                    "install",
                    "--python",
                    staging_python,
                    "-r",
                    staging_host / "data/plugins/astrbot_plugin_livingmemory/requirements.txt",
                ],
                env=staging_env,
            )
            project = (source / "pyproject.toml").read_text(encoding="utf-8")
            version = re.search(r'^version\s*=\s*"([^"]+)"', project, re.MULTILINE)[1]
            receipt = staging / "desktop-install.json"
            receipt.write_text(
                json.dumps(
                    runtime_receipt(version, staging_python, node, media["ffmpeg"], staging_env)
                ),
                encoding="utf-8",
            )
            _staged_verify(source, staging, staging_host, staging_python, staging_env)
            if upgrade and _config_revision(host) != revision:
                raise RuntimeError("升级准备期间原配置发生变化，已停止激活并保留原环境")
            progress("activate", 0.92)
            # Windows cannot rename a tree containing an open lock file.
            # The stable lifecycle gate still excludes every managed host start.
            lock.release()
            _activate(runtime, host, staging, staging_host, staging_venv, upgrade)
            try:
                _post_activation_verify(source, runtime, host, runtime / "venv", env)
            except BaseException:
                rollback_activation(runtime)
                raise
            # Commit while the setup call is still on the stack. The UI cannot
            # accept any user write before prepare() returns, so this is the
            # safe boundary to stop treating a later cold-start failure as a
            # reason to discard the newly saved settings.
            if not _finalize_activation(runtime):
                raise RuntimeError("激活提交失败：无法完成旧版清理")
            progress("complete", 0.99)
        except BaseException:
            if staging.exists():
                failed = runtime / "staging-failed" / build_id
                failed.parent.mkdir(parents=True, exist_ok=True)
                staging.replace(failed)
            raise
    finally:
        if lock.is_locked:
            lock.release()
    print("环境准备完成。请从桌面应用或项目根目录 Start 启动。")
    print("QQ 登录、模型密钥和 B站扫码需要本人操作，请按设置说明配置。")


if __name__ == "__main__":
    main()

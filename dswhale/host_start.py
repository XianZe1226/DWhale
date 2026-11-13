"""Run the managed host under the stable installation lifecycle gate."""

import argparse
import json
import os
import runpy
import sys
from pathlib import Path

from filelock import FileLock, Timeout

# A desktop bundle may launch this file with an older installed DSWhale package.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dswhale.desktop_settings import migrate_settings  # noqa: E402


def run_host(runtime, *, environment=None):
    runtime = Path(runtime).resolve()
    host = runtime / "astrbot"
    with FileLock(runtime / "host-lifecycle.lock", timeout=0):
        journal_file = runtime / "activation.json"
        if journal_file.exists():
            try:
                journal = json.loads(journal_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                raise SystemExit("运行环境准备尚未完成，请先重新准备环境") from None
            if not isinstance(journal, dict) or journal.get("phase") not in {"committed", "finalizing"}:
                raise SystemExit("运行环境准备尚未完成，请先重新准备环境")
        previous_argv = sys.argv
        previous_directory = Path.cwd()
        previous_environment = os.environ.copy()
        try:
            if environment is not None:
                os.environ.clear()
                os.environ.update(environment)
            os.environ.update(DSWHALE_RUNTIME_DIR=str(runtime), ASTRBOT_ROOT=str(host))
            migrate_settings(host)
            os.chdir(host)
            sys.argv = ["astrbot.cli", "run"]
            # The host shares this process and cannot outlive its lifecycle lock.
            runpy.run_module("astrbot.cli", run_name="__main__")
            return 0
        finally:
            sys.argv = previous_argv
            os.chdir(previous_directory)
            os.environ.clear()
            os.environ.update(previous_environment)


def main(argv=None):
    parser = argparse.ArgumentParser(description="启动已安装的对话服务")
    parser.add_argument("--runtime", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        return run_host(args.runtime)
    except Timeout:
        raise SystemExit("环境正在准备或服务已运行，请稍后重试") from None


if __name__ == "__main__":
    raise SystemExit(main())

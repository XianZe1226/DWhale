"""Shared source launcher, honoring desktop's explicit private runtime path."""

import os
import subprocess
import sys
from pathlib import Path

# Source launchers may run inside an older installed venv. Load this checkout's
# safety policy before considering any host start.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dswhale.desktop_settings import migrate_settings  # noqa: E402
from dswhale.runtime import launch_environment  # noqa: E402


def main():
    runtime = Path(os.environ.get("DSWHALE_RUNTIME_DIR", str(ROOT / ".runtime")))
    env = launch_environment(runtime)
    host = Path(env["ASTRBOT_ROOT"])
    if "--bili" not in sys.argv:
        migrate_settings(host)
    args = (
        ["dswhale", "bili-open", "--astrbot-dir", str(host)]
        if "--bili" in sys.argv
        else ["astrbot.cli", "run"]
    )
    return subprocess.call([sys.executable, "-m", *args], cwd=host, env=env)


if __name__ == "__main__":
    raise SystemExit(main())

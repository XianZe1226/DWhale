"""A single release identity must reach every install and version consumer."""

import json
import re
import tomllib
from pathlib import Path

from packaging.version import Version

from dswhale import __version__

ROOT = Path(__file__).resolve().parents[1]


def test_python_desktop_plugin_lock_and_preview_versions_agree():
    expected = Version(tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"])
    package = json.loads((ROOT / "package.json").read_text())
    lock = json.loads((ROOT / "package-lock.json").read_text())
    metadata = re.search(r"^version: (.+)$", (ROOT / "metadata.yaml").read_text(), re.M)
    preview = re.search(r"merge\(\{ version: '([^']+)'", (ROOT / "desktop/ui/model.js").read_text())
    values = {
        "Python CLI": __version__,
        "desktop": package["version"],
        "npm lock": lock["version"],
        "npm package": lock["packages"][""]["version"],
        "plugin": metadata[1],
        "preview": preview[1],
    }
    assert {name: value for name, value in values.items() if Version(value) != expected} == {}

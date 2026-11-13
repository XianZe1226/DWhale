"""Official stable-core observation without touching the network."""

import json
from pathlib import Path

import pytest

from scripts.check_upstream_core import UpstreamError, observe


def lock_file(tmp_path, version="4.29.4"):
    path = tmp_path / "runtime-lock.json"
    path.write_text(
        json.dumps(
            {
                "format": 1,
                "product": "DWhale",
                "verifiedAt": "2026-11-08",
                "source": "https://pypi.org/project/astrbot/4.29.4/",
                "runtime": {
                    "astrbot": version,
                    "python": "3.12",
                    "node": "22.23.4",
                    "ffmpeg": "9.0.2",
                },
                "legacy": {
                    "astrbot": "4.29.3",
                    "python": "3.12",
                    "node": "22.23.4",
                    "ffmpeg": "9.0.2",
                },
            }
        )
    )
    return path


def payload(*releases):
    values = {}
    for version, kind in releases:
        files = []
        if kind == "wheel":
            files = [
                {
                    "packagetype": "bdist_wheel",
                    "url": f"https://files/{version}.whl",
                    "yanked": False,
                }
            ]
        elif kind == "sdist":
            files = [
                {"packagetype": "sdist", "url": f"https://files/{version}.tar.gz", "yanked": False}
            ]
        elif kind == "yanked":
            files = [
                {
                    "packagetype": "bdist_wheel",
                    "url": f"https://files/{version}.whl",
                    "yanked": True,
                }
            ]
        values[version] = files
    return {"info": {"version": releases[-1][0] if releases else ""}, "releases": values}


def fake(version_payload):
    return lambda url, timeout: version_payload


def test_locked_core_matches_latest_stable(tmp_path):
    result = observe(
        lock_file(tmp_path), fetch=fake(payload(("4.29.3", "wheel"), ("4.29.4", "sdist")))
    )
    assert result["status"] == "current"
    assert result["latestStable"] == "4.29.4"
    assert result["locked"] == "4.29.4"


def test_newer_installable_stable_is_reported(tmp_path):
    result = observe(
        lock_file(tmp_path), fetch=fake(payload(("4.29.4", "wheel"), ("4.30.0", "wheel")))
    )
    assert result["status"] == "newer"
    assert result["latestStable"] == "4.30.0"


def test_prerelease_yanked_and_empty_files_are_not_installable(tmp_path):
    result = observe(
        lock_file(tmp_path),
        fetch=fake(payload(("4.29.4", "wheel"), ("4.30.0", "yanked"), ("5.0.0", "none"))),
    )
    assert result["status"] == "current"
    assert result["latestStable"] == "4.29.4"
    assert result["latestAny"] == "5.0.0"


def test_prerelease_only_is_not_a_stable_target(tmp_path):
    result = observe(
        lock_file(tmp_path), fetch=fake(payload(("4.29.4", "wheel"), ("4.30.0a1", "wheel")))
    )
    assert result["status"] == "current"


def test_offline_keeps_the_locked_core_and_is_truthful(tmp_path):
    def offline(url, timeout):
        raise OSError("network disabled")

    result = observe(lock_file(tmp_path), fetch=offline)
    assert result["status"] == "offline"
    assert result["locked"] == "4.29.4"
    assert result["latestStable"] is None


def test_invalid_lock_and_invalid_metadata_are_rejected(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    with pytest.raises(UpstreamError):
        observe(bad, fetch=fake(payload(("4.29.4", "wheel"))))
    unstable = lock_file(tmp_path, "4.29.4a1")
    with pytest.raises(UpstreamError):
        observe(unstable, fetch=fake(payload(("4.29.4", "wheel"))))
    assert observe(lock_file(tmp_path), fetch=fake({"releases": {}}))["status"] == "no-stable"


def test_cli_writes_observation_and_fails_only_on_newer(tmp_path, monkeypatch):
    import json

    import scripts.check_upstream_core as check

    result = {
        "status": "newer",
        "locked": "4.29.4",
        "latestStable": "4.29.5",
        "latestAny": "4.29.5",
        "checkedAt": "2026-11-09T00:00:00Z",
        "source": "https://pypi.org/pypi/astrbot/json",
        "detail": "newer stable",
    }
    monkeypatch.setattr(check, "observe", lambda *args, **kwargs: result)
    output = tmp_path / "observation.json"
    assert (
        check.main(
            [
                "--lock",
                str(tmp_path / "runtime-lock.json"),
                "--json-out",
                str(output),
                "--fail-on-newer",
            ]
        )
        == 3
    )
    assert json.loads(output.read_text())["status"] == "newer"
    assert check.main(["--lock", str(tmp_path / "runtime-lock.json")]) == 0


def test_release_workflows_observe_upstream_before_building():
    root = Path(__file__).resolve().parents[1]
    desktop = (root / ".github/workflows/desktop.yml").read_text(encoding="utf-8")
    ci = (root / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    assert desktop.index("check_upstream_core.py") < desktop.index("npm run dist")
    assert ci.index("check_upstream_core.py") < ci.index("scripts.build_release")

"""Offline regressions for official-only migration and identity isolation."""

import copy
import json
from pathlib import Path

import pytest

from dswhale.config import Settings
from dswhale.config_migrations import plan_migration
from dswhale.desktop_settings import migrate_settings, read_settings, save_settings
from dswhale.qq_routing import resolve_binding


def legacy_documents():
    return {
        "config": {
            "platform": [
                {"id": "old", "type": "aiocqhttp", "enable": True, "unknown": 0},
                {
                    "id": "official",
                    "type": "qq_official",
                    "enable": True,
                    "appid": "synthetic",
                    "secret": "synthetic",
                },
            ],
            "provider": [{"enable": False}],
            "persona": {"custom": []},
        },
        "fish": {
            "owner_qq": "123456",
            "owner_umo": "old:FriendMessage:123456",
            "qq_connection_mode": "napcat",
            "qq_default_delivery": "napcat",
            "official_owner_umo": "official:FriendMessage:Open_ID",
            "daily_limit": 0,
            "unknown": {"empty": "", "false": False},
        },
    }


def test_migration_disables_legacy_and_preserves_unrelated_data():
    original = legacy_documents()
    before = copy.deepcopy(original)
    after, changes = plan_migration(original)
    assert after["config"]["platform"][0]["enable"] is False
    assert after["config"]["platform"][1] == before["config"]["platform"][1]
    assert after["config"]["provider"] == before["config"]["provider"]
    assert after["config"]["persona"] == before["config"]["persona"]
    assert after["fish"]["unknown"] == before["fish"]["unknown"]
    assert after["fish"]["daily_limit"] == 0
    assert after["fish"]["qq_connection_mode"] == "official"
    assert after["fish"]["qq_default_delivery"] == "official"
    assert original == before
    assert changes
    assert not plan_migration(after)[1]


def test_fresh_settings_and_legacy_settings_authorize_only_official():
    assert Settings().qq_connection_mode == "official"
    assert Settings().qq_default_delivery == "official"
    settings = Settings.from_mapping(legacy_documents()["fish"])
    assert settings.owner_scope == "official:FriendMessage:Open_ID"
    assert not settings.binding_for(
        "123456", "old:FriendMessage:123456", private=True, platform_type="aiocqhttp"
    )
    assert resolve_binding(settings.owner_bindings, "old:FriendMessage:123456") is None
    assert settings.binding_for(
        "Open_ID", settings.owner_scope, private=True, platform_type="qq_official"
    )


def test_file_migration_backs_up_both_documents_even_without_plugin_config(tmp_path):
    config = tmp_path / "data/cmd_config.json"
    config.parent.mkdir()
    original = legacy_documents()["config"]
    config.write_text(json.dumps(original))
    assert migrate_settings(tmp_path)["changed"]
    assert json.loads(config.read_text())["platform"][0]["enable"] is False
    backups = list((tmp_path / ".desktop-settings-backups").glob("*/*"))
    assert any(json.loads(p.read_text()) == original for p in backups)
    assert read_settings(tmp_path)["qqConnectionMode"] == "official"


@pytest.mark.parametrize(
    "patch",
    [
        {"qqConnectionMode": "napcat"},
        {"ownerQQ": "123456"},
        {"onebotToken": "synthetic"},
        {"defaultDelivery": "napcat"},
        {"signatureEnabled": True},
        {"qzoneEnabled": True},
    ],
)
def test_settings_reject_legacy_creation(tmp_path, patch):
    config = tmp_path / "data/cmd_config.json"
    config.parent.mkdir()
    config.write_text('{"platform": []}')
    with pytest.raises(ValueError):
        save_settings(tmp_path, patch)
    assert json.loads(config.read_text()) == {"platform": []}


def test_removed_modules_and_native_launcher_are_absent():
    root = Path(__file__).parents[1]
    for relative in (
        "dswhale/napcat_install.py",
        "dswhale/social.py",
        "scripts/start-qq-native.command",
    ):
        assert not (root / relative).exists()


def test_install_disables_existing_legacy_platform_with_private_backup(tmp_path):
    from dswhale.install import install_plugin

    config = tmp_path / "data/cmd_config.json"
    config.parent.mkdir()
    original = legacy_documents()["config"]
    config.write_text(json.dumps(original))
    install_plugin(tmp_path)
    assert json.loads(config.read_text())["platform"][0]["enable"] is False
    assert any(
        json.loads(p.read_text()) == original
        for p in (tmp_path / ".desktop-settings-backups").glob("*/*")
    )


def test_restore_without_host_configuration_keeps_sdk_initialization_available(tmp_path):
    from dswhale.install import backup, restore

    host = tmp_path / "host"
    (host / "data").mkdir(parents=True)
    (host / "data/memory.bin").write_bytes(b"synthetic-memory")
    archive = tmp_path / "snapshot.zip"
    backup(host, archive)
    restore(host, archive)
    assert not (host / "data/cmd_config.json").exists()
    assert (host / "data/memory.bin").read_bytes() == b"synthetic-memory"


def test_current_version_reactivated_legacy_platform_is_disabled_again():
    migrated, _ = plan_migration(legacy_documents())
    migrated["config"]["platform"][0]["enable"] = True
    after, changes = plan_migration(migrated)
    assert after["config"]["platform"][0]["enable"] is False
    assert changes == [
        {"file": "config", "field": "platform[0].enable", "action": "disable_legacy"}
    ]


def test_two_document_migration_rolls_back_when_second_write_fails(tmp_path, monkeypatch):
    config = tmp_path / "data/cmd_config.json"
    fish = tmp_path / "data/config/astrbot_plugin_dswhale_config.json"
    fish.parent.mkdir(parents=True)
    original = legacy_documents()
    config.write_text(json.dumps(original["config"]))
    fish.write_text(json.dumps(original["fish"]))
    before = (config.read_bytes(), fish.read_bytes())
    replace = Path.replace

    def fail_second_write(path, target):
        if Path(target) == fish and path.suffix == ".tmp":
            raise OSError("synthetic failure")
        return replace(path, target)

    monkeypatch.setattr(Path, "replace", fail_second_write)
    with pytest.raises(OSError):
        migrate_settings(tmp_path)
    assert (config.read_bytes(), fish.read_bytes()) == before


def test_restore_disables_legacy_before_exposing_restored_data(tmp_path):
    from dswhale.install import backup, restore

    host = tmp_path / "host"
    config = host / "data/cmd_config.json"
    fish = host / "data/config/astrbot_plugin_dswhale_config.json"
    fish.parent.mkdir(parents=True)
    original = legacy_documents()
    config.write_text(json.dumps(original["config"]))
    fish.write_text(json.dumps(original["fish"]))
    archive = tmp_path / "snapshot.zip"
    backup(host, archive)
    restore(host, archive)
    assert json.loads(config.read_text())["platform"][0]["enable"] is False
    assert json.loads(fish.read_text())["unknown"] == original["fish"]["unknown"]
    assert json.loads(fish.read_text())["qq_connection_mode"] == "official"


@pytest.mark.parametrize(
    "flags",
    [
        {"proactive_enabled": True},
        {"bili_enabled": True},
        {"proactive_enabled": True, "bili_enabled": True},
    ],
)
async def test_migrated_personal_only_enabled_flags_allow_official_binding_setup(
    tmp_path, monkeypatch, flags
):
    from datetime import datetime
    from unittest.mock import Mock
    from zoneinfo import ZoneInfo

    from test_plugin import Host, event

    import main as plugin_module
    from dswhale.qq_identity import confirmed_c2c_scope

    documents = legacy_documents()
    documents["fish"].pop("official_owner_umo")
    documents["fish"].update(flags)
    migrated, _ = plan_migration(documents)
    settings = Settings.from_mapping(migrated["fish"])
    for key, value in flags.items():
        assert getattr(settings, key) is value
    assert settings.delivery_binding is None
    monkeypatch.setattr(plugin_module.StarTools, "get_data_dir", lambda _name: tmp_path)
    monkeypatch.setattr(plugin_module, "install_persona_time_compat", lambda: None)
    service_factory = Mock(side_effect=AssertionError("unbound setup must remain offline"))
    monkeypatch.setattr("dswhale.bili.BiliService", service_factory)
    host = Host()
    plugin = plugin_module.DSWhale(host, migrated["fish"])
    try:
        human = event(host)
        replies = [reply async for reply in plugin.whoami(human)]
        assert replies
        assert confirmed_c2c_scope(tmp_path, human.unified_msg_origin)
        now = datetime(2026, 11, 12, 12, tzinfo=ZoneInfo("Asia/Shanghai"))
        assert plugin.companion.scheduler.reserve(now, external_kind="bili-watch") is None
        await plugin.companion.tick(now)
        await plugin.companion.start_bili()
        assert host.queue.empty()
        assert plugin.companion.bili is None
        service_factory.assert_not_called()
        assert (
            plugin.companion.store.db.execute("SELECT COUNT(*) FROM activities").fetchone()[0] == 0
        )
    finally:
        await plugin.terminate()

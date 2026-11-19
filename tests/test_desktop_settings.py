import json

import pytest
from filelock import FileLock


def host_files(tmp_path):
    host = tmp_path / "中文 空格"
    data = host / "data"
    (data / "config").mkdir(parents=True)
    (data / "cmd_config.json").write_text(
        json.dumps(
            {
                "dashboard": {"port": 6185},
                "platform": [],
                "provider": [{"id": "retain", "model": "cloud", "enable": True}],
                "provider_sources": [{"api_key": "test-only-secret"}],
                "admins_id": [],
            }
        ),
        encoding="utf-8",
    )
    (data / "config/astrbot_plugin_dswhale_config.json").write_text(
        json.dumps({"persona": "a custom private persona", "owner_qq": "", "owner_umo": ""}),
        encoding="utf-8",
    )
    return host


def test_dashboard_port_can_change_without_overwriting_existing_private_settings(tmp_path):
    from dswhale.desktop_settings import read_settings, save_settings

    host = host_files(tmp_path)
    save_settings(host, {"dashboardPort": 6285})
    assert read_settings(host)["dashboardPort"] == 6285
    config = json.loads((host / "data/cmd_config.json").read_text())
    assert config["dashboard"]["port"] == 6285
    assert config["provider_sources"][0]["api_key"] == "test-only-secret"
    save_settings(host, {"dashboardPort": 6199})
    assert read_settings(host)["dashboardPort"] == 6199


def test_save_preserves_models_persona_and_rejects_onebot(tmp_path):
    from dswhale.desktop_settings import save_settings

    host = host_files(tmp_path)
    files = [host / "data/cmd_config.json", host / "data/config/astrbot_plugin_dswhale_config.json"]
    before = [p.read_bytes() for p in files]
    with pytest.raises(ValueError):
        save_settings(host, {"ownerQQ": "123456789", "onebotPort": 6199})
    assert [p.read_bytes() for p in files] == before


def test_settings_refuse_running_host_and_invalid_input(tmp_path):
    from dswhale.desktop_settings import save_settings

    host = host_files(tmp_path)
    before = (host / "data/cmd_config.json").read_bytes()
    for patch in (
        {"ownerQQ": "not QQ"},
        {"onebotPort": 6185},
        {"platformId": "evil:scope"},
        {"arbitraryCommand": "no"},
    ):
        with pytest.raises(ValueError):
            save_settings(host, patch)
        assert (host / "data/cmd_config.json").read_bytes() == before
    with FileLock(host / "astrbot.lock"), pytest.raises(ValueError, match="停止"):
        save_settings(host, {"dashboardPort": 6285})


def test_setup_status_ignores_legacy_identity_and_secrets(tmp_path):
    from dswhale.desktop_settings import read_settings, setup_status

    host, _, _ = _dual_host(tmp_path)
    value = read_settings(host)
    assert value["napcatBound"] is False and value["napcatConfigured"] is False
    assert value["ownerQQ"] == "" and value["onebotToken"] == ""
    assert value["officialConfigured"] is True
    assert "SYNTHETIC" not in json.dumps(setup_status(host))


@pytest.mark.parametrize("field", ["signatureEnabled", "qzoneEnabled"])
def test_removed_social_permissions_are_rejected(tmp_path, field):
    from dswhale.desktop_settings import save_settings

    host = host_files(tmp_path)
    before = (host / "data/config/astrbot_plugin_dswhale_config.json").read_bytes()
    with pytest.raises(ValueError):
        save_settings(host, {field: True})
    assert (host / "data/config/astrbot_plugin_dswhale_config.json").read_bytes() == before


def test_import_prepares_loopback_and_clears_only_unavailable_tool_paths(tmp_path):
    from dswhale.desktop_settings import prepare_import

    host = host_files(tmp_path)
    config_file = host / "data/cmd_config.json"
    config = json.loads(config_file.read_text())
    config["dashboard"] = {
        "host": "0.0.0.0",
        "port": 6301,
        "ssl": {"enable": True},
        "pbkdf2_password": "keep-password-hash",
    }
    config_file.write_text(json.dumps(config))
    fish_file = host / "data/config/astrbot_plugin_dswhale_config.json"
    fish = json.loads(fish_file.read_text())
    fish.update(
        bili_node_path=str(tmp_path / "old-machine/node"),
        cookies_path=str(tmp_path / "old-machine/cookies.txt"),
    )
    fish_file.write_text(json.dumps(fish))
    prepare_import(host)
    result = json.loads(config_file.read_text())
    assert result["dashboard"]["host"] == "127.0.0.1"
    assert result["dashboard"]["port"] == 6301
    assert result["dashboard"]["ssl"]["enable"] is False
    assert result["dashboard"]["pbkdf2_password"] == "keep-password-hash"
    assert (
        result["provider"] == config["provider"]
        and result["provider_sources"] == config["provider_sources"]
    )
    result = json.loads(fish_file.read_text())
    assert result["bili_node_path"] == result["cookies_path"] == ""
    assert result["persona"] == fish["persona"]


def test_desktop_backup_restores_pending_first_login_on_another_machine(tmp_path):
    import hashlib

    from dswhale.desktop_settings import finish_backup, prepare_backup, prepare_import
    from dswhale.install import backup, restore

    host = host_files(tmp_path / "old-device")
    password, salt = "Synthetic-initial-password-123456789", "11" * 16
    config_file = host / "data/cmd_config.json"
    config = json.loads(config_file.read_text())
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 100000).hex()
    config["dashboard"].update(
        username="astrbot",
        password_change_required=True,
        pbkdf2_password=f"pbkdf2_sha256$100000${salt}${digest}",
    )
    config_file.write_text(json.dumps(config))
    login = {"username": "astrbot", "password": password}
    (host.parent / "desktop-auth.json").write_text(json.dumps(login))
    prepare_backup(host)
    archive = tmp_path / "private-backup.zip"
    backup(host, archive)
    finish_backup(host)
    assert not (host / "data/.dswhale-desktop-login.json").exists()
    new_host = tmp_path / "new-device/host"
    restore(new_host, archive)
    prepare_import(new_host)
    assert json.loads((new_host.parent / "desktop-auth.json").read_text()) == login
    assert not (new_host / "data/.dswhale-desktop-login.json").exists()
    result = json.loads((new_host / "data/cmd_config.json").read_text())
    assert result["dashboard"]["pbkdf2_password"] == config["dashboard"]["pbkdf2_password"]


def test_official_mode_binds_exact_c2c_platform_without_exporting_credentials_or_rewriting_onebot(
    tmp_path,
):
    from dswhale.desktop_settings import read_settings, save_settings, setup_status

    host = tmp_path / "official-host"
    (host / "data/config").mkdir(parents=True)
    bot = {
        "id": "official-test",
        "type": "qq_official",
        "enable": True,
        "appid": "SYNTHETIC-APP-ID",
        "secret": "SYNTHETIC-APP-SECRET",
    }
    legacy = {
        "id": "old-qq",
        "type": "aiocqhttp",
        "enable": True,
        "ws_reverse_port": 6199,
        "ws_reverse_token": "SYNTHETIC-ONEBOT-SECRET",
    }
    cfg = {
        "platform": [legacy, bot],
        "dashboard": {"port": 6185},
        "provider_sources": [{"id": "test-model-source", "key": ["SYNTHETIC-MODEL-KEY"]}],
        "admins_id": ["12345678"],
    }
    fish = {
        "owner_qq": "12345678",
        "owner_umo": "old-qq:FriendMessage:12345678",
        "persona": "SYNTHETIC-PERSONA",
    }
    file = host / "data/cmd_config.json"
    file.write_text(json.dumps(cfg))
    ff = host / "data/config/astrbot_plugin_dswhale_config.json"
    ff.write_text(json.dumps(fish))
    scope = "official-test:FriendMessage:OPAQUE_CaseSensitive_001"
    with pytest.raises(ValueError, match="whoami"):
        save_settings(host, {"qqConnectionMode": "official", "officialOwnerUMO": scope})
    import hashlib

    proof = host / "data/plugin_data/astrbot_plugin_dswhale/official-c2c.json"
    proof.parent.mkdir(parents=True)
    proof.write_text(json.dumps([hashlib.sha256(scope.encode()).hexdigest()]))
    saved = save_settings(host, {"qqConnectionMode": "official", "officialOwnerUMO": scope})
    assert saved["qqConnectionMode"] == "official" and saved["officialOwnerUMO"] == scope
    updated = json.loads(file.read_text())
    f = json.loads(ff.read_text())
    assert updated["platform"][1] == bot and updated["provider_sources"] == cfg["provider_sources"]
    assert (
        f["owner_qq"] == fish["owner_qq"]
        and f["owner_umo"] == fish["owner_umo"]
        and f["persona"] == fish["persona"]
    )
    assert setup_status(host)["ownerConfigured"] is True
    public = json.dumps(read_settings(host))
    for secret in ["SYNTHETIC-APP-ID", "SYNTHETIC-APP-SECRET", "SYNTHETIC-MODEL-KEY"]:
        assert secret not in public
    before = file.read_bytes(), ff.read_bytes()
    for bad in [
        "old-qq:FriendMessage:12345678",
        "official-test:GroupMessage:OPAQUE_CaseSensitive_001",
        "missing:FriendMessage:test",
        "official-test:FriendMessage:UNOBSERVED_GUILD_USER",
    ]:
        with pytest.raises(ValueError):
            save_settings(host, {"officialOwnerUMO": bad})
        assert (file.read_bytes(), ff.read_bytes()) == before


def _host_with_flags(tmp_path):
    host = host_files(tmp_path)
    fish = host / "data/config/astrbot_plugin_dswhale_config.json"
    fish.write_text(
        json.dumps(
            {
                "owner_qq": "123456789",
                "owner_umo": "original:FriendMessage:123456789",
                "official_owner_umo": "official-test:FriendMessage:OPEN_ID",
                "qq_connection_mode": "official",
                "qq_default_delivery": "official",
                "config_migration_version": 2,
                "proactive_enabled": True,
                "bili_enabled": True,
                "qq_signature_enabled": False,
                "qzone_enabled": False,
                "legacy_unknown_field": {"keep": [1, 2]},
            }
        ),
        encoding="utf-8",
    )
    return host


def test_patch_saves_only_supplied_fields_and_never_synthesizes_switches(tmp_path):
    from dswhale.desktop_settings import read_settings, save_settings

    host = _host_with_flags(tmp_path)
    config_file = host / "data/cmd_config.json"
    expected = json.loads(config_file.read_text())
    expected["dashboard"]["port"] = 6285
    save_settings(host, {"dashboardPort": 6285})
    fish = json.loads((host / "data/config/astrbot_plugin_dswhale_config.json").read_text())
    assert fish["proactive_enabled"] and fish["bili_enabled"]
    assert fish["qq_signature_enabled"] is False and fish["qzone_enabled"] is False
    assert fish["legacy_unknown_field"] == {"keep": [1, 2]}
    updated = json.loads(config_file.read_text())
    assert updated == expected
    assert updated["provider_sources"] == [{"api_key": "test-only-secret"}]
    assert read_settings(host)["dashboardPort"] == 6285


def test_identical_or_empty_save_writes_nothing_and_creates_no_backup(tmp_path):
    from dswhale.desktop_settings import read_settings, save_settings

    host = _host_with_flags(tmp_path)
    config = host / "data/cmd_config.json"
    fish = host / "data/config/astrbot_plugin_dswhale_config.json"
    before = (config.read_bytes(), fish.read_bytes())
    assert save_settings(host, {})["dashboardPort"] == 6185
    assert (
        save_settings(host, {"dashboardPort": 6185, "proactiveEnabled": True})["dashboardPort"]
        == 6185
    )
    assert (config.read_bytes(), fish.read_bytes()) == before
    assert not (host / ".desktop-settings-backups").exists()
    assert read_settings(host)["proactiveEnabled"] is True


def test_revision_check_rejects_stale_page_and_accepts_current_revision(tmp_path):
    from dswhale.desktop_settings import read_settings, save_settings

    host = _host_with_flags(tmp_path)
    stale = read_settings(host)["configRevision"]
    config_file = host / "data/cmd_config.json"
    config = json.loads(config_file.read_text())
    config["console_side_change"] = True
    config_file.write_text(json.dumps(config))
    with pytest.raises(ValueError, match="另一处更新"):
        save_settings(host, {"dashboardPort": 6285}, stale)
    assert json.loads(config_file.read_text())["console_side_change"] is True
    current = read_settings(host)["configRevision"]
    save_settings(host, {"dashboardPort": 6285}, current)
    assert read_settings(host)["dashboardPort"] == 6285


def test_invalid_patch_types_and_corrupt_config_are_not_written(tmp_path):
    from dswhale.desktop_settings import save_settings

    host = _host_with_flags(tmp_path)
    config = host / "data/cmd_config.json"
    fish = host / "data/config/astrbot_plugin_dswhale_config.json"
    before = (config.read_bytes(), fish.read_bytes())
    for bad in (
        {"proactiveEnabled": 1},
        {"dashboardPort": "6285"},
        {"ownerQQ": 123456789},
        {"onebotToken": ["secret"]},
        {"unknownField": True},
    ):
        with pytest.raises(ValueError):
            save_settings(host, bad)
        assert (config.read_bytes(), fish.read_bytes()) == before
    fish.write_bytes(b"{corrupt")
    with pytest.raises(ValueError):
        save_settings(host, {"dashboardPort": 6285})
    assert fish.read_bytes() == b"{corrupt"


def test_revision_tracks_document_content(tmp_path):
    from dswhale.desktop_settings import read_settings

    host = _host_with_flags(tmp_path)
    first = read_settings(host)["configRevision"]
    fish = host / "data/config/astrbot_plugin_dswhale_config.json"
    fish.write_bytes(fish.read_bytes() + b" ")
    assert read_settings(host)["configRevision"] != first


def _dual_host(tmp_path):
    host = tmp_path / "双通道 主机"
    (host / "data/config").mkdir(parents=True)
    config = {
        "dashboard": {"port": 6185},
        "platform": [
            {
                "id": "old-qq",
                "type": "aiocqhttp",
                "enable": True,
                "ws_reverse_host": "127.0.0.1",
                "ws_reverse_port": 6199,
                "ws_reverse_token": "SYNTHETIC-ONEBOT-TOKEN",
            },
            {
                "id": "official-test",
                "type": "qq_official",
                "enable": True,
                "appid": "SYNTHETIC-APPID",
                "secret": "SYNTHETIC-SECRET",
            },
        ],
        "provider": [{"id": "model", "model": "cloud-model", "enable": True}],
        "provider_sources": [{"id": "source", "key": ["SYNTHETIC-KEY"]}],
        "admins_id": ["123456789"],
        "unknown_top": {"keep": [1, 2]},
    }
    fish = {
        "owner_qq": "123456789",
        "owner_umo": "old-qq:FriendMessage:123456789",
        "official_owner_umo": "official-test:FriendMessage:OPAQUE_CASE_001",
        "qq_connection_mode": "napcat",
        "persona": "SYNTHETIC-PERSONA",
        "unknown_fish": {"keep": True},
    }
    (host / "data/cmd_config.json").write_text(json.dumps(config), encoding="utf-8")
    (host / "data/config/astrbot_plugin_dswhale_config.json").write_text(
        json.dumps(fish), encoding="utf-8"
    )
    return host, config, fish


def test_dual_channels_enable_independently_and_default_delivery_is_explicit(tmp_path):
    from dswhale.desktop_settings import read_settings, save_settings

    host, config, fish = _dual_host(tmp_path)
    save_settings(host, {"dashboardPort": 6285})
    updated = json.loads((host / "data/cmd_config.json").read_text())
    assert updated["platform"][0]["enable"] is False
    assert updated["platform"][1]["enable"] is True
    assert updated["platform"][0]["ws_reverse_token"] == "SYNTHETIC-ONEBOT-TOKEN"
    assert updated["platform"][1] == config["platform"][1]
    assert read_settings(host)["defaultDelivery"] == "official"
    assert read_settings(host)["napcatConfigured"] is False
    assert read_settings(host)["officialConfigured"] is True
    save_settings(host, {"defaultDelivery": "official"})
    saved = json.loads((host / "data/config/astrbot_plugin_dswhale_config.json").read_text())
    assert saved["qq_default_delivery"] == "official"
    assert saved["owner_umo"] == fish["owner_umo"]
    assert saved["official_owner_umo"] == fish["official_owner_umo"]
    assert saved["persona"] == fish["persona"]
    updated = json.loads((host / "data/cmd_config.json").read_text())
    assert updated["platform"][0]["enable"] is False and updated["platform"][1]["enable"] is True


def test_default_delivery_requires_official_binding_and_active_target(tmp_path):
    from dswhale.desktop_settings import save_settings

    host = host_files(tmp_path)
    for patch in (
        {"defaultDelivery": "official"},
        {"defaultDelivery": "napcat"},
        {"proactiveEnabled": True},
        {"biliEnabled": True},
    ):
        with pytest.raises(ValueError):
            save_settings(host, patch)


def test_official_binding_save_keeps_the_onebot_platform_enabled(tmp_path):
    from dswhale.desktop_settings import save_settings

    host, config, _ = _dual_host(tmp_path)
    save_settings(host, {"defaultDelivery": "official", "proactiveEnabled": True})
    updated = json.loads((host / "data/cmd_config.json").read_text())
    assert updated["platform"][0]["enable"] is False
    assert updated["platform"][1]["enable"] is True
    assert updated["platform"][0]["ws_reverse_token"] == config["platform"][0]["ws_reverse_token"]


@pytest.mark.parametrize(
    "patch", [{"onebotPort": 6299}, {"onebotToken": "synthetic"}, {"platformId": "changed"}]
)
def test_legacy_platform_patch_is_rejected_without_mutation(tmp_path, patch):
    from dswhale.desktop_settings import save_settings

    host, _, _ = _dual_host(tmp_path)
    file = host / "data/cmd_config.json"
    before = file.read_bytes()
    with pytest.raises(ValueError):
        save_settings(host, patch)
    assert file.read_bytes() == before


def test_official_binding_is_validated_under_legacy_napcat_mode(tmp_path):
    import hashlib

    from dswhale.desktop_settings import save_settings

    host, config, fish = _dual_host(tmp_path)
    config_file = host / "data/cmd_config.json"
    fish_file = host / "data/config/astrbot_plugin_dswhale_config.json"
    fish["official_owner_umo"] = ""
    fish["qq_connection_mode"] = "napcat"  # legacy mode must not gate official validation
    fish_file.write_text(json.dumps(fish), encoding="utf-8")
    before = (config_file.read_bytes(), fish_file.read_bytes())
    scope = "official-test:FriendMessage:OPAQUE_LEGACY_NAP CAT".replace(" ", "")

    with pytest.raises(ValueError, match="whoami"):
        save_settings(host, {"officialOwnerUMO": scope})
    assert (config_file.read_bytes(), fish_file.read_bytes()) == before

    proof = host / "data/plugin_data/astrbot_plugin_dswhale/official-c2c.json"
    proof.parent.mkdir(parents=True)
    proof.write_text(json.dumps([hashlib.sha256(scope.encode()).hexdigest()]))
    saved = save_settings(host, {"officialOwnerUMO": scope})
    assert saved["officialOwnerUMO"] == scope
    assert saved["qqConnectionMode"] == "official"
    after_fish = json.loads(fish_file.read_text())
    assert after_fish["official_owner_umo"] == scope
    assert after_fish["owner_qq"] == fish["owner_qq"]
    assert after_fish["owner_umo"] == fish["owner_umo"]
    assert after_fish["persona"] == fish["persona"]
    # An official-only patch must not recreate or enable the OneBot platform.
    assert json.loads(config_file.read_text())["platform"][0]["enable"] is False

    # A platform that is the wrong adapter or disabled is rejected even in the
    # legacy napcat mode; nothing is written.
    snapshot = (config_file.read_bytes(), fish_file.read_bytes())
    for invalid in (
        "old-qq:FriendMessage:123456789",
        "missing:FriendMessage:OPAQUE_LEGACY_NAP CAT".replace(" ", ""),
    ):
        with pytest.raises(ValueError):
            save_settings(host, {"officialOwnerUMO": invalid})
        assert (config_file.read_bytes(), fish_file.read_bytes()) == snapshot


def test_default_delivery_checks_bound_official_instance(tmp_path):
    from dswhale.desktop_settings import save_settings

    host, config, _ = _dual_host(tmp_path)
    file = host / "data/cmd_config.json"
    config["platform"][1]["enable"] = False
    file.write_text(json.dumps(config))
    with pytest.raises(ValueError):
        save_settings(host, {"defaultDelivery": "official"})


def test_settings_history_is_secret_free_bounded_and_restores_with_revision(tmp_path):
    from dswhale.desktop_settings import (
        list_settings_history,
        read_settings,
        restore_setting,
        save_settings,
    )

    host = _host_with_flags(tmp_path)
    config_file = host / "data/cmd_config.json"
    config = json.loads(config_file.read_text())
    config["platform"] = [
        {
            "id": "official-test",
            "type": "qq_official",
            "enable": True,
            "appid": "synthetic",
            "secret": "synthetic",
        }
    ]
    config_file.write_text(json.dumps(config))
    original = read_settings(host)
    assert original["proactiveEnabled"] is True
    save_settings(host, {"proactiveEnabled": False}, original["configRevision"])
    import os
    import stat as stat_module

    history = list_settings_history(host)
    assert history["format"] == 1 and history["records"]
    if os.name != "nt":
        history_dir = host / "data/config/.dswhale-settings-history"
        assert stat_module.S_IMODE(history_dir.stat().st_mode) == 0o700
        for history_file in history_dir.glob("*.json"):
            assert stat_module.S_IMODE(history_file.stat().st_mode) == 0o600
    latest = history["records"][0]
    change = next(item for item in latest["changes"] if item["field"] == "proactiveEnabled")
    assert change["before"] is True and change["after"] is False
    assert "SYNTHETIC" not in json.dumps(history)
    # A stale revision cannot restore or write anything.
    before = read_settings(host)
    with pytest.raises(ValueError, match="另一处更新"):
        restore_setting(host, latest["id"], "proactiveEnabled", original["configRevision"])
    assert read_settings(host)["proactiveEnabled"] is False
    restored = restore_setting(host, latest["id"], "proactiveEnabled", before["configRevision"])
    assert restored["restoredField"] == "proactiveEnabled"
    assert read_settings(host)["proactiveEnabled"] is True
    with pytest.raises(ValueError, match="不支持恢复"):
        restore_setting(host, latest["id"], "onebotToken", before["configRevision"])
    with pytest.raises(ValueError, match="记录无效"):
        restore_setting(host, "../../etc/passwd", "proactiveEnabled", before["configRevision"])

    for index in range(25):
        save_settings(host, {"biliEnabled": index % 2 == 0})
    bounded = list_settings_history(host)
    assert len(bounded["records"]) <= 20
    assert all("onebotToken" not in json.dumps(record) for record in bounded["records"])


def test_history_cannot_restore_a_legacy_platform(tmp_path):
    from dswhale.desktop_settings import restore_setting

    host = host_files(tmp_path)
    with pytest.raises(ValueError):
        restore_setting(host, "1234567890123-abcdef12", "platformId")


def test_reply_style_defaults_migrate_without_writing_and_save_independently(tmp_path):
    from dswhale.desktop_settings import read_settings, save_settings

    host = host_files(tmp_path)
    fish_path = host / "data/config/astrbot_plugin_dswhale_config.json"
    before_bytes = fish_path.read_bytes()
    before = read_settings(host)
    assert before["replyStyleMode"] == "natural"
    assert before["replyStyleMaxBubbles"] == 3
    assert before["replyStylePunctuation"] == "keep"
    assert before["persona"] == "a custom private persona"
    # Reading an old install reports the defaults but never writes them.
    assert fish_path.read_bytes() == before_bytes
    # A desktop save of the loaded defaults is short-circuited by the main
    # process before save_settings; a real change is written independently.
    save_settings(
        host,
        {
            "replyStyleMode": "natural",
            "replyStyleMaxBubbles": 2,
            "replyStyleInterval": "1,2",
            "replyStylePunctuation": "sentence_end",
            "replyStylePrompt": False,
        },
    )
    fish = json.loads(fish_path.read_text(encoding="utf-8"))
    assert fish["reply_style_mode"] == "natural"
    assert fish["reply_style_max_bubbles"] == 2
    assert fish["reply_style_interval"] == "1,2"
    assert fish["reply_style_punctuation"] == "sentence_end"
    assert fish["reply_style_prompt"] is False
    assert fish["persona"] == "a custom private persona"
    with pytest.raises(ValueError):
        save_settings(host, {"replyStyleInterval": "2,1"})
    with pytest.raises(ValueError):
        save_settings(host, {"replyStyleCustomRegex": "(x)"})


def test_f7_python_is_authoritative_for_custom_regex(tmp_path):
    from dswhale.desktop_settings import save_settings

    host = host_files(tmp_path)
    # ``(?i)`` is valid in Python but not in JavaScript's RegExp. The renderer
    # must transmit it unchanged; only the Python validator decides.
    saved = save_settings(host, {"replyStyleCustomRegex": r"(?i)[^\n]+"})
    assert saved["replyStyleCustomRegex"] == r"(?i)[^\n]+"
    for invalid in (r"(a)", r"x*", "("):
        with pytest.raises(ValueError):
            save_settings(host, {"replyStyleCustomRegex": invalid})


def test_diary_and_no_reply_preferences_are_opt_in_and_preserve_other_settings(tmp_path):
    from dswhale.desktop_settings import read_settings, save_settings

    host = _host_with_flags(tmp_path)
    config_file = host / "data/cmd_config.json"
    fish_file = host / "data/config/astrbot_plugin_dswhale_config.json"
    config_before = config_file.read_bytes()
    fish_before = json.loads(fish_file.read_text())
    initial = read_settings(host)
    assert initial["continueUnanswered"] is False
    assert initial["dailyDiaryEnabled"] is False
    saved = save_settings(host, {"continueUnanswered": True, "dailyDiaryEnabled": True})
    assert saved["continueUnanswered"] is True
    assert saved["dailyDiaryEnabled"] is True
    assert config_file.read_bytes() == config_before
    fish = json.loads(fish_file.read_text())
    assert fish == {
        **fish_before,
        "proactive_continue_unanswered": True,
        "daily_diary_enabled": True,
    }

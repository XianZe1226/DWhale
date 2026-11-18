"""Exercise the gateway state machine through an in-memory QQ wire."""

import asyncio
import json
from collections import deque
from types import SimpleNamespace

import pytest
from aiohttp import WSMsgType

from dswhale import qq_gateway


class Wire:
    closed = False
    close_code = None

    def __init__(self, *frames):
        self.frames = deque(frames)
        self.sent = []

    async def receive(self):
        if not self.frames:
            await asyncio.Future()
        frame = self.frames.popleft()
        if isinstance(frame, int):
            self.close_code = frame
            return SimpleNamespace(type=WSMsgType.CLOSE)
        return SimpleNamespace(type=WSMsgType.TEXT, data=json.dumps(frame))

    async def send_str(self, message):
        self.sent.append(json.loads(message))

    async def send_json(self, message):
        self.sent.append(message)


async def noop():
    pass


def socket(seen, *, session_id="", seq=0):
    session = {
        "url": "wss://example.invalid",
        "session_id": session_id,
        "last_seq": seq,
        "intent": 1,
        "token": SimpleNamespace(check_token=noop, get_string=lambda: "synthetic"),
        "shards": {"shard_id": 0, "shard_count": 1},
    }
    parser = {"c2c_message_create": seen.append, "ready": seen.append, "resumed": seen.append}
    return qq_gateway.GatewaySocket(session, SimpleNamespace(parser=parser))


HELLO = {"op": 10, "d": {"heartbeat_interval": 12}}
READY = {
    "op": 0,
    "t": "READY",
    "s": 1,
    "d": {"session_id": "synthetic-session", "shard": [0, 1], "version": 1, "user": {}},
}
RESUMED = {"op": 0, "t": "RESUMED", "s": 2}
CHAT = {"op": 0, "t": "C2C_MESSAGE_CREATE", "s": 3, "d": {}}


async def test_ready_dispatch_and_reconnect_request():
    seen = []
    gateway = socket(seen)
    wire = Wire(HELLO, READY, CHAT, CHAT, {"op": 7})
    assert await asyncio.wait_for(gateway.receive(wire), 1) is None
    assert [item["op"] for item in wire.sent] == [2, 1]
    assert seen == [READY, CHAT]
    assert gateway._session["last_seq"] == 3


async def test_resumed_session_is_invalidated_by_gateway():
    seen = []
    gateway = socket(seen, session_id="previous", seq=1)
    wire = Wire(HELLO, RESUMED, {"op": 11}, {"op": 9, "d": False})
    await asyncio.wait_for(gateway.receive(wire), 1)
    assert [item["op"] for item in wire.sent] == [6, 1]
    assert gateway._session["session_id"] == ""
    assert gateway._session["last_seq"] == 0


async def test_missing_heartbeat_ack_releases_silent_socket(monkeypatch):
    monkeypatch.setattr(qq_gateway, "MIN_HEARTBEAT_SECONDS", 0.01)
    gateway = socket([])
    wire = Wire(HELLO, READY, {"op": 11})
    await asyncio.wait_for(gateway.receive(wire), 1)
    assert [item["op"] for item in wire.sent] == [2, 1, 1]
    assert gateway.ever_ready


async def test_resume_without_confirmation_clears_stale_session(monkeypatch):
    monkeypatch.setattr(qq_gateway, "HANDSHAKE_SECONDS", 0.02)
    gateway = socket([], session_id="previous", seq=1)
    wire = Wire(HELLO)
    await asyncio.wait_for(gateway.receive(wire), 1)
    assert [item["op"] for item in wire.sent] == [6]
    assert gateway._session["session_id"] == ""


async def test_shard_preserves_session_after_loss_and_stops_on_fatal_close(monkeypatch):
    seen, delays, tracked, wires = [], [], [], []
    client = SimpleNamespace(
        _connection=SimpleNamespace(parser={"ready": seen.append, "resumed": seen.append}),
        _active_websockets=set(),
        is_shutting_down=False,
    )
    gateway = socket([])
    frames = iter([(HELLO, READY, 1006), (HELLO, RESUMED, 4915)])

    async def reconnect(self, _http):
        assert client._active_websockets == {self}
        wire = Wire(*next(frames))
        wires.append(wire)
        return await self.receive(wire)

    async def delay(seconds):
        delays.append(seconds)
        tracked.append(len(client._active_websockets))

    monkeypatch.setattr(qq_gateway.GatewaySocket, "connect", reconnect)
    monkeypatch.setattr(qq_gateway.asyncio, "sleep", delay)
    with pytest.raises(qq_gateway.GatewayBlocked, match="4915"):
        await qq_gateway.run_shard(client, gateway._session, None)
    assert [wire.sent[0]["op"] for wire in wires] == [2, 6]
    assert len(delays) == 1 and delays[0] >= 5
    assert tracked == [0]
    assert not client._active_websockets


async def test_connected_requires_heartbeat_ack():
    gateway = socket([])
    ready_to_check = asyncio.Event()
    resume_wire = asyncio.Event()

    class PausableWire(Wire):
        async def receive(self):
            if not self.frames:
                ready_to_check.set()
                await resume_wire.wait()
                return SimpleNamespace(type=WSMsgType.TEXT, data='{"op":7}')
            return await super().receive()

    for frames, expected in [((HELLO, READY), False), ((HELLO, READY, {"op": 11}), True)]:
        gateway = socket([])
        task = asyncio.create_task(gateway.receive(PausableWire(*frames)))
        try:
            await asyncio.wait_for(ready_to_check.wait(), 1)
            assert gateway.connected is expected
        finally:
            resume_wire.set()
            await task
        assert not gateway.connected
        ready_to_check.clear()
        resume_wire.clear()


async def test_real_adapter_routes_to_managed_gateway(monkeypatch):
    from astrbot.core.platform.sources.qqofficial.qqofficial_platform_adapter import (
        QQOfficialPlatformAdapter,
    )

    monkeypatch.setattr(QQOfficialPlatformAdapter, "run", QQOfficialPlatformAdapter.run)
    calls = []

    async def run(client, appid, secret):
        calls.append((client, appid, secret))

    monkeypatch.setattr(qq_gateway, "run_gateway", run)
    assert qq_gateway.install()
    first = QQOfficialPlatformAdapter.run
    assert qq_gateway.install()
    assert QQOfficialPlatformAdapter.run is first
    platform = SimpleNamespace(
        get_client=lambda: "fake-client", appid="fake-id", secret="fake-secret"
    )
    await first(platform)
    assert calls == [("fake-client", "fake-id", "fake-secret")]


async def test_receives_replayed_message_before_resumed_frame():
    seen = []
    gateway = socket(seen, session_id="previous", seq=1)
    wire = Wire(HELLO, CHAT, RESUMED, CHAT, {"op": 7})
    await asyncio.wait_for(gateway.receive(wire), 1)
    assert seen == [CHAT, RESUMED]
    assert wire.sent[-1] == {"op": 1, "d": 3}


async def test_gateway_recovers_from_missing_startup_metadata(monkeypatch):
    import contextlib

    async def login(token):
        logins.append(token)
        client._ws_ap = (
            None
            if len(logins) == 1
            else {
                "url": "wss://example.invalid",
                "shards": 1,
                "session_start_limit": {"remaining": 1},
            }
        )

    async def shutdown():
        client.is_shutting_down = True

    @contextlib.asynccontextmanager
    async def http(**kwargs):
        yield "fake-wire-client"

    async def shard(client, session, transport):
        assert transport == "fake-wire-client"
        assert session["token"] is logins[-1]
        assert session["shards"] == {"shard_id": 0, "shard_count": 1}
        raise qq_gateway.GatewayBlocked("4914")

    client = SimpleNamespace(
        _async_setup_hook=noop,
        _bot_login=login,
        shutdown=shutdown,
        is_shutting_down=False,
        intents=1,
    )
    logins = []
    monkeypatch.setattr(qq_gateway.asyncio, "sleep", lambda _: noop())
    monkeypatch.setattr(qq_gateway, "ClientSession", http)
    monkeypatch.setattr(qq_gateway, "run_shard", shard)
    await qq_gateway.run_gateway(client, "synthetic", "synthetic")
    assert len(logins) == 2
    assert client.is_shutting_down and client._dwhale_gateway_blocked

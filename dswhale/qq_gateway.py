"""Keep the pinned AstrBot QQ WebSocket alive using its existing event parser and HTTP client."""

import asyncio
import json
import logging
import random
from importlib.metadata import PackageNotFoundError, version

from aiohttp import ClientError, ClientSession, ClientTimeout, WSMsgType
from botpy.errors import AuthenticationFailedError, ForbiddenError
from botpy.gateway import BotWebSocket
from botpy.robot import Token

logger = logging.getLogger("dswhale")
HANDSHAKE_SECONDS = 30
MIN_HEARTBEAT_SECONDS = 1
RETRY_DELAYS = (5, 10, 20, 40, 60, 120)
FATAL_CODES = {4914, 4915}
INVALID_SESSION_CODES = {4006, 4007, 4009, 9001, 9005, *range(4900, 4914)}


class GatewayBlocked(RuntimeError):
    """QQ requires manual action before another connection attempt."""


class GatewaySocket(BotWebSocket):
    def __init__(self, session, connection):
        super().__init__(session, connection)
        self.authenticated = False
        self.ever_ready = False
        self.attempted_resume = False
        self.last_ack = None
        self.ack_deadline = float("inf")

    @property
    def connected(self):
        return (
            self.authenticated
            and self.last_ack is not None
            and self._conn is not None
            and not self._conn.closed
            and asyncio.get_running_loop().time() < self.ack_deadline
        )

    def clear_session(self):
        self._session.update(session_id="", last_seq=0)

    async def send_msg(self, event_json):
        # The SDK's default debug logging includes the authorization payload.
        await self._conn.send_str(event_json)

    async def close(self):
        self.authenticated = False
        if self._conn is not None and not self._conn.closed:
            await self._conn.close()

    async def connect(self, http):
        async with http.ws_connect(self._session["url"]) as wire:
            return await self.receive(wire)

    def dispatch(self, frame):
        name, sequence = frame.get("t"), frame.get("s")
        if not isinstance(name, str):
            return
        if type(sequence) is int and sequence > 0:
            if name not in {"READY", "RESUMED"} and sequence <= self._session["last_seq"]:
                return
        parser = self._parser.get(name.lower())
        if parser:
            try:
                parser(frame)
            except Exception:
                # A parser error for one event should not kill the receive loop.
                logger.warning("QQ 官方事件解析未完成")
        if type(sequence) is int and sequence > 0:
            self._session["last_seq"] = max(sequence, self._session["last_seq"])

    async def receive(self, wire):
        self._conn = wire
        loop = asyncio.get_running_loop()
        hello = False
        resuming = False
        awaiting_ack = False
        interval = 0
        due = loop.time() + HANDSHAKE_SECONDS
        try:
            while not wire.closed:
                try:
                    async with asyncio.timeout_at(due):
                        message = await wire.receive()
                except TimeoutError:
                    if not self.authenticated:
                        if resuming:
                            self.clear_session()
                        return None
                    if awaiting_ack:
                        return None
                    async with asyncio.timeout(HANDSHAKE_SECONDS):
                        await wire.send_json(
                            {"op": self.WS_HEARTBEAT, "d": self._session["last_seq"]}
                        )
                    awaiting_ack = True
                    due = loop.time() + interval
                    self.ack_deadline = due
                    continue

                if message.type != WSMsgType.TEXT:
                    if message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR}:
                        break
                    continue
                frame = json.loads(message.data)
                opcode = frame.get("op")
                if opcode == self.WS_HELLO and not hello:
                    interval = max(MIN_HEARTBEAT_SECONDS, frame["d"]["heartbeat_interval"] / 1000)
                    async with asyncio.timeout(HANDSHAKE_SECONDS):
                        resuming = bool(self._session["session_id"])
                        self.attempted_resume = resuming
                        await self.on_connected(wire)
                    hello = True
                    due = loop.time() + HANDSHAKE_SECONDS
                elif opcode == self.WS_RECONNECT:
                    return None
                elif opcode == self.WS_INVALID_SESSION:
                    if frame.get("d") is not True:
                        self.clear_session()
                    return None
                elif opcode == self.WS_HEARTBEAT_ACK and awaiting_ack:
                    awaiting_ack = False
                    self.last_ack = loop.time()
                    self.ack_deadline = float("inf")
                elif opcode == self.WS_DISPATCH_EVENT and hello:
                    name = frame.get("t")
                    if not self.authenticated and name in {"READY", "RESUMED"}:
                        if name == "READY":
                            await self._ready_handler(frame)
                            self._session["last_seq"] = 0
                        elif not resuming:
                            return None
                        self.authenticated = self.ever_ready = True
                        self.dispatch(frame)
                        async with asyncio.timeout(HANDSHAKE_SECONDS):
                            await wire.send_json(
                                {"op": self.WS_HEARTBEAT, "d": self._session["last_seq"]}
                            )
                        awaiting_ack = True
                        due = loop.time() + interval
                        self.ack_deadline = due
                    elif self.authenticated or resuming:
                        # A resumed stream may replay events before RESUMED.
                        self.dispatch(frame)
            return wire.close_code
        finally:
            self.authenticated = False


def retry_delay(failures, *, limited=False):
    minimum = max(60 if limited else 0, RETRY_DELAYS[min(failures, len(RETRY_DELAYS) - 1)])
    return minimum + random.uniform(0, 2)


async def run_shard(client, session, http):
    failures = 0
    while not client.is_shutting_down:
        socket = GatewaySocket(session, client._connection)
        client._active_websockets.add(socket)
        started = asyncio.get_running_loop().time()
        close_code = None
        limited = False
        try:
            close_code = await socket.connect(http)
        except (AuthenticationFailedError, ForbiddenError) as error:
            raise GatewayBlocked("QQ 拒绝网关授权") from error
        except (
            ClientError,
            TimeoutError,
            OSError,
            ValueError,
            TypeError,
            KeyError,
            RuntimeError,
        ) as error:
            limited = getattr(error, "status", None) == 429
        finally:
            client._active_websockets.discard(socket)
        if client.is_shutting_down:
            return
        if close_code in FATAL_CODES:
            raise GatewayBlocked(f"QQ 已停止网关接入（{close_code}）")
        if close_code == 4004:
            session["token"].access_token = None
        if close_code in INVALID_SESSION_CODES:
            socket.clear_session()
        if (
            failures >= 1
            and socket.attempted_resume
            and not socket.ever_ready
            and not limited
            and close_code not in {4004, 4008}
        ):
            socket.clear_session()
        if socket.ever_ready and asyncio.get_running_loop().time() - started >= 60:
            failures = 0
        await asyncio.sleep(retry_delay(failures, limited=limited or close_code == 4008))
        failures += 1


async def run_gateway(client, appid, secret):
    client._dwhale_gateway_blocked = False
    await client._async_setup_hook()
    token = Token(appid, secret)
    failures = 0
    try:
        while not client.is_shutting_down:
            limited = False
            try:
                async with asyncio.timeout(HANDSHAKE_SECONDS):
                    await client._bot_login(token)
                gateway = client._ws_ap
                shard_count = gateway["shards"]
                url = gateway["url"]
                if type(shard_count) is not int or shard_count < 1 or not url.startswith("wss://"):
                    raise ValueError("Invalid QQ gateway metadata")
                limited = shard_count > gateway["session_start_limit"]["remaining"]
                if not limited:
                    break
            except (AuthenticationFailedError, ForbiddenError):
                client._dwhale_gateway_blocked = True
                logger.warning("QQ 官方网关授权失败，请检查机器人配置")
                return
            except Exception:
                # Token errors may embed upstream response bodies. Do not log them.
                logger.warning("QQ 官方网关暂不可用，将自动重试")
            await asyncio.sleep(retry_delay(failures, limited=limited))
            failures += 1
        else:
            return

        async with ClientSession(timeout=ClientTimeout(total=HANDSHAKE_SECONDS)) as http:
            try:
                async with asyncio.TaskGroup() as tasks:
                    for index in range(shard_count):
                        if client.is_shutting_down:
                            break
                        tasks.create_task(
                            run_shard(
                                client,
                                {
                                    "url": url,
                                    "session_id": "",
                                    "last_seq": 0,
                                    "token": token,
                                    "intent": client.intents,
                                    "shards": {"shard_id": index, "shard_count": shard_count},
                                },
                                http,
                            )
                        )
                        if index + 1 < shard_count:
                            await asyncio.sleep(5)
            except* GatewayBlocked:
                client._dwhale_gateway_blocked = True
                logger.warning("QQ 开放平台已拒绝网关连接，请检查机器人状态后重新启用")
    finally:
        await client.shutdown()


def install():
    """Attach to supported upstream versions before AstrBot starts its platforms."""
    try:
        if version("astrbot") not in {"4.29.3", "4.29.4"} or version("qq-botpy") != "1.2.1":
            return False
        from astrbot.core.platform.sources.qqofficial.qqofficial_platform_adapter import (
            QQOfficialPlatformAdapter,
        )
    except (ImportError, PackageNotFoundError):
        return False
    if not getattr(QQOfficialPlatformAdapter.run, "_dwhale_gateway", False):

        async def run(platform):
            await run_gateway(platform.get_client(), platform.appid, platform.secret)

        run._dwhale_gateway = True
        QQOfficialPlatformAdapter.run = run
    return True

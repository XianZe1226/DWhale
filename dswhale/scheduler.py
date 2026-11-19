"""Scheduling decisions are pure local policy, without model or network calls."""

import random
import uuid
from datetime import datetime

from .config import Settings
from .store import AUTO_VIDEO_KINDS, CHAT_KINDS, VIDEO_KINDS, Activity, Store


class Scheduler:
    def __init__(self, settings: Settings, store: Store):
        self.settings, self.store = settings, store
        self.last_decision = None

    def _next_due(self, now: datetime) -> float:
        return now.timestamp() + 60 * random.randint(
            self.settings.min_interval_minutes,
            self.settings.max_interval_minutes,
        )

    def _scopes(self, scopes=None):
        if scopes is None:
            delivery = self.settings.delivery_binding
            ordered = ([delivery.umo] if delivery else []) + [
                binding.umo
                for binding in self.settings.owner_bindings
                if not delivery or binding.umo != delivery.umo
            ]
        else:
            ordered = list(scopes)
        values = tuple(dict.fromkeys(str(scope) for scope in ordered if scope))
        return values or (self.settings.owner_scope,)

    def human_received(self, now: datetime, scopes=None):
        """Any bound channel's human message resets the shared proactive budget."""
        self.settings.local_time(now)
        due = self._next_due(now)
        for scope in self._scopes(scopes):
            self.store.state(scope)
            self.store.db.execute(
                "UPDATE sessions SET last_human=?,unanswered=0,next_due=? WHERE scope=?",
                (now.timestamp(), due, scope),
            )

    def _availability(self, online: bool, kind="chat"):
        enabled = {
            "chat": self.settings.proactive_enabled,
            "video-discovery": self.settings.discover_enabled,
        }.get(kind, self.settings.bili_enabled)
        if not enabled:
            return "disabled"
        if not self.settings.owner_scope:
            return "unbound"
        if not online:
            return "offline"
        return None

    def _decision(self, now, scopes, *, kind, db=None, spontaneous=False):
        cfg = self.settings
        states = [self.store.state(scope) for scope in scopes]
        if any(state["paused"] for state in states):
            return "paused", None
        if cfg.is_quiet(now):
            return "quiet", None
        chat = kind == "chat"
        if (
            chat
            and not spontaneous
            and not cfg.proactive_continue_unanswered
            and max(state["unanswered"] for state in states) >= cfg.unanswered_limit
        ):
            return "awaiting_reply", None
        if self.store.has_pending(scopes, db=db, kinds=CHAT_KINDS if chat else VIDEO_KINDS):
            return "pending", None
        if spontaneous:
            return "ready", None
        local = cfg.local_time(now)
        if kind == "video-discovery" and not 18 <= local.hour < 23:
            return "waiting", None
        if kind in AUTO_VIDEO_KINDS:
            kinds, limit = AUTO_VIDEO_KINDS, 1
        else:
            kinds, limit = (CHAT_KINDS if chat else (kind,)), cfg.daily_limit
        if (
            self.store.count_local_day(scopes, local.date().isoformat(), db=db, kinds=kinds)
            >= limit
        ):
            return "daily_limit", None
        if not chat:
            return "ready", None
        due = max(
            (state["next_due"] for state in states if state["next_due"] is not None), default=None
        )
        if due is None:
            return "unscheduled", None
        return ("waiting" if now.timestamp() < due else "ready"), due

    def spontaneous_reason(self, now, scope, *, online):
        return (
            self._availability(online)
            or self._decision(now, self._scopes((scope,)), kind="chat", spontaneous=True)[0]
        )

    def status(self, now: datetime, scope: str, *, online: bool) -> str:
        reason = self._availability(online)
        due = None
        if reason is None:
            reason, due = self._decision(
                now, self._scopes((scope,)), kind="chat", spontaneous=self.settings.spontaneous_chat
            )
        if self.settings.spontaneous_chat and reason == "ready":
            return "随心找我聊，由鱼决定开口时机"
        if reason == "waiting":
            next_chat = self.settings.local_time(datetime.fromtimestamp(due, tz=now.tzinfo))
            return f"预计 {next_chat:%m-%d %H:%M} 后找你聊"
        return {
            "disabled": "未开启，可在 QQ 连接页开启「主动找你聊」",
            "unbound": "未绑定官方私聊",
            "offline": "等待 QQ 官方连接恢复",
            "paused": "已暂停，发送 /fish start 恢复",
            "quiet": f"安静时段，{self.settings.quiet_end} 后再考虑开场",
            "awaiting_reply": "等你先聊一句",
            "daily_limit": "今天的主动活动次数已用完",
            "pending": "正在准备一条消息",
            "unscheduled": "正在安排下次开场",
            "ready": "已到开场时间，等待下一次检查",
        }[reason]

    def reserve(
        self,
        now: datetime,
        *,
        external_kind: str | None = None,
        scopes=None,
        target_scope=None,
        online=True,
        spontaneous_since=None,
    ) -> Activity | None:
        if external_kind is not None and external_kind not in VIDEO_KINDS:
            raise ValueError("Unknown activity kind")
        kind = external_kind or "chat"
        spontaneous = spontaneous_since is not None
        if kind == "chat" and spontaneous != self.settings.spontaneous_chat:
            return None
        if reason := self._availability(online, kind):
            if external_kind is None:
                self.last_decision = reason
            return None
        cfg = self.settings
        local = cfg.local_time(now)
        scopes = self._scopes(scopes)
        target = str(target_scope or scopes[0])
        if target not in scopes:
            scopes = (target, *scopes)
        ts = now.timestamp()
        with self.store.transaction() as db:
            if spontaneous and (
                kind != "chat"
                or any(
                    self.store.state(scope)["last_human"] > spontaneous_since for scope in scopes
                )
            ):
                return None
            reason, _ = self._decision(now, scopes, kind=kind, db=db, spontaneous=spontaneous)
            if external_kind is None:
                self.last_decision = reason
            if reason == "unscheduled":
                scheduled = self._next_due(now)
                for scope in scopes:
                    db.execute("UPDATE sessions SET next_due=? WHERE scope=?", (scheduled, scope))
            if reason != "ready":
                return None
            scope = target
            item = Activity(
                uuid.uuid4().hex,
                scope,
                kind,
                "reserved",
                ts,
            )
            db.execute(
                "INSERT INTO activities VALUES(?,?,?,?,?,?,?,?)",
                (item.id, scope, item.kind, local.date().isoformat(), item.status, ts, ts, ""),
            )
            if kind == "chat" and not spontaneous:
                scheduled = self._next_due(now)
                for target in scopes:
                    db.execute(
                        "UPDATE sessions SET next_due=? WHERE scope=?",
                        (scheduled, target),
                    )
            return item

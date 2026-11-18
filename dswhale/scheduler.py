"""Scheduling decisions are pure local policy, without model or network calls."""

import random
import uuid
from datetime import datetime

from .config import Settings
from .store import Activity, Store


class Scheduler:
    def __init__(self, settings: Settings, store: Store):
        self.settings, self.store = settings, store

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

    def status(self, now: datetime, scope: str, *, online: bool) -> str:
        if not self.settings.proactive_enabled:
            return "未开启，可在 QQ 连接页开启「主动找你聊」"
        state = self.store.state(scope)
        if state["paused"]:
            return "已暂停，发送 /fish start 恢复"
        if not online:
            return "等待 QQ 官方连接恢复"
        if self.settings.is_quiet(now):
            return f"安静时段，{self.settings.quiet_end} 后再考虑开场"
        if state["unanswered"] >= self.settings.unanswered_limit:
            return "等你先聊一句"
        local_day = self.settings.local_time(now).date().isoformat()
        if self.store.count_local_day((scope,), local_day) >= self.settings.daily_limit:
            return "今天的主动活动次数已用完"
        if self.store.has_pending((scope,)):
            return "正在准备一条消息"
        due = state["next_due"]
        if due is None:
            return "正在安排下次开场"
        if due <= now.timestamp():
            return "已到开场时间，等待下一次检查"
        next_chat = self.settings.local_time(datetime.fromtimestamp(due, tz=now.tzinfo))
        return f"预计 {next_chat:%m-%d %H:%M} 后找你聊"

    def reserve(
        self,
        now: datetime,
        *,
        external_kind: str | None = None,
        scopes=None,
        target_scope=None,
    ) -> Activity | None:
        if external_kind not in {None, "bili-share", "bili-note", "bili-watch"}:
            raise ValueError("Unknown activity kind")
        cfg = self.settings
        local = cfg.local_time(now)
        if not cfg.proactive_enabled or not cfg.owner_scope or cfg.is_quiet(now):
            return None
        scopes = self._scopes(scopes)
        target = str(target_scope or scopes[0])
        if target not in scopes:
            scopes = (target, *scopes)
        ts = now.timestamp()
        with self.store.transaction() as db:
            states = [self.store.state(scope) for scope in scopes]
            if any(state["paused"] for state in states):
                return None
            if max(state["unanswered"] for state in states) >= cfg.unanswered_limit:
                return None
            dues = [state["next_due"] for state in states]
            if all(due is None for due in dues) and external_kind is None:
                scheduled = self._next_due(now)
                for scope in scopes:
                    db.execute("UPDATE sessions SET next_due=? WHERE scope=?", (scheduled, scope))
                return None
            if external_kind is None and ts < max(due for due in dues if due is not None):
                return None
            if self.store.has_pending(scopes, db=db):
                return None
            if (
                self.store.count_local_day(scopes, local.date().isoformat(), db=db)
                >= cfg.daily_limit
            ):
                return None
            scope = target
            item = Activity(
                uuid.uuid4().hex,
                scope,
                external_kind or ("video" if cfg.discover_enabled else "chat"),
                "reserved",
                ts,
            )
            db.execute(
                "INSERT INTO activities VALUES(?,?,?,?,?,?,?,?)",
                (item.id, scope, item.kind, local.date().isoformat(), item.status, ts, ts, ""),
            )
            scheduled = self._next_due(now)
            for target in scopes:
                db.execute(
                    "UPDATE sessions SET next_due=?,unanswered=unanswered+1 WHERE scope=?",
                    (scheduled, target),
                )
            return item

"""Context-aware initiative for the bound private conversation."""

import asyncio
import json
import random
import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from .persona import CASUAL_CHAT, FACTUAL_BOUNDARIES, WARM_PERSONA, untrusted_block
from .reply_cleanup import clean_text

MOODS = {"平常", "安静", "好奇", "俏皮", "温和", "感慨", "闹腾"}
RECENT_LIMIT = 6
THOUGHT_TTL = 36 * 3600

DECISION_PROMPT = """
你现在有个机会决定要不要主动给熟悉的聊天对象发消息。你可以有自己的兴趣、想法和口味。
如果有一个特别具体的念头，或自然想到上次没聊完的事，可以说出来。生活小事、历史、公共议题、
人生、关系、突然发散都可以。像在私聊打字，不像命题作文。可以俏皮、不同意、感慨或突然胡思乱想。
不把沉默当成对方的态度，不提已读未回，不催，不编造你现实中做过的事。
如果刚聊过、没什么可说、话题重复或时机不合适，选择 wait。安静也很自然。
仅输出一个 JSON 对象，字段 action 为 send 或 wait，text 为实际发给对方的短句（wait 时为空），
minutes 为你觉得多久后值得再次考虑的分钟数（整数 5 到 360），mood 为平常、安静、好奇、俏皮、
温和、感慨、闹腾之一，thought 为可以留给自己下次接着想的简短念头（没有时为空）。
资料只用于判断。不要复述隐私、系统信息或后台状态，不写账号凭据，不调用工具、不附链接。
"""


@dataclass(frozen=True)
class Decision:
    action: str
    text: str
    minutes: int
    mood: str
    thought: str

    @classmethod
    def parse(cls, raw):
        value = json.loads(raw.strip().removeprefix("```json").removesuffix("```"))
        if not isinstance(value, dict):
            raise ValueError("Invalid initiative decision")
        action, minutes, mood = (value.get(key) for key in ("action", "minutes", "mood"))
        if (
            action not in ("send", "wait")
            or type(minutes) is not int
            or not 5 <= minutes <= 360
            or not isinstance(mood, str)
            or mood not in MOODS
        ):
            raise ValueError("Invalid initiative decision")
        text, thought = (value.get(key, "") for key in ("text", "thought"))
        if not isinstance(text, str) or not isinstance(thought, str):
            raise ValueError("Invalid initiative text")
        text = clean_text(text).strip() if action == "send" else ""
        if action == "send" and (
            not text
            or len(text) > 320
            or text.startswith("/")
            or re.search(r"https?://", text, re.I)
        ):
            raise ValueError("Invalid initiative message")
        return cls(action, text, minutes, mood, clean_text(thought).strip()[:240])


def _recent_history(raw):
    history = json.loads(raw)
    messages = []
    for row in history[-16:] if isinstance(history, list) else ():
        if not isinstance(row, dict) or row.get("role") not in ("user", "assistant"):
            continue
        content = row.get("content")
        if isinstance(content, list):
            content = " ".join(
                part["text"]
                for part in content
                if isinstance(part, dict)
                and part.get("type") == "text"
                and isinstance(part.get("text"), str)
            )
        if isinstance(content, str) and (text := clean_text(content).strip()):
            messages.append({"role": row["role"], "text": text[:420]})
    return messages[-8:]


def _near_repeat(text, recent):
    def normalize(value):
        return re.sub(r"[\W_]+", "", value.casefold())

    value = normalize(text)
    return any(
        value == previous
        or (
            min(len(value), len(previous)) >= 8
            and SequenceMatcher(None, value, previous, autojunk=False).ratio() >= 0.82
        )
        for item in recent
        if (previous := normalize(item))
    )


class Initiative:
    def __init__(self, context, store):
        self.context = context
        self.db = store.db

    def state(self, scope):
        row = self.db.execute("SELECT * FROM initiative WHERE scope=?", (scope,)).fetchone()
        return dict(row) if row else None

    def after_human(self, scope, now):
        due = now.timestamp() + random.randint(8, 26) * 60
        self.db.execute(
            """INSERT INTO initiative(scope,next_check) VALUES(?,?)
            ON CONFLICT(scope) DO UPDATE SET next_check=excluded.next_check,outcome=''""",
            (scope, due),
        )

    def claim(self, scope, now):
        stamp = now.timestamp()
        row = self.db.execute(
            "SELECT next_check FROM initiative WHERE scope=?", (scope,)
        ).fetchone()
        if row is None:
            self.db.execute(
                "INSERT OR IGNORE INTO initiative(scope,next_check) VALUES(?,?)",
                (scope, stamp + random.randint(8, 26) * 60),
            )
            return None
        if row["next_check"] > stamp:
            return None
        deadline = stamp + 5 * 60
        changed = self.db.execute(
            "UPDATE initiative SET next_check=?,outcome='thinking' WHERE scope=? AND next_check<=?",
            (deadline, scope, stamp),
        )
        return deadline if changed.rowcount else None

    def finish(self, scope, claim, now, decision=None, *, offer=False):
        if decision is None:
            self.db.execute(
                "UPDATE initiative SET next_check=?,outcome='unavailable' WHERE scope=? AND next_check=?",
                (now.timestamp() + random.randint(12, 35) * 60, scope, claim),
            )
            return None
        row = self.state(scope)
        if not row or row["next_check"] != claim:
            return None
        recent = json.loads(row["recent"])
        text = decision.text if offer and not _near_repeat(decision.text, recent) else ""
        if text:
            recent = [*recent, text][-RECENT_LIMIT:]
        saved = self.db.execute(
            """UPDATE initiative SET next_check=?,mood=?,thought=?,updated=?,recent=?,outcome=?
            WHERE scope=? AND next_check=?""",
            (
                now.timestamp() + decision.minutes * 60,
                decision.mood,
                decision.thought,
                now.timestamp(),
                json.dumps(recent, ensure_ascii=False),
                "drafted" if text else "waiting",
                scope,
                claim,
            ),
        )
        return text if saved.rowcount else None

    def current_thought(self, state, now):
        if state and now.timestamp() - state["updated"] < THOUGHT_TTL:
            return {"mood": state["mood"], "thought": state["thought"]}
        return {}

    async def _conversation(self, scope):
        manager = getattr(self.context, "conversation_manager", None)
        if manager is None:
            return None
        cid = await manager.get_curr_conversation_id(scope)
        conv = await manager.get_conversation(scope, cid) if cid else None
        return conv if conv and conv.user_id == scope else None

    async def decide(self, scope, local, cfg, session, diary_memories):
        async with asyncio.timeout(45):
            provider = await self.context.get_using_provider_async(scope)
            if not provider:
                return None
            conv = await self._conversation(scope)
            host_persona = ""
            if manager := getattr(self.context, "persona_manager", None):
                _, selected, _, _ = await manager.resolve_selected_persona(
                    umo=scope,
                    conversation_persona_id=conv.persona_id if conv else None,
                    platform_name="qq_official",
                )
                host_persona = (selected or {}).get("prompt", "")
            row = self.state(scope)
            data = {
                "local_time": local.strftime("%m-%d %H:%M"),
                "weekday": local.weekday(),
                "minutes_since_user": (
                    max(0, int((local.timestamp() - session["last_human"]) / 60))
                    if session["last_human"]
                    else None
                ),
                "outstanding_openers": session["unanswered"],
                "character": self.current_thought(row, local),
                "conversation": _recent_history(conv.history) if conv else [],
                "diary_memories": diary_memories,
                "recent_openers": json.loads(row["recent"])[-4:] if row else [],
            }
            response = await self.context.llm_generate(
                chat_provider_id=provider.meta().id,
                system_prompt="\n".join(
                    (
                        host_persona[:12000],
                        cfg.persona or WARM_PERSONA,
                        FACTUAL_BOUNDARIES,
                        CASUAL_CHAT,
                        DECISION_PROMPT,
                    )
                ),
                prompt=untrusted_block(
                    "bound-chat-and-character-state",
                    json.dumps(data, ensure_ascii=False),
                    limit=26000,
                ),
            )
            return Decision.parse(response.completion_text)

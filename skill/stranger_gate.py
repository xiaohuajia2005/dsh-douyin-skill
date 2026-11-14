"""修复 #1：陌生人消息不再被静默丢弃。

原版行为（现象）
----------------
插件只处理"已许可会话"（allowlist）。粉丝第一次发来的私信不在名单里，
于是被判定为 `ignored` —— 不入队、不告警、不留日志。运营侧看到的是
"今天没人找我"，实际上已经漏了十几个人。而把陌生人加进许可名单是纯手动操作，
既没法批量，也没法察觉漏了谁。

根因
----
"要不要回"和"要不要看"被合并成了一个二值判断，落在同一个 `Ignored` 分支里。
于是"我不确定该怎么处理"被迫退化为"当作没看见"。

修法
----
拆成两级，把"不确定"单独留一条出路：

    文本 → 硬规则（垃圾/黑产）→ BLOCK      明确垃圾，不占额度，但留痕
         → 转人工词（合作/投诉）→ REVIEW    进人工队列，不自动回
         → 老会话（关注/有历史）→ NORMAL    走常规回复
         → 陌生人 + 打招呼/提问 → PROBATION 观察期，允许 1 条受控短回复
         → 其余陌生人 → REVIEW              进人工队列

不变量：**任何一条私信都不会既没有回复、也没有进入任何队列。**
BLOCK 会写审计日志，REVIEW 会进人工队列，PROBATION/NORMAL 会回。
这条不变量由 tests/test_stranger_gate.py 里的 `test_never_silently_dropped` 守着。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum

from .config import StrangerParams

# ── 硬规则：命中即 BLOCK ──────────────────────────────────
LINK_RE = re.compile(r"(https?://|www\.|\b[a-z0-9-]+\.(com|cn|net|xyz|top|vip)\b)", re.I)
CONTACT_RE = re.compile(r"(微信|威信|薇信|v信|加我|加个|扣扣|企鹅|扫码|二维码|私聊我|戳我|wx|vx|\bqq\b)", re.I)
LONGNUM_RE = re.compile(r"\d{6,}")
REPEAT_RE = re.compile(r"(.)\1{5,}")

# ── 意图识别：用于给陌生人挑回复模板 ──────────────────────
GREETING_RE = re.compile(r"(你好|您好|哈喽|在吗|在不在|嗨|hello|hi\b|早上好|中午好|晚上好|晚安|"
                         r"关注你|刷到你|第一次|路过|来看看)")
QUESTION_RE = re.compile(r"[?？]|(怎么|为什么|为啥|是啥|什么|哪个|哪里|能不能|可以吗|有没有|求|教我)")
PRAISE_RE = re.compile(r"(可爱|好看|喜欢|厉害|好棒|笑死|萌|爱你|治愈|舒服)")

_KIND_LABEL = {
    "text": "文本",
    "image": "图片",
    "emoji": "表情",
    "system_recall": "撤回事件",
}


class Action(str, Enum):
    BLOCK = "block"          # 明确垃圾，丢弃（但写日志）
    REVIEW = "review"        # 不确定，进人工队列
    PROBATION = "probation"  # 陌生人观察期，允许受控回复
    NORMAL = "normal"        # 老会话，走常规回复


@dataclass
class IncomingMessage:
    """一条待处理的私信。字段都来自插件事件，不要在这里塞业务判断。"""

    msg_id: str
    conv_id: str
    sender_id: str
    text: str
    ts: float
    is_following: bool = False
    has_history: bool = False
    kind: str = "text"

    @property
    def is_stranger(self) -> bool:
        return not (self.is_following or self.has_history)


@dataclass
class GateDecision:
    action: Action
    reason: str
    intent: str = ""
    severity: int = 0

    @property
    def needs_reply(self) -> bool:
        return self.action in (Action.PROBATION, Action.NORMAL)


def _day_key(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def detect_intent(text: str) -> str:
    if GREETING_RE.search(text):
        return "greeting"
    if QUESTION_RE.search(text):
        return "question"
    if PRAISE_RE.search(text):
        return "praise"
    return "other"


class StrangerGate:
    """把"过滤"改成"分级准入"。

    evaluate() 是纯函数（不改变内部状态），配额由 reserve() 单独记账。
    这样测试可以只验证判定逻辑，不必关心计时。
    """

    def __init__(self, params: StrangerParams, rng_seed: int | None = None):
        self.params = params
        self._daily: dict[str, int] = {}
        self._probation: dict[tuple[str, str], float] = {}

    # ── 配额记账 ──────────────────────────────────────────
    def used_today(self, now: float) -> int:
        return self._daily.get(_day_key(now), 0)

    def reserve(self, now: float) -> int:
        key = _day_key(now)
        self._daily[key] = self._daily.get(key, 0) + 1
        return self._daily[key]

    def in_probation(self, conv_id: str, sender_id: str, now: float) -> bool:
        started = self._probation.get((conv_id, sender_id))
        if started is None:
            return False
        ttl = self.params.probation_ttl_minutes * 60
        return (now - started) <= ttl

    def open_probation(self, conv_id: str, sender_id: str, now: float) -> None:
        self._probation[(conv_id, sender_id)] = now

    # ── 主判定 ────────────────────────────────────────────
    def evaluate(self, msg: IncomingMessage, now: float | None = None) -> GateDecision:
        now = msg.ts if now is None else now
        text = (msg.text or "").strip()

        # 0) 非文本消息：看不到内容就不猜，但也不能装作没看见
        if msg.kind != "text":
            if not msg.is_stranger:
                return GateDecision(Action.NORMAL, f"老会话的{_KIND_LABEL.get(msg.kind, msg.kind)}消息")
            return GateDecision(Action.REVIEW, f"陌生人的{_KIND_LABEL.get(msg.kind, msg.kind)}消息，无法判断意图")

        if not text:
            return GateDecision(Action.REVIEW, "空文本")

        # 1) 硬规则：链接 / 联系方式 / 长数字 / 复读
        if LINK_RE.search(text):
            return GateDecision(Action.BLOCK, "含站外链接", severity=3)
        if CONTACT_RE.search(text):
            return GateDecision(Action.BLOCK, "含联系方式/引流词", severity=3)
        if LONGNUM_RE.search(text):
            return GateDecision(Action.BLOCK, "含疑似号码", severity=2)
        if REPEAT_RE.search(text):
            return GateDecision(Action.BLOCK, "复读刷屏", severity=2)

        low = text.lower()
        ad_hits = [w for w in self.params.ad_words if w in low]
        if len(ad_hits) >= 2:
            return GateDecision(Action.BLOCK, f"营销话术命中 {len(ad_hits)} 项", severity=2)

        # 2) 转人工：出现在任何会话里都不自动回
        handoff = [w for w in self.params.handoff_keywords if w in text]
        if handoff:
            return GateDecision(Action.REVIEW, f"含转人工词：{handoff[0]}", intent="handoff")

        # 3) 老会话直接放行
        if not msg.is_stranger:
            return GateDecision(Action.NORMAL, "已关注/有历史", intent=detect_intent(text))

        # 4) 陌生人准入
        if len(text) > 200:
            return GateDecision(Action.REVIEW, "陌生人来信过长（>200 字），疑似脚本")

        if not self.params.enable:
            # 关掉准入不等于回到"静默丢弃"，仍然进人工队列
            return GateDecision(Action.REVIEW, "陌生人准入已关闭，转人工", intent="stranger_disabled")

        intent = detect_intent(text)
        if ad_hits:
            return GateDecision(Action.REVIEW, f"疑似营销：{ad_hits[0]}", intent="ad_suspect")

        if intent in ("greeting", "question", "praise"):
            if self.in_probation(msg.conv_id, msg.sender_id, now):
                return GateDecision(Action.NORMAL, "观察期内继续对话", intent=intent)
            if self.used_today(now) >= self.params.daily_reply_limit:
                return GateDecision(Action.REVIEW, "陌生人日回复额度已用尽，转人工", intent=intent)
            return GateDecision(Action.PROBATION, f"陌生人{intent}，观察期受控回复", intent=intent)

        return GateDecision(Action.REVIEW, "陌生人意图不明", intent=intent)

    # ── 回复约束 ──────────────────────────────────────────
    def cap_chars(self, decision: GateDecision) -> int:
        """观察期比老会话更短。字数上限本身就是风控参数。"""
        if decision.action is Action.PROBATION:
            return self.params.max_chars
        return 10_000

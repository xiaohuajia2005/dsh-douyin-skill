"""主动开口护栏。

对应本地二次开发 P2：插件的 `reply()` 增加了 `proactiveKind` / `proactiveLastText`
两个参数，把"主动开口"拆成两类语义：

    reply-pending  对方最后一条还没回 —— 这次开口是**接上它**
    greet          上一句是自己说的   —— 这次是**全新问候**

这个拆分解决的是模型行为问题（别把"接话"做成"另起话题"、别翻旧账），
但它没有解决一件更要紧的事：**什么时候根本不该主动开口。**

主动私信是全套能力里风控最重的一个动作 —— 它是单向发消息，被举报的概率
比回复高一个量级，而且没有"对方先开口"这个天然授权。所以护栏必须独立存在：

    非许可会话        → BLOCK   对陌生人主动开口等于骚扰，不留口子
    连续 N 次没回应    → BLOCK   单方面刷屏是最容易被举报的形态
    静默时段          → DEFER   到点再开口
    日额度用完        → DEFER   明天再说
    会话冷却期内      → DEFER   同一人不要短时间内反复开口

默认 `enabled = false`。这不是保守过头 —— 主动开口的价值远低于它的风险，
除非你已经跑完灰度、确认对方是真人且关系成立。
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .config import ProactiveParams
from .quiet import in_quiet_hours


class ProactiveKind(str, Enum):
    REPLY_PENDING = "reply-pending"
    GREET = "greet"


class Verdict(str, Enum):
    ALLOW = "allow"
    DEFER = "defer"
    BLOCK = "block"


@dataclass
class ProactivePlan:
    verdict: Verdict
    kind: ProactiveKind
    reason: str

    @property
    def allowed(self) -> bool:
        return self.verdict is Verdict.ALLOW

    def line(self) -> str:
        label = {"allow": "允许", "defer": "延后", "block": "禁止"}[self.verdict.value]
        return f"{label} · {self.kind.value} · {self.reason}"


def _day_key(ts: float) -> str:
    import time

    return time.strftime("%Y-%m-%d", time.localtime(ts))


class ProactiveGuard:
    """一个账号一个实例。按会话记账，不跨会话共享冷却。"""

    def __init__(self, params: ProactiveParams):
        self.params = params
        self._daily: dict[str, int] = {}
        self._last_open: dict[str, float] = {}
        self._unanswered: dict[str, int] = {}

    # ── 记账 ──────────────────────────────────────────────
    def used_today(self, now: float) -> int:
        return self._daily.get(_day_key(now), 0)

    def unanswered(self, conv_id: str) -> int:
        return self._unanswered.get(conv_id, 0)

    def commit(self, conv_id: str, now: float) -> int:
        """成功主动开口一次：计入日额度、刷新冷却、未回应计数 +1。"""
        key = _day_key(now)
        self._daily[key] = self._daily.get(key, 0) + 1
        self._last_open[conv_id] = now
        self._unanswered[conv_id] = self._unanswered.get(conv_id, 0) + 1
        return self._daily[key]

    def record_response(self, conv_id: str) -> None:
        """对方回了：未回应计数清零。冷却不重置 —— 刚聊完也不该立刻再主动。"""
        self._unanswered[conv_id] = 0

    # ── 判定 ──────────────────────────────────────────────
    def plan(
        self,
        conv_id: str,
        *,
        now: float,
        permitted: bool,
        last_speaker: str = "them",
    ) -> ProactivePlan:
        p = self.params
        kind = (
            ProactiveKind.REPLY_PENDING
            if last_speaker == "them"
            else ProactiveKind.GREET
        )

        if not p.enabled:
            return ProactivePlan(Verdict.BLOCK, kind, "主动开口未开启")

        if p.only_permitted and not permitted:
            return ProactivePlan(Verdict.BLOCK, kind, "非许可会话，不对陌生人主动开口")

        if self.unanswered(conv_id) >= p.max_unanswered:
            return ProactivePlan(
                Verdict.BLOCK, kind,
                f"连续 {self.unanswered(conv_id)} 次主动都未获回应，停止单方面开口",
            )

        if in_quiet_hours(now, p.quiet_hours):
            return ProactivePlan(Verdict.DEFER, kind, "静默时段")

        if self.used_today(now) >= p.daily_limit:
            return ProactivePlan(
                Verdict.DEFER, kind,
                f"今日主动开口已达 {p.daily_limit} 次上限",
            )

        last = self._last_open.get(conv_id)
        if last is not None:
            cooling = p.per_conversation_cooldown_minutes * 60 - (now - last)
            if cooling > 0:
                return ProactivePlan(
                    Verdict.DEFER, kind,
                    f"距上次开口不足 {p.per_conversation_cooldown_minutes} 分钟，还需 {cooling / 60:.0f} 分钟",
                )

        reason = (
            "接上对方未回的那条" if kind is ProactiveKind.REPLY_PENDING else "对方最后一条是自己说的，走全新问候"
        )
        return ProactivePlan(Verdict.ALLOW, kind, reason)

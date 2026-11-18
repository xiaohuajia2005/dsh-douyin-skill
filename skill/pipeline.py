"""处理链：撤回 → 准入 → 会话状态 → 幂等 → 发送。

顺序是有讲究的，不要随意调换：

    撤回事件          先于一切。撤回的消息不该有任何后续动作。
      ↓
    陌生人准入        决定"要不要回、谁来回"。
      ↓
    静默时段          到点不发，进待发队列（不是丢弃）。
      ↓
    会话状态机        会话在退避/停机时，消息排队而不是消失。
      ↓
    幂等去重          同一 (会话, 消息, 正文) 只发一次。
      ↓
    发送              成功/失败都落审计。

每一步的默认动作都是"留在队列里"，而不是"丢掉"。
这是本项目对原版最根本的一处改动 —— 原版所有异常分支的默认动作都是丢弃。
"""
from __future__ import annotations

import random
import time
from dataclasses import dataclass, field

from .config import Settings
from .quiet import in_quiet_hours as _in_quiet_hours
from .recall_guard import RecallGuard
from .session_guard import SessionGuard, SessionState
from .stranger_gate import Action, GateDecision, IncomingMessage, StrangerGate

# 陌生人/新会话的兜底话术。短、不带钩子、不承诺任何事。
REPLY_TEMPLATES = {
    "greeting": "唔 在的 你说 🫧",
    "question": "唔 这个我得想想",
    "praise": "唔 谢谢 我脸红了",
    "other": "唔 我听见了",
    "handoff": "",
}


@dataclass
class Outcome:
    seq: int
    conv_id: str
    kind: str
    action: str
    reason: str
    reply: str = ""
    note: str = ""

    @property
    def is_reply(self) -> bool:
        return self.action == "replied"


@dataclass
class RelayStats:
    total: int = 0
    replied: int = 0
    blocked: int = 0
    review: int = 0
    deferred: int = 0
    queued: int = 0
    recalled: int = 0
    duplicate: int = 0
    silent_dropped: int = 0
    original_dropped: int = 0

    def as_rows(self) -> list[tuple[str, int]]:
        return [
            ("已回复", self.replied),
            ("拦截(垃圾)", self.blocked),
            ("转人工队列", self.review),
            ("静默时段待发", self.deferred),
            ("会话异常排队", self.queued),
            ("撤回失效", self.recalled),
            ("重复消息跳过", self.duplicate),
        ]


class ReplyComposer:
    """生成一句话回复。模板优先 —— 输出越短，越不会跑偏，也越便宜。"""

    def __init__(self, settings: Settings):
        self.settings = settings

    def compose(self, decision: GateDecision, max_chars: int) -> str | None:
        text = REPLY_TEMPLATES.get(decision.intent, REPLY_TEMPLATES["other"]).strip()
        if not text:
            return None
        if len(text) > max_chars:
            return None
        low = text.lower()
        if any(w.lower() in low for w in self.settings.dm.never_say):
            return None
        return text


class DMRelay:
    def __init__(self, settings: Settings, rng: random.Random | None = None):
        self.settings = settings
        self.gate = StrangerGate(settings.stranger)
        self.guard = SessionGuard(settings.session, rng=rng)
        self.recall = RecallGuard(settings.recall)
        self.composer = ReplyComposer(settings)
        self.reviews: list[IncomingMessage] = []
        self.deferred: list[tuple[IncomingMessage, str]] = []
        self.outcomes: list[Outcome] = []
        self.stats = RelayStats()
        self._seq = 0

    # ── 主入口 ────────────────────────────────────────────
    def process(
        self,
        msg: IncomingMessage,
        now: float | None = None,
        send_ok: bool = True,
        send_error: str | None = None,
        original_would_drop: bool = False,
    ) -> Outcome:
        now = msg.ts if now is None else now
        self._seq += 1
        self.stats.total += 1
        if original_would_drop:
            self.stats.original_dropped += 1

        # 1) 撤回事件
        if msg.kind == "system_recall":
            result = self.recall.on_recall(msg.conv_id, msg.msg_id, now)
            self.stats.recalled += 1
            return self._emit(msg, "recalled", f"撤回事件：{result}", note="对应待发回复已失效")

        # 2) 准入判定
        decision = self.gate.evaluate(msg, now)

        if decision.action is Action.BLOCK:
            self.stats.blocked += 1
            return self._emit(msg, "blocked", decision.reason, note="写审计日志，不回复")

        if decision.action is Action.REVIEW:
            self.reviews.append(msg)
            self.stats.review += 1
            return self._emit(msg, "review", decision.reason, note="进人工队列，界面可见")

        # 3) 生成回复
        cap = min(self.settings.dm.max_chars, self.gate.cap_chars(decision))
        reply = self.composer.compose(decision, cap)
        if reply is None:
            self.reviews.append(msg)
            self.stats.review += 1
            return self._emit(msg, "review", f"{decision.reason}；无合规话术可用", note="进人工队列")

        # 4) 先登记为待发。必须在所有"延后发送"的判断之前，
        #    否则静默时段/会话退避期间的消息不会留下待发记录，撤回就命不中。
        item = self.recall.register(msg.conv_id, msg.msg_id, reply, now)

        # 5) 静默时段
        if _in_quiet_hours(now, self.settings.dm.quiet_hours):
            self.deferred.append((msg, "quiet_hours"))
            self.stats.deferred += 1
            return self._emit(msg, "deferred", "静默时段", reply=reply, note="进待发队列，到点补发")

        # 6) 会话状态
        if not self.guard.can_attempt(now):
            self.deferred.append((msg, "session"))
            self.stats.queued += 1
            st = self.guard.status(now)
            return self._emit(msg, "queued", f"会话{st.line()}", reply=reply,
                              note="消息排队，恢复后补发（原版会永久跳过）")

        # 7) 幂等
        if not self.recall.should_send(msg.conv_id, msg.msg_id, reply, now):
            self.stats.duplicate += 1
            return self._emit(msg, "duplicate", "幂等键命中，已发过", reply=reply,
                              note="同一条消息只回一次")

        # 8) 发送
        if not self.guard.begin_recovery(now):
            self.deferred.append((msg, "session"))
            self.stats.queued += 1
            return self._emit(msg, "queued", "会话恢复预算用尽", reply=reply, note="转人工接管")

        if send_ok:
            self.recall.mark_sent(item, now)
            self.guard.record_success(now)
            if decision.action is Action.PROBATION:
                self.gate.reserve(now)
                self.gate.open_probation(msg.conv_id, msg.sender_id, now)
            self.stats.replied += 1
            tag = "" if decision.action is Action.PROBATION else " · 常规回复"
            return self._emit(msg, "replied", f"{decision.reason}{tag}", reply=reply)

        # 发送失败：结果不明，不重发，但消息留在队列里
        self.recall.mark_unknown(item, now)
        state = self.guard.record_failure(send_error, now)
        self.deferred.append((msg, "send_failed"))
        self.stats.queued += 1
        return self._emit(
            msg, "queued",
            f"发送失败：{send_error or '未知'}",
            reply=reply,
            note=f"已置为结果不明不重发；会话 {state.value}；消息排队",
        )

    # ── 辅助 ──────────────────────────────────────────────
    def _emit(self, msg: IncomingMessage, action: str, reason: str,
              reply: str = "", note: str = "") -> Outcome:
        out = Outcome(
            seq=self._seq,
            conv_id=msg.conv_id,
            kind=msg.kind,
            action=action,
            reason=reason,
            reply=reply,
            note=note,
        )
        self.outcomes.append(out)
        return out

    def session_line(self, now: float | None = None) -> str:
        return self.guard.status(now).line()

    @property
    def is_halted(self) -> bool:
        return self.guard.state is SessionState.HALTED

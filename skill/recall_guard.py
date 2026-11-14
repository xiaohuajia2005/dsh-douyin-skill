"""修复 #3：撤回、重复发送、发送结果不明。

这三个问题在原版里是同一类：**发送侧没有幂等键**。
现象有三种表现：

1. 对方撤回消息后，待发队列里的回复照发不误 —— 对着空气回一句。
2. 一次请求超时（实际已发出），重试后对方收到两遍同样的话。
3. 发送结果不明时插件既不敢重发也不标记，消息卡在内存里，
   进程重启就永久消失。

修法是把"要不要发"从时序问题变成状态问题：
- 每条待发回复登记成 PendingReply，带 pending/sent/cancelled/unknown 四种状态；
- 撤回事件按 (conv_id, msg_id) 精确命中并置为 cancelled，发送前必须过这一关；
- 幂等键 = (会话, 消息, 正文哈希)，窗口内只发一次；
- 结果不明一律置 unknown 且**不重发**，进人工核对队列。
  宁可少发一条，也不要让同一个粉丝收到两遍 —— 后者是举报的常见理由。

关于"发送后撤回"：本模块只记录，不尝试去平台侧删除。
删除是个更重的外部动作，失败率高且更容易触发风控，不值得自动化。
"""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

from .config import RecallParams


class PendingStatus:
    PENDING = "pending"
    SENT = "sent"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"
    RECALLED_AFTER_SEND = "recalled_after_send"


@dataclass
class PendingReply:
    conv_id: str
    msg_id: str
    text: str
    created_at: float
    status: str = PendingStatus.PENDING

    @property
    def sendable(self) -> bool:
        return self.status == PendingStatus.PENDING


class RecallGuard:
    def __init__(self, params: RecallParams):
        self.params = params
        self._pending: dict[tuple[str, str], PendingReply] = {}
        self._seen: dict[str, float] = {}

    # ── 幂等 ──────────────────────────────────────────────
    @staticmethod
    def idempotency_key(conv_id: str, msg_id: str, text: str) -> str:
        raw = f"{conv_id}|{msg_id}|{text.strip()}".encode("utf-8")
        return hashlib.sha1(raw).hexdigest()[:16]

    def should_send(self, conv_id: str, msg_id: str, text: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        key = self.idempotency_key(conv_id, msg_id, text)
        last = self._seen.get(key)
        if last is not None and (now - last) < self.params.dedupe_seconds:
            return False
        return True

    def _mark_key(self, conv_id: str, msg_id: str, text: str, now: float) -> None:
        self._seen[self.idempotency_key(conv_id, msg_id, text)] = now

    # ── 待发队列 ──────────────────────────────────────────
    def register(self, conv_id: str, msg_id: str, text: str, now: float | None = None) -> PendingReply:
        now = time.time() if now is None else now
        item = PendingReply(conv_id=conv_id, msg_id=msg_id, text=text, created_at=now)
        self._pending[(conv_id, msg_id)] = item
        return item

    def take(self, conv_id: str, msg_id: str, now: float | None = None) -> PendingReply | None:
        """取出一条仍可发送的回复。过期或已取消都返回 None。"""
        now = time.time() if now is None else now
        item = self._pending.get((conv_id, msg_id))
        if item is None or not item.sendable:
            return None
        if (now - item.created_at) > self.params.pending_ttl_seconds:
            item.status = PendingStatus.CANCELLED
            return None
        return item

    def mark_sent(self, item: PendingReply, now: float | None = None) -> None:
        now = time.time() if now is None else now
        item.status = PendingStatus.SENT
        self._mark_key(item.conv_id, item.msg_id, item.text, now)

    def mark_unknown(self, item: PendingReply, now: float | None = None) -> None:
        """发送结果不明：不重发，但占住幂等键，避免下一次又发一遍。"""
        now = time.time() if now is None else now
        item.status = PendingStatus.UNKNOWN
        self._mark_key(item.conv_id, item.msg_id, item.text, now)

    # ── 撤回 ──────────────────────────────────────────────
    def on_recall(self, conv_id: str, msg_id: str, now: float | None = None) -> str:
        """返回处理结果字符串，直接进审计日志。"""
        item = self._pending.get((conv_id, msg_id))
        if item is None:
            return "no_reply_pending"
        if item.status == PendingStatus.SENT:
            item.status = PendingStatus.RECALLED_AFTER_SEND
            return "recalled_after_send"
        item.status = PendingStatus.CANCELLED
        return "cancelled"

    def prune(self, now: float | None = None) -> int:
        now = time.time() if now is None else now
        dead = [
            k for k, v in self._pending.items()
            if v.status in (PendingStatus.CANCELLED, PendingStatus.RECALLED_AFTER_SEND)
            or (now - v.created_at) > self.params.pending_ttl_seconds * 2
        ]
        for k in dead:
            del self._pending[k]
        return len(dead)

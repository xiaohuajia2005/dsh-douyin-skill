"""修复 #2：会话暂停后不再永久停摆。

原版行为（现象）
----------------
插件检测到"会话暂停"（页面被切到别的标签、发送连续失败、平台弹了限流提示），
就把当前会话标记成 paused 并跳过。问题是这个标记**没有出口**：
后续消息全被跳过，只能重启插件才恢复。表现是"机器人还活着，但某个粉丝
再也没收到过回复"，而且界面上看不出异常。

根因
----
paused 被当成一个布尔开关，而不是一个状态。布尔量没有"恢复"这个转移，
于是第一次异常就成了终点。

修法
----
换成显式状态机，四种状态，转移明确：

    RUNNING ──失败──> SUSPENDED ──退避到点──> RECOVERING ──成功──> RUNNING
                           │                        │
                           └─────超预算/平台限流─────┴──> HALTED（等人）

三条硬约束，比"重试"本身更重要：
1. **退避带抖动**。固定 30 秒重试等于告诉平台"我是脚本"。
2. **恢复预算**。30 分钟内最多自动恢复 3 次；超了就是 HALTED，
   因为越试越糟是风控场景的常态，不是例外。
3. **平台侧明确停你 → 直接 HALTED，不重试**。验证码、限流提示这类信号
   继续发只会升级处置（限流 → 封私信 → 封号）。
"""
from __future__ import annotations

import random
import time
from collections import deque
from dataclasses import dataclass
from enum import Enum

from .config import SessionParams


class SessionState(str, Enum):
    RUNNING = "running"
    SUSPENDED = "suspended"
    RECOVERING = "recovering"
    HALTED = "halted"


class FailureKind(str, Enum):
    TRANSIENT = "transient"            # 超时、元素没找到、页面抖动：值得重试
    PLATFORM_PAUSE = "platform_pause"  # 平台明确限制：不能重试
    AUTH = "auth"                      # 登录态失效：必须人工扫码


AUTH_HINTS = ("未登录", "登录失效", "登录已过期", "重新扫码", "token", "401")
PLATFORM_HINTS = (
    "验证码", "操作频繁", "稍后再试", "请求过于频繁", "访问受限",
    "账号异常", "环境异常", "被限制", "风控", "行为异常",
)


def classify_failure(error: str | None) -> FailureKind:
    low = (error or "").lower()
    if any(h in low for h in AUTH_HINTS):
        return FailureKind.AUTH
    if any(h in low for h in PLATFORM_HINTS):
        return FailureKind.PLATFORM_PAUSE
    return FailureKind.TRANSIENT


@dataclass
class SessionStatus:
    conv_id: str
    state: str
    consecutive_failures: int
    retry_in: float
    resumes_in_window: int
    halt_reason: str

    def line(self) -> str:
        if self.state == SessionState.HALTED.value:
            return f"停机 · {self.halt_reason}"
        if self.state == SessionState.SUSPENDED.value:
            return f"退避中 · {self.retry_in:.0f}s 后重试"
        if self.state == SessionState.RECOVERING.value:
            return "恢复中"
        return "正常"


class SessionGuard:
    """单个会话的状态机。一个会话一个实例，不要跨会话共享。"""

    def __init__(self, params: SessionParams, conv_id: str = "", rng: random.Random | None = None):
        self.params = params
        self.conv_id = conv_id
        self.state = SessionState.RUNNING
        self.consecutive_failures = 0
        self.next_retry_at = 0.0
        self.halt_reason = ""
        self.last_error = ""
        self._resumes: deque[float] = deque()
        self._rng = rng or random.Random()

    # ── 内部工具 ──────────────────────────────────────────
    def _backoff(self, n: int) -> float:
        raw = min(self.params.backoff_base_seconds * (2 ** (n - 1)), self.params.backoff_cap_seconds)
        r = self.params.jitter_ratio
        if r > 0:
            raw *= 1.0 + self._rng.uniform(-r, r)
        return raw

    def _prune(self, now: float) -> None:
        window = self.params.window_minutes * 60
        while self._resumes and (now - self._resumes[0]) > window:
            self._resumes.popleft()

    def _halt(self, reason: str) -> None:
        self.state = SessionState.HALTED
        self.halt_reason = reason

    # ── 对外接口 ──────────────────────────────────────────
    def record_success(self, now: float | None = None) -> SessionState:
        self.state = SessionState.RUNNING
        self.consecutive_failures = 0
        self.next_retry_at = 0.0
        self.halt_reason = ""
        self.last_error = ""
        return self.state

    def record_failure(self, error: str | None, now: float | None = None) -> SessionState:
        now = time.time() if now is None else now
        kind = classify_failure(error)
        self.last_error = error or ""

        if kind is FailureKind.AUTH:
            self._halt("登录态失效，需要重新扫码")
            return self.state

        if kind is FailureKind.PLATFORM_PAUSE and self.params.halt_on_platform_pause:
            self._halt(f"平台侧暂停：{error}")
            return self.state

        self.consecutive_failures += 1
        self.next_retry_at = now + self._backoff(self.consecutive_failures)
        self.state = SessionState.SUSPENDED

        if self.consecutive_failures >= self.params.max_consecutive_failures:
            self._prune(now)
            if len(self._resumes) >= self.params.max_resumes_per_window:
                self._halt(
                    f"连续失败 {self.consecutive_failures} 次，且 "
                    f"{self.params.window_minutes:.0f} 分钟内恢复预算已用尽"
                )
        return self.state

    def can_attempt(self, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        if self.state is SessionState.HALTED:
            return False
        return now >= self.next_retry_at

    def begin_recovery(self, now: float | None = None) -> bool:
        """退避到点后调用。返回 False 表示不许发，调用方应把消息留在待发队列。"""
        now = time.time() if now is None else now
        if self.state is SessionState.HALTED:
            return False
        if now < self.next_retry_at:
            return False

        # 本来就在正常运行，没有"恢复"这回事，不占用恢复预算。
        # 少了这个分支，每次正常发送都会吃掉一次预算，几次之后就被误判停机。
        if self.state is SessionState.RUNNING:
            return True

        self._prune(now)
        if len(self._resumes) >= self.params.max_resumes_per_window:
            self._halt("恢复预算耗尽，停止自动重试")
            return False

        self._resumes.append(now)
        self.state = SessionState.RECOVERING
        return True

    def status(self, now: float | None = None) -> SessionStatus:
        now = time.time() if now is None else now
        self._prune(now)
        return SessionStatus(
            conv_id=self.conv_id,
            state=self.state.value,
            consecutive_failures=self.consecutive_failures,
            retry_in=max(0.0, self.next_retry_at - now),
            resumes_in_window=len(self._resumes),
            halt_reason=self.halt_reason,
        )

"""会话状态机的回归测试。

原版的问题不是"重试不够多"，而是**没有恢复路径**。
这里锁死三件事：退避要带节奏、恢复有预算、平台喊停必须真停。
"""
from __future__ import annotations

import unittest

from skill.config import SessionParams
from skill.session_guard import FailureKind, SessionGuard, SessionState, classify_failure


def params(**kw) -> SessionParams:
    base = dict(
        max_consecutive_failures=3,
        backoff_base_seconds=30.0,
        backoff_cap_seconds=600.0,
        jitter_ratio=0.0,          # 测试里关掉抖动，否则断言不了具体秒数
        max_resumes_per_window=3,
        window_minutes=30.0,
        halt_on_platform_pause=True,
    )
    base.update(kw)
    return SessionParams(**base)


class SessionGuardTest(unittest.TestCase):
    def test_success_keeps_running(self) -> None:
        guard = SessionGuard(params())
        self.assertIs(guard.record_success(0), SessionState.RUNNING)
        self.assertTrue(guard.can_attempt(0))

    def test_transient_failure_suspends(self) -> None:
        guard = SessionGuard(params())
        state = guard.record_failure("Element not found: send-button", now=0)
        self.assertIs(state, SessionState.SUSPENDED)
        self.assertFalse(guard.can_attempt(0))
        self.assertTrue(guard.can_attempt(31))

    def test_backoff_grows_then_caps(self) -> None:
        guard = SessionGuard(params(jitter_ratio=0.0))
        guard.record_failure("timeout", now=0)
        self.assertAlmostEqual(guard.next_retry_at, 30.0)
        guard.record_failure("timeout", now=1000)
        self.assertAlmostEqual(guard.next_retry_at - 1000, 60.0)
        last = 0.0
        for i in range(10):
            last = 2000 + i * 10000
            guard.record_failure("timeout", now=last)
        self.assertAlmostEqual(guard.next_retry_at - last, 600.0, msg="退避应当封顶在 backoff_cap")

    def test_platform_pause_halts_immediately(self) -> None:
        guard = SessionGuard(params())
        state = guard.record_failure("操作频繁，请稍后再试", now=0)
        self.assertIs(state, SessionState.HALTED)
        self.assertFalse(guard.can_attempt(10 ** 9))
        self.assertIn("平台", guard.halt_reason)

    def test_captcha_halts(self) -> None:
        guard = SessionGuard(params())
        self.assertIs(guard.record_failure("出现验证码", now=0), SessionState.HALTED)

    def test_auth_failure_halts(self) -> None:
        guard = SessionGuard(params())
        self.assertIs(guard.record_failure("登录已过期，请重新扫码", now=0), SessionState.HALTED)
        self.assertIn("扫码", guard.halt_reason)

    def test_resume_budget_exhausted(self) -> None:
        guard = SessionGuard(params())
        now = 0.0
        for i in range(3):
            guard.record_failure("timeout", now=now)
            now = guard.next_retry_at + 1
            self.assertTrue(guard.begin_recovery(now=now), f"第 {i + 1} 次恢复应当允许")
        # 第 4 次：预算已经用掉 3 次
        guard.record_failure("timeout", now=now)
        now = guard.next_retry_at + 1
        self.assertFalse(guard.begin_recovery(now=now), "第 4 次必须拒绝")
        self.assertIs(guard.state, SessionState.HALTED)

    def test_budget_window_slides(self) -> None:
        guard = SessionGuard(params(backoff_base_seconds=1.0))
        for i in range(3):
            guard.record_failure("timeout", now=i * 10)
            self.assertTrue(guard.begin_recovery(now=i * 10 + 5))
        self.assertEqual(guard.status(30).resumes_in_window, 3)
        # 窗口滑过去之后预算刷新
        self.assertTrue(guard.begin_recovery(now=2000), "30 分钟窗口外的记录不该继续占预算")
        self.assertFalse(guard.state is SessionState.HALTED)

    def test_running_send_does_not_consume_budget(self) -> None:
        """正常发送不该吃掉恢复预算，否则跑几条就会被误判停机。"""
        guard = SessionGuard(params())
        for i in range(10):
            self.assertTrue(guard.begin_recovery(now=i))
            guard.record_success(now=i)
        self.assertEqual(guard.status(10).resumes_in_window, 0)
        self.assertIs(guard.state, SessionState.RUNNING)

    def test_success_resets_counter(self) -> None:
        guard = SessionGuard(params())
        guard.record_failure("timeout", now=0)
        guard.record_success(5)
        self.assertIs(guard.state, SessionState.RUNNING)
        self.assertEqual(guard.consecutive_failures, 0)
        self.assertTrue(guard.can_attempt(5))

    def test_recovery_blocked_before_backoff(self) -> None:
        guard = SessionGuard(params())
        guard.record_failure("timeout", now=0)
        self.assertFalse(guard.begin_recovery(now=1))
        self.assertTrue(guard.begin_recovery(now=30))

    def test_classification(self) -> None:
        self.assertIs(classify_failure("请稍后再试"), FailureKind.PLATFORM_PAUSE)
        self.assertIs(classify_failure("登录失效"), FailureKind.AUTH)
        self.assertIs(classify_failure("timeout"), FailureKind.TRANSIENT)
        self.assertIs(classify_failure(None), FailureKind.TRANSIENT)


if __name__ == "__main__":
    unittest.main()

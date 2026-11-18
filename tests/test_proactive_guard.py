"""主动开口护栏的回归测试。

这个能力的风险比"回复"高得多：单向发送、没有对方先开口的授权。
所以每条规则都要有测试守着，尤其是"对陌生人不主动"和"连续未回应要停"。
"""
from __future__ import annotations

import unittest
from datetime import datetime

from skill.config import ProactiveParams
from skill.proactive_guard import ProactiveGuard, ProactiveKind, Verdict


def at(hour: int, minute: int = 0) -> float:
    return datetime(2026, 11, 10, hour, minute).timestamp()


def params(**kw) -> ProactiveParams:
    base = dict(
        enabled=True,
        daily_limit=3,
        per_conversation_cooldown_minutes=360,
        max_unanswered=2,
        quiet_hours=("00:00", "08:00"),
        only_permitted=True,
    )
    base.update(kw)
    return ProactiveParams(**base)


class ProactiveGuardTest(unittest.TestCase):
    def test_disabled_by_default_blocks(self) -> None:
        guard = ProactiveGuard(ProactiveParams())
        plan = guard.plan("c_1", now=at(10), permitted=True)
        self.assertIs(plan.verdict, Verdict.BLOCK)
        self.assertIn("未开启", plan.reason)

    def test_never_proactive_to_stranger(self) -> None:
        guard = ProactiveGuard(params())
        plan = guard.plan("c_9", now=at(10), permitted=False)
        self.assertIs(plan.verdict, Verdict.BLOCK)
        self.assertIn("陌生人", plan.reason)

    def test_kind_split(self) -> None:
        guard = ProactiveGuard(params())
        waiting = guard.plan("c_1", now=at(10), permitted=True, last_speaker="them")
        self.assertIs(waiting.verdict, Verdict.ALLOW)
        self.assertIs(waiting.kind, ProactiveKind.REPLY_PENDING)

        greet = guard.plan("c_2", now=at(10), permitted=True, last_speaker="me")
        self.assertIs(greet.verdict, Verdict.ALLOW)
        self.assertIs(greet.kind, ProactiveKind.GREET)

    def test_quiet_hours_defers(self) -> None:
        guard = ProactiveGuard(params())
        plan = guard.plan("c_1", now=at(3, 30), permitted=True)
        self.assertIs(plan.verdict, Verdict.DEFER)
        self.assertEqual(plan.reason, "静默时段")

    def test_cooldown_defers(self) -> None:
        guard = ProactiveGuard(params())
        guard.commit("c_1", at(10))
        plan = guard.plan("c_1", now=at(11), permitted=True)
        self.assertIs(plan.verdict, Verdict.DEFER)
        self.assertIn("分钟", plan.reason)

    def test_cooldown_expires(self) -> None:
        guard = ProactiveGuard(params())
        guard.commit("c_1", at(10))
        plan = guard.plan("c_1", now=at(16, 1), permitted=True)
        self.assertIs(plan.verdict, Verdict.ALLOW)

    def test_daily_limit_defers(self) -> None:
        guard = ProactiveGuard(params())
        for i in range(3):
            guard.commit(f"c_{i}", at(10))
        plan = guard.plan("c_9", now=at(11), permitted=True)
        self.assertIs(plan.verdict, Verdict.DEFER)
        self.assertIn("上限", plan.reason)

    def test_unanswered_streak_blocks(self) -> None:
        guard = ProactiveGuard(params())
        guard.commit("c_1", at(9))
        guard.commit("c_1", at(10))
        plan = guard.plan("c_1", now=at(20), permitted=True)
        self.assertIs(plan.verdict, Verdict.BLOCK)
        self.assertIn("未获回应", plan.reason)

    def test_response_resets_streak(self) -> None:
        guard = ProactiveGuard(params())
        guard.commit("c_1", at(9))
        guard.commit("c_1", at(10))
        guard.record_response("c_1")
        plan = guard.plan("c_1", now=at(20), permitted=True)
        self.assertIs(plan.verdict, Verdict.ALLOW)

    def test_commit_counts_daily(self) -> None:
        guard = ProactiveGuard(params())
        self.assertEqual(guard.commit("c_1", at(10)), 1)
        self.assertEqual(guard.commit("c_2", at(10)), 2)
        self.assertEqual(guard.used_today(at(11)), 2)

    def test_defer_still_has_destination(self) -> None:
        """延后不是丢弃：判定必须给出可执行的原因。"""
        guard = ProactiveGuard(params())
        for label, ts in [("静默", at(3)), ("常规", at(12))]:
            plan = guard.plan("c_x", now=ts, permitted=True)
            self.assertTrue(plan.reason, f"{label} 情形必须有原因")


if __name__ == "__main__":
    unittest.main()

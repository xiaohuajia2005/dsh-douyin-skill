"""撤回与幂等的回归测试。

核心断言只有一句：撤回之后，那条回复绝不能再发出去。
"""
from __future__ import annotations

import unittest

from skill.config import RecallParams
from skill.recall_guard import PendingStatus, RecallGuard

NOW = 1_760_000_000.0


class RecallGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.guard = RecallGuard(RecallParams())

    def test_recall_cancels_pending(self) -> None:
        item = self.guard.register("c_1", "m_1", "唔 在的 你说", NOW)
        result = self.guard.on_recall("c_1", "m_1", NOW + 5)
        self.assertEqual(result, "cancelled")
        self.assertEqual(item.status, PendingStatus.CANCELLED)
        self.assertIsNone(self.guard.take("c_1", "m_1", NOW + 6), "撤回后的回复必须不可发送")

    def test_recall_after_send_only_marks(self) -> None:
        item = self.guard.register("c_1", "m_2", "唔 我听见了", NOW)
        self.guard.mark_sent(item, NOW)
        result = self.guard.on_recall("c_1", "m_2", NOW + 3)
        self.assertEqual(result, "recalled_after_send")
        self.assertEqual(item.status, PendingStatus.RECALLED_AFTER_SEND,
                         "已发送的只记录，不尝试删除（删除是更重的外部动作）")

    def test_recall_unknown_message_is_noop(self) -> None:
        self.assertEqual(self.guard.on_recall("c_9", "m_9", NOW), "no_reply_pending")

    def test_expired_pending_is_not_sendable(self) -> None:
        self.guard.register("c_1", "m_3", "唔 谢谢", NOW)
        self.assertIsNone(self.guard.take("c_1", "m_3", NOW + 10_000))

    def test_dedupe_blocks_second_send(self) -> None:
        item = self.guard.register("c_1", "m_4", "唔 在的", NOW)
        self.assertTrue(self.guard.should_send("c_1", "m_4", "唔 在的", NOW))
        self.guard.mark_sent(item, NOW)
        self.assertFalse(self.guard.should_send("c_1", "m_4", "唔 在的", NOW + 60),
                         "同一条消息不能回两遍，否则用户会收到重复内容")

    def test_unknown_result_blocks_resend(self) -> None:
        item = self.guard.register("c_1", "m_5", "唔 我看看", NOW)
        self.guard.mark_unknown(item, NOW)
        self.assertFalse(self.guard.should_send("c_1", "m_5", "唔 我看看", NOW + 1),
                         "结果不明时宁可少发一条，也不能重复发")

    def test_dedupe_window_expires(self) -> None:
        item = self.guard.register("c_1", "m_6", "唔 好", NOW)
        self.guard.mark_sent(item, NOW)
        self.assertTrue(self.guard.should_send("c_1", "m_6", "唔 好", NOW + 86401))


if __name__ == "__main__":
    unittest.main()

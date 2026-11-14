"""端到端：一条私信从进来到有去向，必须落在这 7 个动作之一。

这个测试守的是整套改动的总目标 —— 原版那些"什么都不做"的路径，
在这里全都有明确出口。
"""
from __future__ import annotations

import unittest
from datetime import datetime

from skill.config import Settings
from skill.pipeline import DMRelay
from skill.stranger_gate import IncomingMessage

KNOWN_ACTIONS = {"replied", "blocked", "review", "deferred", "queued", "recalled", "duplicate"}


def at(hour: int, minute: int, second: int = 0) -> float:
    return datetime(2026, 11, 10, hour, minute, second).timestamp()


def msg(text: str, *, ts: float, conv: str = "c_1", sid: str = "u_1",
        mid: str = "m_1", kind: str = "text", following: bool = False) -> IncomingMessage:
    return IncomingMessage(
        msg_id=mid, conv_id=conv, sender_id=sid, text=text, ts=ts,
        is_following=following, has_history=following, kind=kind,
    )


class PipelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.relay = DMRelay(Settings())

    def test_stranger_gets_reply(self) -> None:
        """修复 #1 的验收点：陌生人的第一条真的得到了回复。"""
        out = self.relay.process(msg("你好呀，刷到你的视频了", ts=at(10, 0)))
        self.assertEqual(out.action, "replied")
        self.assertIn("观察期", out.reason)
        self.assertTrue(out.reply)

    def test_paused_session_queues_instead_of_dropping(self) -> None:
        """修复 #2 的验收点：会话异常时消息排队，不会消失。"""
        first = self.relay.process(
            msg("在吗", ts=at(10, 20), mid="m_1"),
            send_ok=False, send_error="Element not found: send-button",
        )
        self.assertEqual(first.action, "queued")

        second = self.relay.process(msg("你好", ts=at(10, 20, 10), mid="m_2", conv="c_2"))
        self.assertEqual(second.action, "queued")
        self.assertEqual(len(self.relay.deferred), 2)

    def test_quiet_hours_defers(self) -> None:
        out = self.relay.process(msg("在吗 想问个事", ts=at(3, 12)))
        self.assertEqual(out.action, "deferred")
        self.assertEqual(out.reason, "静默时段")

    def test_recall_cancels_deferred_reply(self) -> None:
        """修复 #3 的验收点：撤回之后，排队中的回复失效。"""
        self.relay.process(msg("在吗 想问个事", ts=at(3, 12), mid="m_7"))
        out = self.relay.process(msg("", ts=at(3, 13), mid="m_7", kind="system_recall"))
        self.assertEqual(out.action, "recalled")
        self.assertIn("cancelled", out.reason)
        self.assertIsNone(self.relay.recall.take("c_1", "m_7", at(3, 14)))

    def test_duplicate_message_skipped(self) -> None:
        self.relay.process(msg("你好呀", ts=at(10, 0), mid="dup"))
        out = self.relay.process(msg("你好呀", ts=at(10, 30), mid="dup"))
        self.assertEqual(out.action, "duplicate")

    def test_platform_pause_halts_relay(self) -> None:
        self.relay.process(
            msg("在吗", ts=at(10, 0)),
            send_ok=False, send_error="操作频繁，请稍后再试",
        )
        self.assertTrue(self.relay.is_halted)
        after = self.relay.process(msg("哈喽", ts=at(10, 5), mid="m_3", conv="c_3"))
        self.assertEqual(after.action, "queued")

    def test_every_message_has_destination(self) -> None:
        samples = [
            ("你好", at(10, 0)),
            ("加我微信 abc123", at(10, 1)),
            ("商务合作报价", at(10, 2)),
            ("", at(3, 0)),
            ("嗯", at(10, 3)),
        ]
        for i, (text, ts) in enumerate(samples):
            with self.subTest(text=text[:10]):
                out = self.relay.process(msg(text, ts=ts, mid=f"x{i}", conv=f"cx{i}"))
                self.assertIn(out.action, KNOWN_ACTIONS)
                self.assertTrue(out.reason)


if __name__ == "__main__":
    unittest.main()

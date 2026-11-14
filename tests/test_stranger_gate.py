"""陌生人准入的回归测试。

重点不是"能拦住垃圾"，而是**没有任何一条消息被静默丢弃**。
原版的 bug 就出在这里：不确定的情况被当成"不用管"。
"""
from __future__ import annotations

import unittest

from skill.config import StrangerParams
from skill.stranger_gate import Action, IncomingMessage, StrangerGate, detect_intent

NOW = 1_760_000_000.0


def build(text: str, *, kind: str = "text", following: bool = False,
          history: bool = False, conv: str = "c_1", sid: str = "u_1") -> IncomingMessage:
    return IncomingMessage(
        msg_id="m_1", conv_id=conv, sender_id=sid, text=text, ts=NOW,
        is_following=following, has_history=history, kind=kind,
    )


class StrangerGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.gate = StrangerGate(StrangerParams())

    # ── 修复点：陌生人的第一条不再被吃 ──────────────────
    def test_stranger_greeting_enters_probation(self) -> None:
        out = self.gate.evaluate(build("你好呀，刷到你的视频了"))
        self.assertIs(out.action, Action.PROBATION)
        self.assertEqual(out.intent, "greeting")

    def test_stranger_question_enters_probation(self) -> None:
        out = self.gate.evaluate(build("你平时都吃什么呀？"))
        self.assertIs(out.action, Action.PROBATION)
        self.assertEqual(out.intent, "question")

    def test_stranger_praise_enters_probation(self) -> None:
        out = self.gate.evaluate(build("好可爱啊"))
        self.assertIs(out.action, Action.PROBATION)
        self.assertEqual(out.intent, "praise")

    # ── 该拦的还得拦 ────────────────────────────────────
    def test_contact_info_blocked(self) -> None:
        self.assertIs(self.gate.evaluate(build("加我微信 abc123")).action, Action.BLOCK)

    def test_link_blocked(self) -> None:
        self.assertIs(self.gate.evaluate(build("看这里 www.example.com")).action, Action.BLOCK)

    def test_repeat_spam_blocked(self) -> None:
        self.assertIs(self.gate.evaluate(build("啊啊啊啊啊啊啊啊")).action, Action.BLOCK)

    # ── 危险的进人工，而不是自动回 ──────────────────────
    def test_handoff_keyword_goes_review(self) -> None:
        out = self.gate.evaluate(build("想问下商务合作报价怎么谈"))
        self.assertIs(out.action, Action.REVIEW)
        self.assertEqual(out.intent, "handoff")

    def test_image_only_stranger_goes_review(self) -> None:
        out = self.gate.evaluate(build("", kind="image"))
        self.assertIs(out.action, Action.REVIEW)

    def test_overlong_stranger_goes_review(self) -> None:
        out = self.gate.evaluate(build("在吗" + "我今天看到你的视频感觉很有意思想问问你是怎么拍的" * 9))
        self.assertIs(out.action, Action.REVIEW)

    # ── 老会话不受影响 ──────────────────────────────────
    def test_following_user_is_normal(self) -> None:
        out = self.gate.evaluate(build("今天的视频什么时候更", following=True, history=True))
        self.assertIs(out.action, Action.NORMAL)

    def test_probation_continues_as_normal(self) -> None:
        msg = build("你好")
        self.gate.open_probation(msg.conv_id, msg.sender_id, NOW)
        out = self.gate.evaluate(build("还在吗", conv="c_1", sid="u_1"))
        self.assertIs(out.action, Action.NORMAL)

    # ── 配额用尽也不丢弃 ────────────────────────────────
    def test_quota_exhausted_goes_review_not_block(self) -> None:
        for _ in range(self.gate.params.daily_reply_limit):
            self.gate.reserve(NOW)
        out = self.gate.evaluate(build("你好呀"))
        self.assertIs(out.action, Action.REVIEW)
        self.assertIn("额度", out.reason)

    def test_disabled_still_queues_for_human(self) -> None:
        gate = StrangerGate(StrangerParams(enable=False))
        out = gate.evaluate(build("你好呀"))
        self.assertIs(out.action, Action.REVIEW)

    # ── 核心不变量 ──────────────────────────────────────
    def test_never_silently_dropped(self) -> None:
        samples = [
            "你好", "在吗", "哈哈哈", "？？？", "你怎么不理我", "123",
            "嗯", "…", "买吗", "多少钱", "好可爱", "已关注求回关",
            "在吗" * 40, "", "😀😀😀",
        ]
        for text in samples:
            with self.subTest(text=text[:12]):
                out = self.gate.evaluate(build(text))
                self.assertIsInstance(out.action, Action)
                self.assertTrue(out.reason, "每条判定都必须有原因，否则审计日志里就是个黑洞")

    def test_intent_detection(self) -> None:
        self.assertEqual(detect_intent("你好呀"), "greeting")
        self.assertEqual(detect_intent("这个怎么弄？"), "question")
        self.assertEqual(detect_intent("太可爱了"), "praise")
        self.assertEqual(detect_intent("嗯"), "other")


if __name__ == "__main__":
    unittest.main()

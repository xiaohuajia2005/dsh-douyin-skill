"""命令行入口：离线演示、环境自检、跑测试。

    python -m skill.cli demo       # 13 条模拟私信走完整条处理链
    python -m skill.cli doctor     # 环境与配置自检
    python -m skill.cli selftest   # 跑单元测试

只依赖标准库，不需要装任何东西。
"""
from __future__ import annotations

import argparse
import random
import subprocess
import sys
import unicodedata
from dataclasses import replace
from datetime import datetime
from pathlib import Path

from .config import CONFIG_PATH, ROOT, load_settings
from .pipeline import DMRelay
from .proactive_guard import ProactiveGuard
from .stranger_gate import IncomingMessage

ACTION_LABEL = {
    "replied": "已回复",
    "blocked": "拦截",
    "review": "转人工",
    "deferred": "待发",
    "queued": "排队",
    "recalled": "撤回失效",
    "duplicate": "重复跳过",
}

# 模拟场景。字段含义：
#   orig=True 表示"原版插件在这种情况下会静默丢弃"（不计入任何队列、不留日志）
SCENARIOS = [
    dict(seq=1, label="陌生人打招呼", conv="c_1024", sid="u_8801", msg_id="m_1024_01",
         text="你好呀，刷到你的视频了", t=(10, 0, 0), orig=True),
    dict(seq=2, label="陌生人提问", conv="c_1024", sid="u_8801", msg_id="m_1024_02",
         text="你平时都吃什么呀？", t=(10, 1, 0), orig=True),
    dict(seq=3, label="插件重投", conv="c_1024", sid="u_8801", msg_id="m_1024_01",
         text="你好呀，刷到你的视频了", t=(10, 1, 30), orig=True),
    dict(seq=4, label="陌生人夸一句", conv="c_1024", sid="u_8801", msg_id="m_1024_04",
         text="好可爱啊", t=(10, 2, 0), orig=True),
    dict(seq=5, label="垃圾引流", conv="c_1102", sid="u_9002", msg_id="m_1102_01",
         text="加我微信 abc123 有内部渠道", t=(10, 3, 0), orig=False),
    dict(seq=6, label="商务合作", conv="c_1203", sid="u_9103", msg_id="m_1203_01",
         text="想问下商务合作报价怎么谈", t=(10, 4, 0), orig=False),
    dict(seq=7, label="老会话催更", conv="c_0820", sid="u_7001", msg_id="m_0820_01",
         text="今天的视频什么时候更", t=(10, 5, 0), following=True, history=True, orig=False),
    dict(seq=8, label="深夜来信", conv="c_1330", sid="u_9204", msg_id="m_1330_01",
         text="在吗 想问个事", t=(3, 12, 0), orig=True),
    dict(seq=9, label="对方撤回", conv="c_1330", sid="u_9204", msg_id="m_1330_01",
         kind="system_recall", text="", t=(3, 13, 0), orig=True),
    dict(seq=10, label="页面抖动", conv="c_1401", sid="u_9305", msg_id="m_1401_01",
         text="在吗", t=(10, 20, 0), orig=True,
         send_ok=False, err="Element not found: send-button"),
    dict(seq=11, label="退避期间", conv="c_1402", sid="u_9406", msg_id="m_1402_01",
         text="你好", t=(10, 20, 10), orig=True),
    dict(seq=12, label="平台限流", conv="c_1403", sid="u_9507", msg_id="m_1403_01",
         text="在吗在吗", t=(10, 55, 0), orig=True,
         send_ok=False, err="操作频繁，请稍后再试"),
    dict(seq=13, label="停机之后", conv="c_1404", sid="u_9608", msg_id="m_1404_01",
         text="哈喽", t=(10, 56, 0), orig=True),
]


def _dw(text: str) -> int:
    """终端显示宽度：CJK 算 2 格。不用它对齐中文会全歪。"""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in str(text))


def _pad(text: str, width: int) -> str:
    text = str(text)
    return text + " " * max(0, width - _dw(text))


def _cut(text: str, width: int) -> str:
    text = str(text)
    if _dw(text) <= width:
        return text
    out, used = "", 0
    for ch in text:
        w = 2 if unicodedata.east_asian_width(ch) in "WF" else 1
        if used + w > width - 1:
            break
        out += ch
        used += w
    return out + "…"


def _ts(hm: tuple[int, int, int]) -> float:
    now = datetime.now()
    return now.replace(hour=hm[0], minute=hm[1], second=hm[2], microsecond=0).timestamp()


def run_demo() -> int:
    settings = load_settings()
    # 固定随机种子，让退避抖动在演示里可复现（真实的退避本来就是随机抖动）
    relay = DMRelay(settings, rng=random.Random(20261114))

    print()
    print("DSH 抖音 Skill · 离线演示（13 条模拟私信，无网络、无账号）")
    print(f"配置：{CONFIG_PATH.name} · 陌生人日限 {settings.stranger.daily_reply_limit} 条"
          f" · 退避 {int(settings.session.backoff_base_seconds)}s"
          f" · 恢复预算 {settings.session.max_resumes_per_window} 次/{int(settings.session.window_minutes)}min")
    print("─" * 104)
    header = (_pad("序", 4) + " " + _pad("会话", 9) + " " + _pad("场景", 16) + " "
              + _pad("动作", 10) + " " + _pad("判定 / 去向", 36) + " 结果")
    print(header)
    print("─" * 104)

    for sc in SCENARIOS:
        msg = IncomingMessage(
            msg_id=sc["msg_id"],
            conv_id=sc["conv"],
            sender_id=sc["sid"],
            text=sc.get("text", ""),
            ts=_ts(sc["t"]),
            is_following=sc.get("following", False),
            has_history=sc.get("history", False),
            kind=sc.get("kind", "text"),
        )
        out = relay.process(
            msg,
            send_ok=sc.get("send_ok", True),
            send_error=sc.get("err"),
            original_would_drop=sc["orig"],
        )
        tail = f"→ {out.reply}" if out.reply and out.action in ("replied", "deferred", "queued") else out.note
        print(_pad(sc["seq"], 4) + " " + _pad(sc["conv"], 9) + " " + _pad(sc["label"], 16) + " "
              + _pad(ACTION_LABEL.get(out.action, out.action), 10) + " "
              + _pad(_cut(out.reason, 36), 36) + " " + _cut(tail, 26))

    print("─" * 104)
    print(f"会话状态：{relay.session_line()}")
    print()

    s = relay.stats
    print("去向汇总")
    for name, value in s.as_rows():
        if value:
            print(f"  {_pad(name, 14)} {value}")
    print()

    # 进人工队列不算丢弃：这里的"静默"专指既没有回复、也没有进入任何队列
    silent = s.total - (s.replied + s.blocked + s.review + s.deferred + s.queued
                        + s.recalled + s.duplicate)
    probation = sum(1 for o in relay.outcomes if "观察期" in o.reason)
    print("对照原版行为")
    print(f"  静默丢弃          原版 {s.original_dropped} 条 → 本版 {silent} 条")
    print(f"  陌生人得到回复    原版 0 条 → 本版 {probation} 条（观察期受控）")
    print(f"  撤回后失效        原版不处理 → 本版 {s.recalled} 条")
    print(f"  异常期间排队      原版全部丢 → 本版 {s.queued + s.deferred} 条")
    print()
    print("全部动作均在本地完成，未访问任何抖音接口。")
    print()
    return 0 if silent == 0 else 1


PROACTIVE_SCENARIOS = [
    dict(label="深夜想开口", conv="c_0803", permitted=True, speaker="them", t=(3, 30, 0), after=None),
    dict(label="对方最后一条没回", conv="c_0801", permitted=True, speaker="them", t=(9, 0, 0), after="commit"),
    dict(label="一小时后想再开口", conv="c_0801", permitted=True, speaker="me", t=(10, 0, 0), after=None),
    dict(label="冷却过了，仍没回", conv="c_0801", permitted=True, speaker="them", t=(15, 30, 0), after="commit"),
    dict(label="第三次想开口", conv="c_0801", permitted=True, speaker="them", t=(16, 0, 0), after=None),
    dict(label="想对陌生人主动", conv="c_9001", permitted=False, speaker="them", t=(16, 5, 0), after=None),
    dict(label="对方最后一条是我说的", conv="c_0802", permitted=True, speaker="me", t=(17, 0, 0), after="commit"),
    dict(label="当天第四次", conv="c_0804", permitted=True, speaker="them", t=(17, 30, 0), after=None),
]


def run_proactive() -> int:
    settings = load_settings()
    params = replace(settings.proactive, enabled=True)
    guard = ProactiveGuard(params)

    print()
    print("主动开口护栏 · 演示（配置里 enabled=false，本演示临时开启）")
    print(f"参数：日上限 {params.daily_limit} 次 · 同会话冷却 {params.per_conversation_cooldown_minutes} 分钟"
          f" · 连续 {params.max_unanswered} 次未回应即停 · 仅限许可会话")
    print("─" * 105)
    print(_pad("序", 4) + " " + _pad("时间", 6) + " " + _pad("会话", 9) + " " + _pad("情形", 22)
          + " " + _pad("判定", 6) + " " + _pad("类型", 14) + " 说明")
    print("─" * 105)

    counts = {"allow": 0, "defer": 0, "block": 0}
    for i, sc in enumerate(PROACTIVE_SCENARIOS, 1):
        ts = _ts(sc["t"])
        plan = guard.plan(
            sc["conv"], now=ts, permitted=sc["permitted"], last_speaker=sc["speaker"]
        )
        counts[plan.verdict.value] += 1
        hh, mm, _ = sc["t"]
        print(_pad(i, 4) + " " + _pad(f"{hh:02d}:{mm:02d}", 6) + " " + _pad(sc["conv"], 9) + " "
              + _pad(sc["label"], 22) + " "
              + _pad({"allow": "允许", "defer": "延后", "block": "禁止"}[plan.verdict.value], 6) + " "
              + _pad(plan.kind.value, 14) + " " + _cut(plan.reason, 38))

        if sc["after"] == "commit" and plan.allowed:
            guard.commit(sc["conv"], ts)
        elif sc["after"] == "respond":
            guard.record_response(sc["conv"])

    print("─" * 105)
    print(f"今日已开口 {guard.used_today(_ts((18, 0, 0)))} 次 · "
          f"允许 {counts['allow']} / 延后 {counts['defer']} / 禁止 {counts['block']}")
    print()
    print("说明：『延后』会进待发队列，『禁止』写审计日志。没有任何一种情况是静默丢弃。")
    print()
    return 0


def run_doctor() -> int:
    print()
    print("环境自检")
    print("─" * 60)
    ok = "✓"
    bad = "✗"

    print(f" {ok} Python {sys.version.split()[0]}")
    try:
        import tomllib  # noqa: F401
        print(f" {ok} tomllib（配置解析，内置）")
    except ImportError:
        print(f" {bad} tomllib 缺失，需要 Python 3.11+")
        return 1

    if CONFIG_PATH.exists():
        print(f" {ok} 配置 {CONFIG_PATH}")
    else:
        print(f" {bad} 配置缺失：{CONFIG_PATH}")

    settings = load_settings()
    for k, v in settings.as_dict().items():
        print(f"   · {_pad(k, 18)} {v}")

    banned = ROOT / "config" / "banned_words.txt"
    print(f" {ok if banned.exists() else bad} 违禁词表 {banned.name}")
    temps = ROOT / "workflow" / "templates.txt"
    print(f" {ok if temps.exists() else bad} 话术模板 {temps.name}")
    print("─" * 60)
    print(" 说明：本仓库只做决策层，不驱动浏览器，因此不检查 ffmpeg / node。")
    print()
    return 0


def run_selftest() -> int:
    tests_dir = ROOT / "tests"
    cmd = [sys.executable, "-m", "unittest", "discover", "-s", str(tests_dir), "-t", str(ROOT), "-v"]
    return subprocess.call(cmd)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="skill", description="DSH 抖音自动化 Skill")
    p.add_argument("command", nargs="?", default="demo",
                   choices=["demo", "proactive", "doctor", "selftest"], help="默认 demo")
    args = p.parse_args(argv)

    if args.command == "demo":
        return run_demo()
    if args.command == "proactive":
        return run_proactive()
    if args.command == "doctor":
        return run_doctor()
    return run_selftest()


if __name__ == "__main__":
    raise SystemExit(main())

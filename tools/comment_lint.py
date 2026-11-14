#!/usr/bin/env python
"""评论离线体检器 —— 零依赖，开自动评论之前先跑这个。

它检查的正是平台判定"垃圾评论"的那几条，也是插件管不到的那几条：
字数、句数、emoji 数量、违禁词、@、链接、联系方式。

    python tools/comment_lint.py --selftest
    python tools/comment_lint.py "唔 这条我看了三遍"
    python tools/comment_lint.py --file workflow/templates.txt

退出码：0 全部通过 ／ 1 有被拦的句子（可直接用在 CI 或批处理里）
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_CHARS = 12          # 与 persona_xiaoyu.md 的字数硬顶保持一致
MAX_EMOJI = 1
MAX_SENTENCES = 1

# 出现这些就是硬拦，不用看长度
HARD_PATTERNS = [
    (re.compile(r"https?://|www\.", re.I), "含链接"),
    (re.compile(r"\b\d{7,}\b"), "含疑似号码"),
    (re.compile(r"[a-zA-Z]{2,}\d{3,}"), "含疑似账号"),
    (re.compile(r"@\S+"), "含 @"),
]


def is_emoji(ch: str) -> bool:
    cp = ord(ch)
    return (
        0x1F300 <= cp <= 0x1FAFF
        or 0x2600 <= cp <= 0x27BF
        or cp in (0x2764, 0x2B50, 0x2B55)
    )


def load_banned() -> list[str]:
    path = ROOT / "config" / "banned_words.txt"
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        w = line.strip()
        if w and not w.startswith("#"):
            out.append(w)
    return out


def lint(text: str, banned: list[str]) -> list[str]:
    """返回问题列表，空列表 = 通过。"""
    problems: list[str] = []
    raw = text.strip()

    if not raw:
        return ["空内容"]

    # 1) 结构类
    for pat, reason in HARD_PATTERNS:
        if pat.search(raw):
            problems.append(reason)

    # 2) 长度（空格与 emoji 不计入正文字数）
    body = "".join(ch for ch in raw if not ch.isspace() and not is_emoji(ch))
    if len(body) > MAX_CHARS:
        problems.append(f"{len(body)} 字，超过 {MAX_CHARS} 字上限")

    # 3) emoji
    n_emoji = sum(1 for ch in raw if is_emoji(ch))
    if n_emoji > MAX_EMOJI:
        problems.append(f"{n_emoji} 个 emoji，最多 {MAX_EMOJI} 个")

    # 4) 句数（句末标点连用算一个）
    n_sent = len(re.findall(r"[。！？!?~…]+", raw))
    if n_sent > MAX_SENTENCES:
        problems.append(f"{n_sent} 句，最多 {MAX_SENTENCES} 句")

    # 5) 违禁词
    low = raw.lower()
    hits = [w for w in banned if w.lower() in low]
    if hits:
        problems.append("违禁词：" + "、".join(sorted(set(hits))))

    # 6) 感叹号堆叠
    if re.search(r"[!！]{2,}", raw):
        problems.append("感叹号堆叠")

    return problems


def report(items: list[tuple[str, str]]) -> int:
    """items: [(来源, 文本)]"""
    banned = load_banned()
    blocked = 0
    width = max((len(s) for s, _ in items), default=4)

    print(f"\n评论体检  ·  上限 {MAX_CHARS} 字 / {MAX_SENTENCES} 句 / {MAX_EMOJI} 个 emoji")
    print("─" * 58)
    for src, text in items:
        problems = lint(text, banned)
        if problems:
            blocked += 1
            print(f" ✗ {src:<{width}}  {text}")
            for p in problems:
                print(f"     └ {p}")
        else:
            print(f" ✓ {src:<{width}}  {text}")
    print("─" * 58)
    print(f" 通过 {len(items) - blocked} ／ 拦截 {blocked}\n")
    return 0 if blocked == 0 else 1


def selftest() -> int:
    good_file = ROOT / "workflow" / "templates.txt"
    good: list[tuple[str, str]] = []
    if good_file.exists():
        for i, line in enumerate(good_file.read_text(encoding="utf-8").splitlines(), 1):
            if line.strip():
                good.append((f"C{i:02d}", line.strip()))

    bad = [
        ("坏1", "这条视频真的太好笑了哈哈哈哈哈我笑到吐泡泡😂😂😂"),
        ("坏2", "加我微信 abc123"),
        ("坏3", "建议你每天早起，坚持一定有效果！"),
        ("坏4", "看这里 https://example.com"),
    ]

    print("\n【模板库应当全部通过】")
    rc1 = report(good)
    print("【反例应当全部被拦】")
    rc2 = report(bad)

    if rc1 != 0:
        print("✗ 自检失败：模板库里有句子过不了，先改模板再开自动评论。")
        return 1
    if rc2 == 0:
        print("✗ 自检失败：反例没被拦住，检查 config/banned_words.txt 和正则。")
        return 1
    print("✓ 自检通过：模板干净，拦截有效。可以往下走了。")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="抖音评论离线体检（零依赖）")
    p.add_argument("text", nargs="?", help="要检查的一句话")
    p.add_argument("--file", help="批量检查，一行一条")
    p.add_argument("--selftest", action="store_true", help="跑内置样例自检")
    args = p.parse_args(argv)

    if args.selftest:
        return selftest()
    if args.file:
        path = Path(args.file)
        if not path.is_absolute():
            path = ROOT / path
        if not path.exists():
            print(f"找不到 {path}")
            return 1
        items = [
            (f"L{i}", ln.strip())
            for i, ln in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
            if ln.strip()
        ]
        return report(items)
    if args.text:
        return report([("输入", args.text)])

    p.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_cases.py —— 证据对账核心的特征测试入口

用法：
    python test_cases.py            # 跑全部用例，输出摘要
    python test_cases.py -v         # 显示每条用例的完整 TAP 输出
    python test_cases.py --diff BASELINE  # （预留）与基线输出对比

设计说明：
    对账逻辑本体是 ESM JavaScript（chat-message.mjs / message-tracker.mjs），
    所以断言必须由 Node 执行（tests/evidence.test.mjs，零第三方依赖，node --test）。
    本脚本负责：调起 Node → 解析 TAP → 中文摘要 → 退出码。
    重构守则：改完代码跑一次，全绿才能 git commit。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEST_FILES = sorted((ROOT / "tests").glob("*.test.mjs"))
MIN_NODE_MAJOR = 18  # node --test 自 v18 起内置


def find_node() -> str:
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        print("[✗] 未找到 node，请确认 Node.js 已安装并在 PATH 中")
        sys.exit(2)
    return node


def check_node_version(node: str) -> None:
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=15)
        major = int(out.stdout.strip().lstrip("v").split(".")[0])
        if major < MIN_NODE_MAJOR:
            print(f"[✗] Node 版本过低：需要 ≥ v{MIN_NODE_MAJOR}，当前 {out.stdout.strip()}")
            sys.exit(2)
    except (ValueError, subprocess.TimeoutExpired):
        print("[!] 无法确认 Node 版本，继续尝试执行")


def run_tests(node: str, verbose: bool) -> tuple[int, int, list[str]]:
    """返回 (pass, fail, 失败用例名列表)"""
    total_pass, total_fail = 0, 0
    failures: list[str] = []
    for test_file in TEST_FILES:
        rel = test_file.relative_to(ROOT)
        proc = subprocess.run(
            [node, "--test", str(test_file)],
            capture_output=True, text=True, timeout=300, cwd=ROOT,
        )
        output = proc.stdout + proc.stderr
        if verbose:
            print(output)
        for line in output.splitlines():
            stripped = line.strip()
            if stripped.startswith("ok ") and "Subtest" not in stripped:
                total_pass += 1
            elif stripped.startswith("not ok "):
                total_fail += 1
                name = stripped.split(" - ", 1)[-1] if " - " in stripped else stripped
                failures.append(f"[{rel}] {name}")
        # node --test 的退出码：任何失败都非 0；只以 TAP 计数为准
    return total_pass, total_fail, failures


def main() -> int:
    parser = argparse.ArgumentParser(description="证据对账特征测试（对账 / 防误判 / 重复消息校验）")
    parser.add_argument("-v", "--verbose", action="store_true", help="输出完整 TAP 日志")
    args = parser.parse_args()

    print("═" * 64)
    print("证据对账核心 · 特征测试")
    print("═" * 64)

    if not TEST_FILES:
        print("[✗] tests/ 下没有 *.test.mjs 用例文件")
        return 2

    node = find_node()
    check_node_version(node)
    print(f"[✓] 运行环境  node={node}")
    print(f"[✓] 用例文件  {len(TEST_FILES)} 个：{', '.join(t.name for t in TEST_FILES)}")
    print("─" * 64)

    passed, failed, failures = run_tests(node, args.verbose)

    for f in failures:
        print(f"  ✗ {f}")
    if not failures:
        print("  （无失败用例）")
    print("─" * 64)
    print(f"  通过 {passed} ／ 失败 {failed} ／ 共 {passed + failed}")

    if failed:
        print("\n  ⚠ 有断言失败 —— 重构改变了行为边界，先排查再提交。")
        print("    单文件回滚：git restore <file>")
        print("    最近一次提交：git log --oneline -1")
        return 1
    print("\n  ✓ 全部通过 —— 可以放心提交：git add -A && git commit")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    sys.exit(main())

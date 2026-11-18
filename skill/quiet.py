"""静默时段判断。抽出来单独放，避免 pipeline 与 proactive_guard 各写一份。
"""
from __future__ import annotations

import time


def in_quiet_hours(ts: float, span: tuple[str, str] | list[str]) -> bool:
    """判断 ts 是否落在 [start, end) 内，支持跨零点（如 22:00–08:00）。"""
    try:
        start, end = span
        sh, sm = (int(x) for x in str(start).split(":"))
        eh, em = (int(x) for x in str(end).split(":"))
    except (ValueError, TypeError):
        return False

    cur = time.localtime(ts)
    now_min = cur.tm_hour * 60 + cur.tm_min
    start_min, end_min = sh * 60 + sm, eh * 60 + em
    if start_min <= end_min:
        return start_min <= now_min < end_min
    return now_min >= start_min or now_min < end_min

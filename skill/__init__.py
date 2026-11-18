"""DSH 抖音自动化 Skill —— 决策层与三道护栏。

这个包不负责"怎么点网页"。它负责的是：一条私信进来之后，
要不要回、谁能回、回不了的时候消息去哪。

原版插件在这些地方会直接丢弃：陌生人首条、会话暂停期间、撤回之后、
发送结果不明、静默时段。本项目把这些一律改成"排队 + 留痕"，
把"静默丢弃"压到 0。
"""

__version__ = "0.2.0"
__all__ = [
    "Settings",
    "load_settings",
    "DMRelay",
    "StrangerGate",
    "SessionGuard",
    "RecallGuard",
    "ProactiveGuard",
]


def __getattr__(name: str):
    """延迟导入，避免 import skill 就拉起整个链路。"""
    if name in ("Settings", "load_settings"):
        from .config import Settings, load_settings

        return {"Settings": Settings, "load_settings": load_settings}[name]
    if name == "DMRelay":
        from .pipeline import DMRelay

        return DMRelay
    if name == "StrangerGate":
        from .stranger_gate import StrangerGate

        return StrangerGate
    if name == "SessionGuard":
        from .session_guard import SessionGuard

        return SessionGuard
    if name == "RecallGuard":
        from .recall_guard import RecallGuard

        return RecallGuard
    if name == "ProactiveGuard":
        from .proactive_guard import ProactiveGuard

        return ProactiveGuard
    raise AttributeError(name)

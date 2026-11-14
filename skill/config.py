"""配置加载：只用标准库（Python 3.11+ 的 tomllib），零第三方依赖。

设计取舍：
- 配置文件缺失时退回到代码内默认值，而不是抛异常。这样单元测试和 CI 不依赖文件系统。
- 参数用 frozen dataclass 承载，加载后不可变，避免运行期被下游模块悄悄改掉。
"""
from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "skill.toml"

DEFAULT_HANDOFF = (
    "合作", "报价", "价格", "广告", "投放", "代理", "商务", "推广",
    "投诉", "退款", "维权", "律师", "举报", "媒体", "采访", "招聘",
)
DEFAULT_AD = (
    "兼职", "日入", "月入", "刷单", "返利", "招代理", "收徒", "免单",
    "优惠券", "带货", "加群", "引流", "稳赚", "包赚", "内部渠道", "带你",
)
DEFAULT_NEVER_SAY = (
    "微信", "wx", "vx", "v信", "威信", "加我", "qq", "扣扣",
    "链接", "二维码", "电话", "淘宝", "公众号", "私聊",
)


def _pick(data: dict, path: str, default):
    """按 'a.b.c' 取值，任一层缺失就返回默认值。"""
    cur = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur if cur is not None else default


def _tuple_str(value, default: tuple[str, ...]) -> tuple[str, ...]:
    if isinstance(value, (list, tuple)):
        return tuple(str(v) for v in value)
    return default


@dataclass(frozen=True)
class StrangerParams:
    """陌生人准入参数（修复 #1）。"""

    enable: bool = True
    daily_reply_limit: int = 8
    max_chars: int = 20
    probation_ttl_minutes: int = 180
    handoff_keywords: tuple[str, ...] = DEFAULT_HANDOFF
    ad_words: tuple[str, ...] = DEFAULT_AD


@dataclass(frozen=True)
class SessionParams:
    """会话状态机参数（修复 #2）。"""

    max_consecutive_failures: int = 3
    backoff_base_seconds: float = 30.0
    backoff_cap_seconds: float = 600.0
    jitter_ratio: float = 0.25
    max_resumes_per_window: int = 3
    window_minutes: float = 30.0
    halt_on_platform_pause: bool = True


@dataclass(frozen=True)
class RecallParams:
    """撤回与幂等参数（修复 #3）。"""

    pending_ttl_seconds: float = 600.0
    dedupe_seconds: float = 86400.0
    resend_on_unknown: bool = False


@dataclass(frozen=True)
class DMReplyParams:
    max_chars: int = 25
    quiet_hours: tuple[str, str] = ("00:00", "08:00")
    handoff_keywords: tuple[str, ...] = DEFAULT_HANDOFF
    never_say: tuple[str, ...] = DEFAULT_NEVER_SAY


@dataclass(frozen=True)
class InteractionParams:
    like_enabled: bool = True
    like_daily_limit: int = 20
    favorite_enabled: bool = True
    favorite_daily_limit: int = 5
    require_watch_complete: bool = True


@dataclass(frozen=True)
class CommentParams:
    enabled: bool = False
    daily_limit: int = 2
    per_round_limit: int = 1
    max_chars: int = 12
    max_emoji: int = 1
    silent_token: str = "SKIP"


@dataclass(frozen=True)
class Settings:
    stranger: StrangerParams = field(default_factory=StrangerParams)
    session: SessionParams = field(default_factory=SessionParams)
    recall: RecallParams = field(default_factory=RecallParams)
    dm: DMReplyParams = field(default_factory=DMReplyParams)
    interaction: InteractionParams = field(default_factory=InteractionParams)
    comment: CommentParams = field(default_factory=CommentParams)
    model: str = "deepseek-v4-flash"
    source: str = "defaults"

    def as_dict(self) -> dict:
        """给 doctor 命令打表格用。"""
        return {
            "陌生人日回复上限": self.stranger.daily_reply_limit,
            "陌生人回复字数": self.stranger.max_chars,
            "老会话回复字数": self.dm.max_chars,
            "连续失败阈值": self.session.max_consecutive_failures,
            "恢复预算(次/窗口)": self.session.max_resumes_per_window,
            "退避上限(秒)": int(self.session.backoff_cap_seconds),
            "撤回待发TTL(秒)": int(self.recall.pending_ttl_seconds),
            "评论日上限": self.comment.daily_limit,
            "点赞日上限": self.interaction.like_daily_limit,
            "模型": self.model,
        }


def load_settings(path: Path | str | None = None) -> Settings:
    """读取 skill.toml；文件不存在或字段缺失时逐项回落默认值。"""
    target = Path(path) if path else CONFIG_PATH
    if not target.exists():
        return Settings()

    with target.open("rb") as fh:
        raw = tomllib.load(fh)

    stranger = StrangerParams(
        enable=bool(_pick(raw, "dm.stranger.enable", True)),
        daily_reply_limit=int(_pick(raw, "dm.stranger.daily_reply_limit", 8)),
        max_chars=int(_pick(raw, "dm.stranger.max_chars", 20)),
        probation_ttl_minutes=int(_pick(raw, "dm.stranger.probation_ttl_minutes", 180)),
        handoff_keywords=_tuple_str(_pick(raw, "dm.handoff_keywords", None), DEFAULT_HANDOFF),
        ad_words=DEFAULT_AD,
    )

    session = SessionParams(
        max_consecutive_failures=int(_pick(raw, "session.max_consecutive_failures", 3)),
        backoff_base_seconds=float(_pick(raw, "session.backoff_base_seconds", 30.0)),
        backoff_cap_seconds=float(_pick(raw, "session.backoff_cap_seconds", 600.0)),
        jitter_ratio=float(_pick(raw, "session.jitter_ratio", 0.25)),
        max_resumes_per_window=int(_pick(raw, "session.max_resumes_per_window", 3)),
        window_minutes=float(_pick(raw, "session.window_minutes", 30.0)),
        halt_on_platform_pause=bool(_pick(raw, "session.halt_on_platform_pause", True)),
    )

    recall = RecallParams(
        pending_ttl_seconds=float(_pick(raw, "recall.pending_ttl_seconds", 600.0)),
        dedupe_seconds=float(_pick(raw, "recall.dedupe_seconds", 86400.0)),
        resend_on_unknown=bool(_pick(raw, "recall.resend_on_unknown", False)),
    )

    dm = DMReplyParams(
        max_chars=int(_pick(raw, "dm.reply_max_chars", 25)),
        quiet_hours=tuple(_pick(raw, "dm.quiet_hours", ["00:00", "08:00"])),
        handoff_keywords=stranger.handoff_keywords,
        never_say=_tuple_str(_pick(raw, "dm.never_say", None), DEFAULT_NEVER_SAY),
    )

    interaction = InteractionParams(
        like_enabled=bool(_pick(raw, "interaction.like_enabled", True)),
        like_daily_limit=int(_pick(raw, "interaction.like_daily_limit", 20)),
        favorite_enabled=bool(_pick(raw, "interaction.favorite_enabled", True)),
        favorite_daily_limit=int(_pick(raw, "interaction.favorite_daily_limit", 5)),
        require_watch_complete=bool(_pick(raw, "interaction.require_watch_complete", True)),
    )

    comment = CommentParams(
        enabled=bool(_pick(raw, "comment.enabled", False)),
        daily_limit=int(_pick(raw, "comment.daily_limit", 2)),
        per_round_limit=int(_pick(raw, "comment.per_round_limit", 1)),
        max_chars=int(_pick(raw, "comment.max_chars", 12)),
        max_emoji=int(_pick(raw, "comment.max_emoji", 1)),
        silent_token=str(_pick(raw, "comment.silent_token", "SKIP")),
    )

    return Settings(
        stranger=stranger,
        session=session,
        recall=recall,
        dm=dm,
        interaction=interaction,
        comment=comment,
        model=str(_pick(raw, "model.model", "deepseek-v4-flash")),
        source=str(target),
    )

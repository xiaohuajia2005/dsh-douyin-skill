// 补答「抢发」防护：只读判断私信输入框里是不是有人正在写。
//
// 为什么需要：补答是在「对方已读但一直没回」的尾消息上补一次回复。这类会话很可能
// 正是本人正在手动处理的会话——输入框里已有半句话时，自动化插进去发一条，
// 既打断人，也会把本人的草稿清掉（sendMessage 的 clearStaleDraft）。
//
// 纯函数、零 I/O：判定与日志都交给调用方（chat-service），这里只回答「算不算人工在写」。
// 三个证据，按可信度排序：
//   1. 输入框里有附件（图片/文件弹窗）—— 一定是在准备发送，最强；
//   2. 输入框里有非空文字（零宽字符不算）—— 手动输入过；
//   3. 输入框有焦点 **且** 页面本身有系统焦点 —— 人正停在输入框里。
// 第 3 条刻意加了 pageFocused 前置：上一次自动化发送用 fill() 聚焦过输入框，
// 焦点常常留在里面；如果只看 focused，窗口最小化后补答会被永久跳过（同一个 bug 反过来）。

export const MANUAL_COMPOSER_REASONS = Object.freeze({
  ATTACHMENT: 'attachment',
  DRAFT: 'draft',
  FOCUS: 'focus',
});

// 与 chat-browser 的 readableDraft 用同一份零宽字符集：只由零宽字符组成的草稿不算人工输入。
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

const readable = value => String(value ?? '').replace(ZERO_WIDTH, '').trim();

export function composerGuard(state) {
  if (!state || typeof state !== 'object') return { manual: false, reason: null, detail: { readable: false } };
  const editorCount = Number(state.editorCount) || 0;
  const attachments = (Number(state.attachments) || 0) + (Number(state.fileModal) || 0);
  const draftLength = [...readable(state.draft)].length;
  const focused = state.focused === true;
  const pageFocused = state.pageFocused === true;
  // 只记录长度和布尔值，不把草稿正文带进日志。
  const detail = { editorCount, draftLength, attachments, focused, pageFocused, readable: editorCount === 1 };
  // 输入框不是唯一一个（面板没展开、结构变了）时不做判断：交给发送前那道既有守卫去拒绝。
  if (editorCount !== 1) return { manual: false, reason: null, detail };
  if (attachments > 0) return { manual: true, reason: MANUAL_COMPOSER_REASONS.ATTACHMENT, detail };
  if (draftLength > 0) return { manual: true, reason: MANUAL_COMPOSER_REASONS.DRAFT, detail };
  if (focused && pageFocused) return { manual: true, reason: MANUAL_COMPOSER_REASONS.FOCUS, detail };
  return { manual: false, reason: null, detail };
}

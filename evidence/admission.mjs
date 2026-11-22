// ============================================================
// 证据层 · 准入判定（迭代 8 从 chat-message.mjs 原样抽出）
//
// 这里只回答一个问题：这条消息"能不能触发回复"。
// 撤回、系统通知、非支持类型一律 false —— 宁可漏回，不可错回。
// 元数据消息（文件/位置/名片/直播/音乐/通话/礼物/链接）只有在
// understandingScope 明确标注"仅可见元数据"时才允许回复，避免对未知内容瞎猜。
// ============================================================

const metadataTypes = new Set(['file', 'location', 'user-card', 'live', 'music', 'call', 'gift', 'video-attachment', 'link', 'unknown']);
export const isMetadataMessage = message => metadataTypes.has(message?.media?.type) && message.media.understandingScope === 'visible-message-metadata-only';
export function isReplyableMessage(message) {
  if (!message || message.nonReplyableNotice === true || ['recalled', 'withdrawn', 'system', 'system-notice'].some(kind => kind === message.kind || kind === message.type) || message.unsupported === true) return false;
  return Boolean(isMetadataMessage(message) || message.media && ['emoji', 'shared-work', 'image', 'voice'].includes(message.media.type)
    || (!message.kind || ['text', 'quote'].includes(message.kind)) && (message.text?.trim() || message.reference?.text?.trim()));
}

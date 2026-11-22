// ============================================================
// 人格&记忆层 · 消息投影（迭代 8 从 chat-message.mjs 原样抽出）
//
// 只投影"可以给模型看"的字段：资源地址、DOM 选择器、任意附加字段一律不进入模型，
// 每个字符串都有长度上限（6000/1200/1000/500…），防止一条超长消息挤爆上下文。
// 它属于 agent 层而不是 evidence 层：这是"给模型看什么"的产品决定，
// 不是"这条消息是不是同一条"的客观判断。
// ============================================================

// 只投影已采集的消息资料，资源地址、DOM 选择器和任意附加字段不进入模型。
export function chatMessageSummary(message) {
  const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;
  const media = message.media;
  return { messageId: message.id, text: bounded(message.text, 6000),
    ...(message.reference ? { reference: { text: bounded(message.reference.text, 1200), scope: 'visible-quoted-message', contentStatus: 'preview-only' } } : {}),
    ...(media ? { media: { type: bounded(media.type, 40), label: bounded(media.label, 200), title: bounded(media.title, 1000), author: bounded(media.author, 120),
      domain: bounded(media.domain, 253), durationSeconds: Number.isFinite(media.durationSeconds) ? media.durationSeconds : undefined,
      animatedHint: media.animatedHint === true, isPhotoGallery: media.isPhotoGallery === true,
      understandingScope: bounded(media.understandingScope, 100), contentStatus: bounded(media.contentStatus, 40), summary: bounded(media.summary, 500) } } : {}) };
}

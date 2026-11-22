// ============================================================
// 证据层 · 分享作品引用推断（迭代 16 从 chat-service.mjs 原样抽出）
//
// 对方说"刚才那个视频怎么样"时，这条消息本身没有任何指向，只能靠上下文推断。
// 规则刻意保守：
//   · 待发消息里已经有分享卡片 → 不再额外找（用户这次就是在说那张卡）；
//   · 只在最近 8 条内往回找，且遇到出站消息立刻停止（不跨越自己说过的话）；
//   · 群聊必须同一位成员发的，除非对方用了明确的指代词（刚才/这个/上面…）；
//   · 历史 context 里已有同 ID 但指纹不同 → 视为内容被改，跳过。
// 找不到就返回空数组 —— 宁可不评论，也不去评论一个对方没提的作品。
// ============================================================
import { messageFingerprint } from './fingerprint.mjs';

export function referencedSharedWork(contact, incoming, context, messages) {
  if (incoming.some(message => message.media?.type === 'shared-work')) return [];
  const explicitReference = message => typeof message.text === 'string' && /上面|前面|刚才|这个|这条|那条|那个|别人发的|发给你|分享给你/u.test(message.text) && /视频|作品|看|评/u.test(message.text);
  const triggers = incoming.filter(message => explicitReference(message) || typeof message.text === 'string' && !/喜欢什么|看过什么|看什么|什么类型/u.test(message.text) && /(?:看|评).{0,12}(?:视频|作品)|(?:视频|作品).{0,12}(?:怎么|如何|评价)/u.test(message.text));
  if (!triggers.length) return [];
  const known = new Map(context.map(message => [message.id, messageFingerprint(message)]));
  for (const trigger of triggers.slice().reverse()) {
    const index = messages.findIndex(message => message.id === trigger.id);
    for (let prior = index - 1; prior >= Math.max(0, index - 8); prior--) {
      const message = messages[prior];
      if (message.sender === 'outgoing') break;
      if (message.sender !== 'incoming' || message.media?.type !== 'shared-work' || message.unsupported === true || known.has(message.id) && known.get(message.id) !== messageFingerprint(message)) continue;
      if (contact.isGroup === true && (typeof trigger.memberId !== 'string' || !/^member:[a-f0-9]{64}$/.test(trigger.memberId) || typeof message.memberId !== 'string' || !/^member:[a-f0-9]{64}$/.test(message.memberId) || message.memberId !== trigger.memberId && !explicitReference(trigger))) continue;
      return [message];
    }
  }
  return [];
}

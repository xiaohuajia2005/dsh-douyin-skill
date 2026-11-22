// ============================================================
// 证据层 · 许可与快照校验（迭代 19 从 chat-service.mjs 原样抽出）
//
// 四个闸门，全部 fail-closed，抛错即"这次不发送"：
//   validatePolicy              —— 许可记录本身合法吗（版本、开关、名单不重复、每条都还有效）；
//   messagesOf                  —— 这份快照能不能用来回复（要登录/验证/被拦 → 保留队列；
//                                  消息缺稳定 ID 或方向不明 → 整份作废）；
//   assertConversationSnapshot  —— 读回来的会话是不是许可那一个（身份 + 会话 ID + 群/单聊类型）；
//   verifiedAuthorizedContact   —— 发送前再核一次许可：人工授权的只比对身份，
//                                  关注/会话型许可必须有稳定身份才能原地升级，否则要求本人重新核对。
// 错误文案是产品行为的一部分（用户看到的提示），搬动时不改一字。
// ============================================================
import {
  isStoredContactAuthorized, matchesAuthorizedContact, hasStableConversationIdentity, upgradeAuthorizedContact,
} from './authorization.mjs';
import { normalizeMentionNames } from './mentions.mjs';

export function validatePolicy(policy) {
  if(!policy||policy.version!==1||typeof policy.enabled!=='boolean')throw new Error('私信许可记录损坏，已阻止自动回复。');
  if (!Array.isArray(policy.allowlist) || new Set(policy.allowlist.map((item) => item?.id)).size !== policy.allowlist.length) throw new Error('许可名单须为不同的个人或群聊会话，不能重复选择。');
  for (const item of policy.allowlist) if (!isStoredContactAuthorized(item)) throw new Error('许可名单必须有已核对的关注关系，或本人明确授权的个人、群聊会话身份。');
  return { ...policy, dailyReplyLimit: null, groupMentionNames: normalizeMentionNames(policy.groupMentionNames) };
}
export function messagesOf(snapshot) {
  if (snapshot?.loginRequired || snapshot?.verificationRequired || snapshot?.blocked) throw Object.assign(new Error('抖音账号暂需登录或验证，回复队列继续保留。'), { code: 'CHAT_ACCOUNT_ACTION_REQUIRED', needsUserAction: true });
  if (!Array.isArray(snapshot?.messages)) throw new Error('没有读到可靠的私信消息列表。');
  const messages = snapshot.messages.map((message) => ({ ...structuredClone(message), sender: message.sender || message.direction }));
  if (messages.some((message) => typeof message.id !== 'string' || !message.id || !['incoming', 'outgoing', 'unknown'].includes(message.sender))) throw new Error('私信消息缺少稳定 ID 或方向，未回复。');
  return messages;
}
export function assertConversationSnapshot(contact, snapshot) {
  if (!matchesAuthorizedContact(contact, snapshot?.contact) || snapshot?.conversation?.id !== contact.id) throw new Error('会话身份或许可绑定回读不一致，已暂停。');
  if (typeof snapshot.conversation.isGroup === 'boolean' && snapshot.conversation.isGroup !== contact.isGroup) throw new Error('会话类型回读不一致，已暂停。');
}
export function verifiedAuthorizedContact(stored, current) {
  if (stored.authorizationKind === 'manual') {
    if (!matchesAuthorizedContact(stored, current)) throw new Error('人工授权会话的显示名或类型已变化，已暂停。');
    return { ...stored, name: current.name || current.displayName || stored.name };
  }
  if (!hasStableConversationIdentity(current)) throw new Error('未读到许可会话可靠的稳定身份，未继续自动回复；请本人重新核对授权。');
  const upgraded = upgradeAuthorizedContact(stored, current);
  if (!upgraded) throw new Error('许可会话的稳定身份尚未核对，旧关注名单不能自动迁移；请本人重新核对授权。');
  return upgraded;
}

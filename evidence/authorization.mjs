// ============================================================
// 证据层 · 会话授权判定（迭代 10 从包根 contact-authorization.mjs 原样搬入）
//
// 这一层只回答两个问题，全部基于"字段证据"，不看页面长什么样：
//   hasVerifiedConversationIdentity —— 会话 ID 是 conv: 哈希、身份已核对、绑定是 binding: 哈希；
//   hasStableConversationIdentity   —— 再要求 v2 三元组自洽：identityHash === conv ID 去掉前缀，
//                                      且 group/user 两类 kind 不能互相冒充。
// 授权链：canAuthorizeConversation（能不能给许可）→ isStoredContactAuthorized（落盘许可还有效吗）
//        → matchesAuthorizedContact（当前读到的会话是不是许可那一个）→ upgradeAuthorizedContact（旧许可升级）。
//
// 核心纪律：**永远不用同名或头像去找替代账号**。身份不可判定时一律返回 false / null，
// 宁可这次不发，也不发给"看起来像"的另一个人。
// ============================================================
import { sameConversationIdentity, normalizeDisplayName } from './contact-key.mjs';

const bindingPattern = /^binding:[a-f0-9]{64}$/;
const conversationPattern = /^conv:[a-f0-9]{64}$/;
const nameOf = value => value?.name || value?.displayName;
export const MAX_AUTHORIZED_CONTACTS = null;
const conversation = value => value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 500 && typeof value.isGroup === 'boolean' && typeof nameOf(value) === 'string' && Boolean(nameOf(value).trim());

export function hasVerifiedConversationIdentity(value) {
  return Boolean(conversation(value) && conversationPattern.test(value.id) && value.identityVerified === true && bindingPattern.test(value.identityBinding || ''));
}

export function hasStableConversationIdentity(value) {
  return Boolean(hasVerifiedConversationIdentity(value) && value.identityVersion === 2
    && ['native-conversation', 'rendered-conversation', 'rendered-conversation-short', 'rendered-group', 'rendered-user', 'rendered-user-id', 'profile-user'].includes(value.identityKind)
    && (value.isGroup ? !['rendered-user', 'rendered-user-id', 'profile-user'].includes(value.identityKind) : value.identityKind !== 'rendered-group')
    && /^[a-f0-9]{64}$/.test(value.identityHash || '') && value.identityHash === value.id.slice(5));
}

// 网页没有提供关注关系时，只有本人核对后才能授权现有会话；群聊始终单独核对。
export function canAuthorizeConversation(value) {
  return Boolean(hasVerifiedConversationIdentity(value) && (value.identityVersion === undefined || hasStableConversationIdentity(value)) && (value.isGroup === true || value.relationshipStatus === 'unavailable' && value.followed !== true));
}

export function isStoredContactAuthorized(value) {
  if (!conversation(value) || typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt))) return false;
  if (['identityVersion', 'identityKind', 'identityHash'].some(key => value[key] !== undefined) && !hasStableConversationIdentity(value)) return false;
  if (value.authorizationKind === 'manual') return true;
  if (value.authorizationKind === 'existing-group') return value.isGroup === true && canAuthorizeConversation(value);
  if (value.authorizationKind === 'existing-conversation') return value.isGroup === false && canAuthorizeConversation(value);
  return value.isGroup === false && value.followed === true && (value.authorizationKind === undefined || value.authorizationKind === 'following');
}

export function matchesAuthorizedContact(stored, current) {
  if (!isStoredContactAuthorized(stored) || !conversation(current) || current.id !== stored.id || current.isGroup !== stored.isGroup) return false;
  if (stored.authorizationKind === 'manual') return true;
  if (hasStableConversationIdentity(stored)) return hasStableConversationIdentity(current) && current.identityKind === stored.identityKind && current.identityHash === stored.identityHash && current.identityBinding === stored.identityBinding && (['existing-conversation', 'existing-group'].includes(stored.authorizationKind) || current.followed === true);
  if (stored.identityVersion !== undefined) return false;
  if (['existing-conversation', 'existing-group'].includes(stored.authorizationKind)) {
    if (hasStableConversationIdentity(current)) return true;
    return nameOf(current) === nameOf(stored) && hasVerifiedConversationIdentity(current) && current.identityBinding === stored.identityBinding;
  }
  if (hasStableConversationIdentity(current)) return false;
  if (nameOf(current) !== nameOf(stored)) return false;
  if (current.followed !== true) return false;
  return !stored.identityBinding || hasVerifiedConversationIdentity(current) && current.identityBinding === stored.identityBinding;
}

// 旧许可只能升级原来的稳定会话 ID 和类型，不能用同名或头像寻找替代账号。
export function upgradeAuthorizedContact(stored, current) {
  if (!isStoredContactAuthorized(stored) || !hasStableConversationIdentity(current) || stored.id !== current.id || stored.isGroup !== current.isGroup) return null;
  if (hasStableConversationIdentity(stored)) {
    if (!matchesAuthorizedContact(stored, current)) return null;
  } else if (stored.identityVersion !== undefined || !['existing-conversation', 'existing-group'].includes(stored.authorizationKind) || !hasVerifiedConversationIdentity(stored)) return null;
  return { ...stored, name: nameOf(current), identityVersion: 2, identityKind: current.identityKind, identityHash: current.identityHash, identityVerified: true, identityBinding: current.identityBinding };
}

// 读取页面时的宽容比较（迭代 10 从 chat-browser.mjs 原样搬入）：
// 许可对象有稳定身份就严格比；没有稳定身份（老许可）才退化成"同类型 + 同名"的弱比较，
// 且弱比较只用于"读的就是这个会话"，绝不用来新增授权。
export const sameWeakConversation = (current, contact) => hasStableConversationIdentity(contact) ? sameConversationIdentity(current, contact) : Boolean(current && contact && current.identityConflict !== true && !contact.identityConflict
  && current.isGroup === contact.isGroup && current.conversationType === contact.conversationType
  && typeof current.displayName === 'string' && current.displayName
  && (() => {
    const actual = normalizeDisplayName(current.displayName), expected = normalizeDisplayName(contact.displayName || contact.name);
    return Boolean(expected) && (actual === expected || current.isGroup === true && actual.startsWith(expected) && /^\s*\(\d{1,6}\)$/.test(actual.slice(expected.length)));
  })());


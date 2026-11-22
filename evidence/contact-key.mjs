// ============================================================
// 证据层 · 会话身份派生（迭代 9 从 chat-browser.mjs 原样抽出）
//
// 这一层回答的是"我现在到底在跟谁说话"，比消息内容更早、也更致命：
//   contactIdentityKey   —— 会话的身份锚点，优先级 nativeId > 渲染 key > 主页链接；
//   contactOpaqueId      —— 落盘用的 conv:<sha256>，把页面内部 ID 挡在磁盘之外；
//   contactIdentityBinding / stableIdentityFields —— 授权绑定与 v2 身份三元组；
//   expectedDomIdentity  —— 读页面时要求页面自报哪三个身份字段；
//   sameConversationIdentity —— 读到的会话与许可会话是不是同一个。
//
// 关键不变量：binding 与 identityHash 必须由同一个 key 派生，且
// identityHash === contactOpaqueId.slice(5) —— contact-authorization 的
// hasStableConversationIdentity() 就是靠这一条判定"身份是否仍然稳定"。
// ============================================================
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

export const contactIdentityKey = row => row.nativeId ? `native:${row.nativeId}` : row.identityKey ? `rendered:${row.identityKey}` : row.conversationType === 'direct' && row.profileUrl ? `user:${row.profileUrl}` : null;
export const sameConversationIdentity = (current, contact) => Boolean(current && contact && current.identityUnavailable !== true && !current.identityConflict && !contact.identityConflict
  && current.isGroup === contact.isGroup && current.conversationType === contact.conversationType
  && (!current.identityKey || !contact.identityKey || current.identityKey === contact.identityKey)
  && contactIdentityKey(current) && contactIdentityKey(current) === contactIdentityKey(contact));
export const normalizeDisplayName = value => String(value || '').normalize('NFKC').replace(/[，、,]\s*/g, '，').replace(/\s+/g, ' ').trim();
export const contactOpaqueId = row => `conv:${hash(contactIdentityKey(row) ?? `${row.displayName}\0${row.avatar}`)}`;
export const contactIdentityBinding = row => !row.identityConflict && contactIdentityKey(row) && ['direct', 'group'].includes(row.conversationType)
  ? `binding:${hash(`${row.conversationType}\0${contactIdentityKey(row)}`)}` : null;
export const stableIdentityFields = row => contactIdentityBinding(row) ? { identityVersion: 2, identityKind: row.nativeId ? 'native-conversation' : row.identityKey ? `rendered-${row.identityKey.split(':')[0]}` : 'profile-user', identityHash: hash(contactIdentityKey(row)) } : {};
export const expectedDomIdentity = contact => ({ expectedKey: contactIdentityKey(contact), expectedType: contact.conversationType, expectedRenderedKey: contact.identityKey || null });

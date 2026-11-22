// ============================================================
// 会话授权判定特征测试 —— 迭代 10
//
// 这一层失效的后果不是"报错"，而是"把私信发给另一个人"。
// 所以每条用例都在锁一个 fail-closed 行为：证据不全就拒绝，宁可这次不发。
// 期望哈希一律在测试内用 node:crypto 独立重算，不复用被测模块的私有 hash。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MAX_AUTHORIZED_CONTACTS,
  hasVerifiedConversationIdentity,
  hasStableConversationIdentity,
  canAuthorizeConversation,
  isStoredContactAuthorized,
  matchesAuthorizedContact,
  upgradeAuthorizedContact,
  sameWeakConversation,
} from '../contact-authorization.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const convId = seed => `conv:${sha(seed)}`;
const bindingOf = seed => `binding:${sha(`direct\0${seed}`)}`;
const verifiedAt = '2026-01-01T00:00:00.000Z';

// 一份"完全合规"的 v2 会话：conv ID 与 identityHash 同源，binding 由同一个 key 派生。
const stableContact = (seed = 'native:n1', extra = {}) => ({
  id: convId(seed), name: '小鱼', displayName: '小鱼', isGroup: false, identityKey: seed,
  conversationType: 'direct', identityVerified: true, identityBinding: bindingOf(seed),
  identityVersion: 2, identityKind: 'native-conversation', identityHash: sha(seed),
  ...extra,
});
// 去掉 v2 三元组 = 迭代前的旧许可形态（已人工核对过，但没有稳定身份）。
const withoutV2 = contact => {
  const { identityVersion, identityKind, identityHash, ...rest } = contact;
  return rest;
};
const stored = (extra = {}) => ({ ...stableContact(), verifiedAt, ...extra });

test('T1 已核对身份要三样证据齐全：conv ID + identityVerified + binding', () => {
  assert.equal(hasVerifiedConversationIdentity(stableContact()), true);
  assert.equal(hasVerifiedConversationIdentity(stableContact('native:n1', { identityVerified: false })), false);
  assert.equal(hasVerifiedConversationIdentity(stableContact('native:n1', { identityBinding: null })), false);
  assert.equal(hasVerifiedConversationIdentity(stableContact('native:n1', { id: 'rendered:x' })), false, '非 conv: 形态的 ID 不算已核对');
  assert.equal(hasVerifiedConversationIdentity(stableContact('native:n1', { name: '', displayName: '' })), false, '没有名字的会话不可判定');
  assert.equal(hasVerifiedConversationIdentity(stableContact('native:n1', { isGroup: 'false' })), false, 'isGroup 必须是布尔');
  assert.equal(hasVerifiedConversationIdentity(null), false);
});

test('T2 稳定身份要求 identityHash 与 conv ID 同源，group/user 的 kind 不能互相冒充', () => {
  assert.equal(hasStableConversationIdentity(stableContact()), true);
  assert.equal(hasStableConversationIdentity(stableContact('native:n1', { identityHash: sha('native:other') })), false, 'hash 与 ID 不同源 = 身份对不上');
  assert.equal(hasStableConversationIdentity(stableContact('native:n1', { identityVersion: 1 })), false, 'v1 没有三元组，不算稳定');
  assert.equal(hasStableConversationIdentity(stableContact('native:n1', { identityKind: 'rendered-uid' })), false, '白名单外的 kind 一律拒绝');
  assert.equal(hasStableConversationIdentity(stableContact('group:g1', { isGroup: true, identityKind: 'rendered-group' })), true);
  assert.equal(hasStableConversationIdentity(stableContact('group:g1', { isGroup: true, identityKind: 'rendered-user' })), false, '群聊不能挂用户级 kind');
  assert.equal(hasStableConversationIdentity(stableContact('native:n1', { identityKind: 'rendered-group' })), false, '单聊不能挂群级 kind');
});

test('T3 新授权：群聊凭已核对身份即可，单聊必须"网页未提供关注关系"且当前未关注', () => {
  assert.equal(canAuthorizeConversation(stableContact('group:g1', { isGroup: true })), true);
  assert.equal(canAuthorizeConversation(stableContact()), false, '单聊缺 relationshipStatus 不能授权');
  assert.equal(canAuthorizeConversation(stableContact('native:n1', { relationshipStatus: 'unavailable' })), true);
  assert.equal(canAuthorizeConversation(stableContact('native:n1', { relationshipStatus: 'unavailable', followed: true })), false, '已关注应走 following 路径，不是"新建授权"');
  assert.equal(canAuthorizeConversation(stableContact('native:n1', { relationshipStatus: 'following' })), false);
  assert.equal(canAuthorizeConversation(withoutV2(stableContact('native:n1', { relationshipStatus: 'unavailable' }))), true, '无三元组的旧核实会话仍可授权（升级路径）');
});

test('T4 落盘许可的四条路径：manual / existing-group / existing-conversation / following', () => {
  assert.equal(isStoredContactAuthorized(stored({ authorizationKind: 'manual' })), true, '人工核对优先，不受关注关系影响');
  assert.equal(isStoredContactAuthorized(stored({ isGroup: true, authorizationKind: 'existing-group' })), true);
  assert.equal(isStoredContactAuthorized(stored({ authorizationKind: 'existing-group' })), false, 'existing-group 必须是群聊');
  assert.equal(isStoredContactAuthorized(stored({ authorizationKind: 'existing-conversation', relationshipStatus: 'unavailable' })), true);
  assert.equal(isStoredContactAuthorized(stored({ isGroup: true, authorizationKind: 'existing-conversation' })), false, 'existing-conversation 必须是单聊');
  assert.equal(isStoredContactAuthorized(stored({ authorizationKind: 'following', followed: true })), true);
  assert.equal(isStoredContactAuthorized(stored({ authorizationKind: 'following', followed: false })), false);
  assert.equal(isStoredContactAuthorized(stored({ authorizationKind: 'following' })), false, '没标记 followed 就不算关注关系');
});

test('T5 许可失效要 fail-closed：缺 verifiedAt / 三元组残缺 / 未知类型', () => {
  assert.equal(isStoredContactAuthorized(stored({ verifiedAt: undefined, authorizationKind: 'manual' })), false);
  assert.equal(isStoredContactAuthorized(stored({ verifiedAt: 'not-a-date', authorizationKind: 'manual' })), false);
  assert.equal(isStoredContactAuthorized(stored({ identityVersion: 2, identityKind: undefined, identityHash: undefined, authorizationKind: 'manual' })), false, '三元组残缺 = 旧数据升级失败，必须重新核对');
  assert.equal(isStoredContactAuthorized(stored({ authorizationKind: 'whatever', followed: true })), false, '未知许可类型不进任何分支');
  assert.equal(isStoredContactAuthorized(stored({ id: 'conv:short', authorizationKind: 'manual' })), false, 'ID 形态非法');
});

test('T6 同名不同人必须拒绝（核心不变量）', () => {
  const authorized = stored({ authorizationKind: 'existing-conversation', relationshipStatus: 'unavailable' });
  assert.equal(matchesAuthorizedContact(authorized, stableContact()), true);
  const impostor = stableContact('native:impostor');   // 同样叫"小鱼"，身份键不同
  assert.equal(matchesAuthorizedContact(authorized, impostor), false, '同名不等于同一个人');
  assert.equal(matchesAuthorizedContact(authorized, stableContact('native:n1', { isGroup: true })), false, '类型变了不算同一会话');
  assert.equal(matchesAuthorizedContact(authorized, stableContact('native:n1', { identityHash: sha('native:other') })), false);
  assert.equal(matchesAuthorizedContact(stored({ authorizationKind: 'manual' }), impostor), false, 'manual 也要求 ID 与类型一致');
});

test('T7 严格比较要求绑定一致：既有会话不需重新关注，following 类必须仍关注', () => {
  const existing = stored({ authorizationKind: 'existing-conversation', relationshipStatus: 'unavailable' });
  assert.equal(matchesAuthorizedContact(existing, stableContact('native:n1', { followed: false })), true);
  const following = stored({ authorizationKind: 'following', followed: true });
  assert.equal(matchesAuthorizedContact(following, stableContact('native:n1', { followed: true })), true);
  assert.equal(matchesAuthorizedContact(following, stableContact('native:n1', { followed: false })), false, '已取关就不能再发');
  assert.equal(matchesAuthorizedContact(existing, stableContact('native:n1', { identityBinding: bindingOf('native:other') })), false, '绑定不一致 = 身份来源变了');
});

test('T8 旧许可只能原地升级，不能借升级换人', () => {
  const current = stableContact();
  const legacy = withoutV2(stored({ authorizationKind: 'existing-conversation', relationshipStatus: 'unavailable', followed: false }));
  const upgraded = upgradeAuthorizedContact(legacy, current);
  assert.equal(upgraded.identityVersion, 2);
  assert.equal(upgraded.identityKind, 'native-conversation');
  assert.equal(upgraded.identityHash, sha('native:n1'));
  assert.equal(upgraded.identityVerified, true);
  assert.equal(upgraded.identityBinding, bindingOf('native:n1'));
  assert.equal(upgraded.id, legacy.id, 'ID 不变');
  assert.equal(upgraded.name, '小鱼');
  assert.equal(upgradeAuthorizedContact(legacy, stableContact('native:impostor')), null, 'ID 不同就不是升级');
  assert.equal(upgradeAuthorizedContact(legacy, withoutV2(stableContact())), null, '当前会话身份不稳，不上车');
  assert.equal(upgradeAuthorizedContact(stored({ identityHash: sha('x'), authorizationKind: 'existing-conversation', relationshipStatus: 'unavailable' }), current), null, '三元组残缺的许可不能自动修复');
});

test('T9 弱比较只在老许可上启用：有稳定身份就一律走严格比较', () => {
  const strict = stableContact();
  assert.equal(sameWeakConversation(stableContact(), strict), true);
  assert.equal(sameWeakConversation(stableContact('native:other'), strict), false, '有稳定身份时同名也不算');
  const weak = withoutV2(stableContact());
  assert.equal(sameWeakConversation(withoutV2(stableContact()), weak), true);
  assert.equal(sameWeakConversation(withoutV2(stableContact('native:other')), weak), true, '弱比较本来就只是"看起来是同一个"——这条记录它的风险边界，绝不能用于新增授权');
  assert.equal(sameWeakConversation(withoutV2(stableContact()), withoutV2(stableContact('native:n1', { identityConflict: true }))), false, '任一标识冲突即拒绝');
  assert.equal(sameWeakConversation(withoutV2(stableContact()), withoutV2(stableContact('native:n1', { conversationType: 'group' }))), false, '类型不同');
  assert.equal(sameWeakConversation(null, weak), false);
});

test('T10 群名带人数后缀可容忍，但只容忍 "(1–6 位数字)" 且仅限群聊', () => {
  const group = withoutV2(stableContact('group:g1', { isGroup: true, displayName: '摸鱼群' }));
  const row = name => withoutV2(stableContact('group:g1', { isGroup: true, displayName: name }));
  assert.equal(sameWeakConversation(row('摸鱼群(3)'), group), true);
  assert.equal(sameWeakConversation(row('摸鱼群（12）'), group), true, '全角括号经 NFKC 归一后同样成立');
  assert.equal(sameWeakConversation(row('摸鱼群(123456)'), group), true);
  assert.equal(sameWeakConversation(row('摸鱼群(1234567)'), group), false, '超过 6 位不像人数后缀');
  assert.equal(sameWeakConversation(row('摸鱼群abc'), group), false);
  assert.equal(sameWeakConversation(row('摸鱼群2'), group), false);
  const direct = withoutV2(stableContact('native:n1', { displayName: '小鱼' }));
  assert.equal(sameWeakConversation(withoutV2(stableContact('native:n1', { displayName: '小鱼(3)' })), direct), false, '单聊不吃后缀');
  assert.equal(sameWeakConversation(row('  摸鱼群(3)  '), group), true, '首尾空白先归一');
});

test('T11 当前语义是不限量：一旦改成配额，这条先红', () => {
  assert.equal(MAX_AUTHORIZED_CONTACTS, null);
});

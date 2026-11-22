// ============================================================
// 会话身份派生特征测试 —— 迭代 9
//
// 这一层决定"我在跟谁说话"，出错等于把私信发给陌生人。
// 期望哈希在测试内用 node:crypto 独立重算，不复用被测模块的私有 hash。
// K9 是跨模块契约测试：派生结果必须真的能通过 contact-authorization 的
// hasStableConversationIdentity()，否则"身份稳定"整个判定就落空。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  contactIdentityKey, contactOpaqueId, contactIdentityBinding, stableIdentityFields,
  expectedDomIdentity, sameConversationIdentity, normalizeDisplayName,
} from '../evidence/contact-key.mjs';
import { hasStableConversationIdentity } from '../contact-authorization.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const hex64 = /^[a-f0-9]{64}$/;
const direct = extra => ({ displayName: '小鱼', avatar: 'https://a/1.jpg', conversationType: 'direct', isGroup: false, nativeId: 'n1', ...extra });

test('K1 身份锚点优先级：nativeId > 渲染 key > 主页链接（仅私聊）', () => {
  assert.equal(contactIdentityKey(direct()), 'native:n1');
  assert.equal(contactIdentityKey({ identityKey: 'uid:42', profileUrl: 'https://u/42' }), 'rendered:uid:42');
  assert.equal(contactIdentityKey({ conversationType: 'direct', profileUrl: 'https://u/42' }), 'user:https://u/42');
  assert.equal(contactIdentityKey({ conversationType: 'group', profileUrl: 'https://u/42' }), null, '群聊不拿主页链接当身份');
  assert.equal(contactIdentityKey({ displayName: '只有名字' }), null, '展示名不是身份');
});

test('K2 conv 落盘 ID：稳定哈希、同锚点同 ID、无锚点时退回名字+头像', () => {
  const row = direct();
  const id = contactOpaqueId(row);
  assert.match(id, /^conv:[a-f0-9]{64}$/);
  assert.equal(id, `conv:${sha('native:n1')}`);
  assert.equal(contactOpaqueId({ ...row, displayName: '改了名' }), id, '改名不换 conv ID');

  const anonymous = { displayName: '匿名', avatar: 'https://a/x.jpg' };
  assert.equal(contactOpaqueId(anonymous), `conv:${sha('匿名\0https://a/x.jpg')}`);
  assert.notEqual(contactOpaqueId({ ...anonymous, avatar: 'https://a/y.jpg' }), contactOpaqueId(anonymous), '同头像不同人不能撞 ID');
});

test('K3 授权绑定：仅 direct/group 且无身份冲突时生成，且与类型绑定', () => {
  assert.equal(contactIdentityBinding(direct()), `binding:${sha('direct\0native:n1')}`);
  assert.equal(contactIdentityBinding(direct({ conversationType: 'group', isGroup: true })), `binding:${sha('group\0native:n1')}`);
  assert.match(contactIdentityBinding(direct()), /^binding:[a-f0-9]{64}$/);
  assert.equal(contactIdentityBinding(direct({ identityConflict: true })), null, '身份冲突不生成绑定');
  assert.equal(contactIdentityBinding(direct({ conversationType: 'unknown' })), null);
  assert.equal(contactIdentityBinding({ displayName: '无锚点', conversationType: 'direct' }), null);
});

test('K4 v2 身份三元组：identityKind 只映射真实前缀族，rendered 前缀取冒号前段', () => {
  assert.deepEqual(stableIdentityFields(direct()),
    { identityVersion: 2, identityKind: 'native-conversation', identityHash: sha('native:n1') });
  // 真实前缀只有这四个族（见 readContactDom：conversation / conversation-short / group / user）
  for (const [prefix, kind] of [['conversation', 'rendered-conversation'], ['conversation-short', 'rendered-conversation-short'], ['group', 'rendered-group'], ['user', 'rendered-user']]) {
    assert.deepEqual(stableIdentityFields({ identityKey: `${prefix}:abc`, conversationType: 'direct', isGroup: false }),
      { identityVersion: 2, identityKind: kind, identityHash: sha(`rendered:${prefix}:abc`) });
  }
  assert.deepEqual(stableIdentityFields({ conversationType: 'direct', profileUrl: 'https://u/42' }),
    { identityVersion: 2, identityKind: 'profile-user', identityHash: sha('user:https://u/42') });
  assert.deepEqual(stableIdentityFields({ displayName: '贴纸会话' }), {}, '无锚点不给三元组（否则等于伪造稳定身份）');
});

test('K10 未知前缀安全失败：产出授权层不认的 kind，而不是被误判为稳定身份', () => {
  const odd = stableIdentityFields({ identityKey: 'mystery:1', conversationType: 'direct', isGroup: false });
  assert.equal(odd.identityKind, 'rendered-mystery');
  assert.equal(hasStableConversationIdentity({ id: contactOpaqueId({ identityKey: 'mystery:1' }), isGroup: false, name: 'x', identityVerified: true, identityBinding: contactIdentityBinding({ identityKey: 'mystery:1', conversationType: 'direct' }), ...odd }), false);
});

test('K5 关键不变量：identityHash === conv ID 去掉 conv: 前缀，且 binding 随之同源', () => {
  for (const row of [direct(), { identityKey: 'gid:7', conversationType: 'group', isGroup: true }, { conversationType: 'direct', profileUrl: 'https://u/9' }]) {
    const id = contactOpaqueId(row), fields = stableIdentityFields(row);
    assert.equal(fields.identityHash, id.slice(5), 'conv ID 与 identityHash 必须同源，否则身份永远判定为不稳定');
    assert.equal(contactIdentityBinding(row), `binding:${sha(`${row.conversationType}\0${contactIdentityKey(row)}`)}`);
  }
});

test('K6 DOM 核对期望值：三字段齐全，缺渲染 key 时为 null', () => {
  assert.deepEqual(expectedDomIdentity(direct()), { expectedKey: 'native:n1', expectedType: 'direct', expectedRenderedKey: null });
  assert.deepEqual(expectedDomIdentity({ identityKey: 'uid:42', conversationType: 'direct' }),
    { expectedKey: 'rendered:uid:42', expectedType: 'direct', expectedRenderedKey: 'uid:42' });
});

test('K7 同一会话判定：类型/身份/渲染 key 任一不符或标记冲突即不同', () => {
  const contact = direct();
  assert.equal(sameConversationIdentity({ ...contact }, contact), true);
  assert.equal(sameConversationIdentity({ ...contact, identityConflict: true }, contact), false);
  assert.equal(sameConversationIdentity({ ...contact, identityUnavailable: true }, contact), false);
  assert.equal(sameConversationIdentity({ ...contact, identityKey: 'uid:99' }, { ...contact, identityKey: 'uid:98' }), false);
  assert.equal(sameConversationIdentity({ ...contact, isGroup: true }, contact), false);
  assert.equal(sameConversationIdentity({ ...contact, conversationType: 'group' }, contact), false);
  assert.equal(sameConversationIdentity({ displayName: '同名人' }, { displayName: '同名人', conversationType: 'direct' }), false, '双方都无锚点 → 不可判定，必须 false');
  assert.equal(sameConversationIdentity(null, contact), false);
  // 一方缺渲染 key 时不参与比对，但锚点仍须一致
  assert.equal(sameConversationIdentity({ ...contact, identityKey: 'uid:x' }, contact), true);
});

test('K8 展示名归一：全角转半角、逗号统一、空白折叠、空值安全', () => {
  assert.equal(normalizeDisplayName('  小  鱼 '), '小 鱼');
  assert.equal(normalizeDisplayName('ＡＢ，　Ｃ'), 'AB，C', '逗号后的空白被吃掉，与实现一致');
  assert.equal(normalizeDisplayName('甲, 乙、丙'), '甲，乙，丙');
  assert.equal(normalizeDisplayName(null), '');
  assert.equal(normalizeDisplayName(undefined), '');
});

test('K9 跨模块契约：派生出的对象必须通过 hasStableConversationIdentity', () => {
  for (const row of [direct(), { identityKey: 'group:abc', conversationType: 'group', isGroup: true, name: '群里' }]) {
    const stored = { id: contactOpaqueId(row), isGroup: row.isGroup, name: row.displayName || row.name, identityVerified: true, identityBinding: contactIdentityBinding(row), ...stableIdentityFields(row) };
    assert.equal(hasStableConversationIdentity(stored), true, `${row.conversationType} 派生结果未通过稳定身份校验`);
  }
  const broken = { id: contactOpaqueId(direct()), isGroup: false, name: '小鱼', identityVerified: true, identityBinding: contactIdentityBinding(direct()), ...stableIdentityFields(direct()) };
  assert.equal(hasStableConversationIdentity({ ...broken, identityHash: sha('别的东西') }), false, 'identityHash 与 conv ID 不同源必须被拒');
});

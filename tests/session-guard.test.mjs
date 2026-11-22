// 许可与快照校验（迭代 19）。
// 四个闸门全部 fail-closed：抛错就是"这次不发送"。
// 错误文案是用户能看到的提示，所以测试连文案一起锁。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  validatePolicy, messagesOf, assertConversationSnapshot, verifiedAuthorizedContact,
} from '../evidence/session-guard.mjs';

const h = value => createHash('sha256').update(value).digest('hex');
const seed = 'native:n1';
const convId = `conv:${h(seed)}`;
const binding = `binding:${h(`${seed}:b`)}`;
const manual = (extra = {}) => ({
  id: convId, name: '小鱼', displayName: '小鱼', isGroup: false,
  identityVerified: true, identityBinding: binding,
  identityVersion: 2, identityKind: 'native-conversation', identityHash: h(seed),
  verifiedAt: '2026-11-20T00:00:00.000Z', authorizationKind: 'manual', ...extra,
});
// 老许可：有 verifiedAt 与绑定，但还没有 v2 三元组（可原地升级）
const legacy = (extra = {}) => ({
  id: convId, name: '小鱼', isGroup: false, identityVerified: true, identityBinding: binding,
  verifiedAt: '2026-11-20T00:00:00.000Z', authorizationKind: 'existing-conversation',
  relationshipStatus: 'unavailable', followed: false, ...extra,
});
const current = (extra = {}) => ({
  id: convId, name: '小鱼', displayName: '小鱼', isGroup: false,
  identityVerified: true, identityBinding: binding,
  identityVersion: 2, identityKind: 'native-conversation', identityHash: h(seed), ...extra,
});
const policyOf = (extra = {}) => ({ version: 1, enabled: true, allowlist: [manual()], ...extra });

test('S1 validatePolicy 拒绝损坏的许可记录', () => {
  assert.throws(() => validatePolicy(null), /私信许可记录损坏，已阻止自动回复。/);
  assert.throws(() => validatePolicy({ version: 2, enabled: true, allowlist: [] }), /私信许可记录损坏/);
  assert.throws(() => validatePolicy({ version: 1, enabled: 'yes', allowlist: [] }), /私信许可记录损坏/);
});

test('S2 名单必须是数组且不能重复选同一个会话', () => {
  assert.throws(() => validatePolicy(policyOf({ allowlist: 'x' })), /许可名单须为不同的个人或群聊会话/);
  assert.throws(() => validatePolicy(policyOf({ allowlist: [manual(), manual()] })), /许可名单须为不同的个人或群聊会话/);
  assert.throws(() => validatePolicy(policyOf({ allowlist: [manual(), manual({ name: '另一个名字' })] })), /不能重复选择/,
    '同一个 id 换名字也算重复');
});

test('S3 名单里只要有一条失效就整体拒绝', () => {
  // 用不同 id，否则会先被"不能重复选择"拦下，测不到失效检查
  const broken = manual({ id: `conv:${h('other')}`, identityHash: h('other'), verifiedAt: undefined });
  assert.throws(() => validatePolicy(policyOf({ allowlist: [manual(), broken] })), /许可名单必须有已核对的关注关系/);
});

test('S4 validatePolicy 通过时强制清空每日限额，并归一昵称', () => {
  const result = validatePolicy(policyOf({ dailyReplyLimit: 50, groupMentionNames: ['@小鱼'] }));
  assert.equal(result.dailyReplyLimit, null, '磁盘上的限额一律不看，只认代码里的保守值');
  assert.deepEqual(result.groupMentionNames, ['小鱼']);
  assert.deepEqual(validatePolicy(policyOf()).groupMentionNames, ['大肥鱼'], '没配就用默认昵称');
  assert.equal(validatePolicy(policyOf()).enabled, true, '其余字段原样保留');
});

test('S5 messagesOf 在账号需要登录/验证/被拦时保留队列', () => {
  for (const flag of ['loginRequired', 'verificationRequired', 'blocked']) {
    assert.throws(() => messagesOf({ [flag]: true, messages: [] }), error => {
      assert.equal(error.code, 'CHAT_ACCOUNT_ACTION_REQUIRED');
      assert.equal(error.needsUserAction, true);
      assert.match(error.message, /回复队列继续保留/);
      return true;
    });
  }
});

test('S6 messagesOf 拿不到消息列表就整份作废', () => {
  assert.throws(() => messagesOf(null), /没有读到可靠的私信消息列表。/);
  assert.throws(() => messagesOf({}), /没有读到可靠的私信消息列表。/);
  assert.throws(() => messagesOf({ messages: {} }), /没有读到可靠的私信消息列表。/);
});

test('S7 messagesOf 拒绝缺稳定 ID 或方向不明的消息', () => {
  assert.throws(() => messagesOf({ messages: [{ sender: 'incoming' }] }), /缺少稳定 ID 或方向/);
  assert.throws(() => messagesOf({ messages: [{ id: '', sender: 'incoming' }] }), /缺少稳定 ID 或方向/);
  assert.throws(() => messagesOf({ messages: [{ id: 123, sender: 'incoming' }] }), /缺少稳定 ID 或方向/);
  assert.throws(() => messagesOf({ messages: [{ id: 'm1' }] }), /缺少稳定 ID 或方向/, '方向缺失时不能用默认值兜底');
  assert.throws(() => messagesOf({ messages: [{ id: 'm1', sender: 'self' }] }), /缺少稳定 ID 或方向/);
});

test('S8 messagesOf 用 direction 补齐 sender，并返回深拷贝', () => {
  const snapshot = { messages: [{ id: 'm1', direction: 'incoming', text: '原文' }] };
  const messages = messagesOf(snapshot);
  assert.equal(messages[0].sender, 'incoming');
  assert.equal(messages[0].direction, 'incoming', 'direction 原样保留');
  messages[0].text = '改过了';
  assert.equal(snapshot.messages[0].text, '原文', '返回的是副本，改动不回流到快照');
  assert.equal(messagesOf({ messages: [{ id: 'm2', sender: 'unknown', text: 'x' }] })[0].sender, 'unknown', 'unknown 是允许的方向');
});

test('S9 assertConversationSnapshot 三处不一致都会暂停', () => {
  const contact = manual();
  const good = { contact: current(), conversation: { id: convId, isGroup: false } };
  assert.equal(assertConversationSnapshot(contact, good), undefined);
  assert.throws(() => assertConversationSnapshot(contact, { ...good, contact: current({ id: `conv:${h('other')}` , identityHash: h('other') }) }), /会话身份或许可绑定回读不一致/);
  assert.throws(() => assertConversationSnapshot(contact, { ...good, conversation: { id: `conv:${h('other')}`, isGroup: false } }), /会话身份或许可绑定回读不一致/);
  assert.throws(() => assertConversationSnapshot(contact, { ...good, conversation: { id: convId, isGroup: true } }), /会话类型回读不一致/);
});

test('S10 assertConversationSnapshot 在类型未知时不擅自判断', () => {
  const snapshot = { contact: current(), conversation: { id: convId } };
  assert.equal(assertConversationSnapshot(manual(), snapshot), undefined, 'isGroup 不是布尔就不做类型比对');
});

test('S11 人工授权只比对身份，显示名可更新', () => {
  const stored = manual();
  const renamed = current({ name: '小鱼改名了', displayName: '小鱼改名了' });
  const result = verifiedAuthorizedContact(stored, renamed);
  assert.equal(result.name, '小鱼改名了', '人工授权允许改名，身份未变就继续');
  assert.equal(result.id, convId);
  assert.throws(() => verifiedAuthorizedContact(stored, current({ id: `conv:${h('other')}`, identityHash: h('other') })), /人工授权会话的显示名或类型已变化/);
});

test('S12 老许可必须有稳定身份才能原地升级', () => {
  assert.throws(() => verifiedAuthorizedContact(legacy(), { id: convId, name: '小鱼', isGroup: false }), /未读到许可会话可靠的稳定身份/);
  const upgraded = verifiedAuthorizedContact(legacy(), current());
  assert.equal(upgraded.identityVersion, 2);
  assert.equal(upgraded.identityKind, 'native-conversation');
  assert.equal(upgraded.identityHash, h(seed));
  assert.equal(upgraded.authorizationKind, 'existing-conversation', '升级不改授权来源');
});

test('S13 升级不能换人：id 或类型不符时要求本人重新核对', () => {
  const otherId = current({ id: `conv:${h('other')}`, identityHash: h('other') });
  assert.throws(() => verifiedAuthorizedContact(legacy(), otherId), /旧关注名单不能自动迁移/);
  const otherType = current({ isGroup: true, identityKind: 'rendered-group' });
  assert.throws(() => verifiedAuthorizedContact(legacy(), otherType), /旧关注名单不能自动迁移/);
});

test('S14 老许可连绑定都没有时也升不了级', () => {
  assert.throws(() => verifiedAuthorizedContact(legacy({ identityBinding: undefined, identityVerified: false }), current()),
    /许可会话的稳定身份尚未核对/);
});

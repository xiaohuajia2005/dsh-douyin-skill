// 重启后能否续发（迭代 15）。
// 这是"上次发送结果不明"之后唯一的闸门：宁可把消息留在待答清单让人看，
// 也不重发一条可能已经发出去的消息。每条断言都在锁"证据不足就拒绝"。
//
// 注意：recoveryEvidence 要求待发消息带 eligibleForReply === true（或从历史证据继承），
// 否则直接返回 null。下面每条恢复测试都先断言证据建立成功，
// 避免"因为证据是 null 所以断言 null 通过"的假绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { recoveryEvidence, recoverableIncoming } from '../evidence/recovery.mjs';
import { contentOf } from '../evidence/unanswered-ledger.mjs';
import { messageFingerprint } from '../evidence/fingerprint.mjs';

const h = value => createHash('sha256').update(value).digest('hex');
const seed = 'native:n1';
const contact = (extra = {}) => ({
  id: `conv:${h(seed)}`, name: '小鱼', displayName: '小鱼', isGroup: false,
  identityVerified: true, identityBinding: `binding:${h(`${seed}:b`)}`,
  identityVersion: 2, identityKind: 'native-conversation', identityHash: h(seed),
  verifiedAt: '2026-11-20T00:00:00.000Z', authorizationKind: 'manual',
  ...extra,
});
const msg = (id, text = '在吗', extra = {}) => ({ id, sender: 'incoming', kind: 'text', text, ...extra });
// 已取得回复资格的待发消息
const ready = (id, text = '在吗') => msg(id, text, { eligibleForReply: true });
const qualified = (...messages) => messages.map(message => ({
  message, fingerprint: messageFingerprint(message), qualified: true, originalEligibleForReply: true,
}));
const pendingOf = (evidence, extra = {}) => ({ restartAllowed: true, recoveryExpiresAt: Date.now() + 3_600_000, recoveryEvidence: evidence, ...extra });
// 每条恢复测试共用：证据必须真的建立成功，否则后面的断言没有意义
const seeded = (messages, incoming = messages, stopRequest = null) => {
  const evidence = recoveryEvidence(contact(), incoming, messages, null, stopRequest);
  assert.ok(evidence, '前置：恢复证据必须建立成功，否则本用例测的是空路径');
  return pendingOf(evidence);
};

test('R1 没有待发消息就不写恢复证据', () => {
  assert.equal(recoveryEvidence(contact(), [], [msg('m1')], null, null), null);
});

test('R2 正常路径：证据含指纹清单、完整窗口内容与停止请求 ID', () => {
  const messages = [ready('m1'), msg('m2', '在的', { sender: 'outgoing' })];
  const evidence = recoveryEvidence(contact(), [messages[0]], messages, null, { requestId: 'r-1' });
  assert.ok(evidence);
  assert.equal(evidence.version, 1);
  assert.equal(evidence.beforeDispatch, true);
  assert.equal(evidence.stopRequestId, 'r-1');
  assert.equal(evidence.qualifiedIncoming.length, 1);
  assert.equal(evidence.qualifiedIncoming[0].fingerprint, messageFingerprint(messages[0]));
  assert.equal(evidence.qualifiedIncoming[0].qualified, true);
  assert.deepEqual(evidence.expectedContent, contentOf(messages), '落盘的是整个窗口，不是待发的那几条');
  assert.equal(JSON.stringify(evidence.contact), JSON.stringify(contact()));
  assert.ok(Number.isFinite(Date.parse(evidence.qualifiedAt)));
});

test('R3 待发集合里混入出站消息直接拒绝（不能为已发出的消息建续发证据）', () => {
  const messages = [ready('m1'), msg('m2', '我发的', { sender: 'outgoing' })];
  assert.equal(recoveryEvidence(contact(), messages, messages, null, null), null);
});

test('R4 未取得回复资格且无历史合格记录 → 拒绝', () => {
  const messages = [msg('m1', '在吗', { eligibleForReply: false })];
  assert.equal(recoveryEvidence(contact(), messages, messages, null, null), null);
  assert.equal(recoveryEvidence(contact(), [msg('m1')], messages, null, null), null, '没有 eligibleForReply 字段同样不算取得资格');
});

test('R5 历史证据合格则继承资格，并保持 originalEligibleForReply 为 true', () => {
  const messages = [msg('m1', '在吗', { eligibleForReply: false })];
  const prior = { qualifiedIncoming: qualified(msg('m1')) };
  const evidence = recoveryEvidence(contact(), messages, messages, prior, null);
  assert.ok(evidence);
  assert.equal(evidence.qualifiedIncoming[0].qualified, true);
  assert.equal(evidence.qualifiedIncoming[0].originalEligibleForReply, true);
});

test('R6 历史证据里同 ID 但指纹不同 → 不继承（内容被改过就不是同一条）', () => {
  const messages = [msg('m1', '改过的内容', { eligibleForReply: false })];
  const prior = { qualifiedIncoming: qualified(msg('m1', '原来的内容')) };
  assert.equal(recoveryEvidence(contact(), messages, messages, prior, null), null);
});

test('R7 qualifiedAt 与 stopRequestId 都优先沿用历史值', () => {
  const messages = [ready('m1')];
  const prior = { qualifiedIncoming: qualified(ready('m1')), qualifiedAt: '2026-11-20T08:00:00.000Z', stopRequestId: 'old-stop' };
  const evidence = recoveryEvidence(contact(), messages, messages, prior, { requestId: 'new-stop' });
  assert.ok(evidence);
  assert.equal(evidence.qualifiedAt, '2026-11-20T08:00:00.000Z', '首次合格时间一旦确定就不该被刷新');
  assert.equal(evidence.stopRequestId, 'old-stop');
});

test('R8 证据齐备时返回当前窗口里的那些消息对象', () => {
  const messages = [msg('m1'), msg('m2', '在的', { sender: 'outgoing' }), ready('m3')];
  const restored = recoverableIncoming(seeded(messages, [messages[2]]), contact(), messages, null);
  assert.ok(restored, '证据齐备时必须放行');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'm3');
  assert.equal(restored[0], messages[2], '返回的是窗口里的对象，不是落盘快照');
});

test('R9 恢复许可本身不合格一律拒绝：未允许重启 / 已过期 / 过期时间非有限值', () => {
  const messages = [ready('m1')];
  const pending = seeded(messages);
  assert.equal(recoverableIncoming(pending, contact(), messages, null)?.length, 1, '前置：正常证据应当放行');
  assert.equal(recoverableIncoming({ ...pending, restartAllowed: false }, contact(), messages, null), null);
  assert.equal(recoverableIncoming({ ...pending, recoveryExpiresAt: 1 }, contact(), messages, null), null, '1970 年的时间戳必然过期');
  assert.equal(recoverableIncoming({ ...pending, recoveryExpiresAt: 'later' }, contact(), messages, null), null, '非有限值不得当成未过期');
  assert.equal(recoverableIncoming({ ...pending, recoveryEvidence: { ...pending.recoveryEvidence, beforeDispatch: false } }, contact(), messages, null), null);
  assert.equal(recoverableIncoming({ ...pending, recoveryEvidence: { ...pending.recoveryEvidence, version: 2 } }, contact(), messages, null), null);
});

test('R10 窗口内容必须与落盘时逐字节相同（多一条、少一条、改一个字都算不一致）', () => {
  const messages = [ready('m1')];
  const pending = seeded(messages);
  assert.equal(recoverableIncoming(pending, contact(), [ready('m1'), msg('m2')], null), null, '多出消息就不敢续发');
  assert.equal(recoverableIncoming(pending, contact(), [msg('m1', '改了字', { eligibleForReply: true })], null), null, '正文变化即指纹变化');
  assert.equal(recoverableIncoming(pending, contact(), [], null), null);
});

test('R11 窗口出现方向不明的消息就拒绝', () => {
  const messages = [ready('m1')];
  const pending = seeded(messages);
  assert.equal(recoverableIncoming(pending, contact(), [msg('m1', '在吗', { sender: 'unknown', eligibleForReply: true })], null), null);
});

test('R12 记录里的指纹必须与当前消息对得上', () => {
  const messages = [ready('m1')];
  const pending = seeded(messages);
  const tampered = { ...pending.recoveryEvidence, qualifiedIncoming: pending.recoveryEvidence.qualifiedIncoming.map(item => ({ ...item, fingerprint: 'f'.repeat(64) })) };
  assert.equal(recoverableIncoming({ ...pending, recoveryEvidence: tampered }, contact(), messages, null), null);
});

test('R13 最后一个恢复目标之后已出现出站消息 → 拒绝（可能已经发过了）', () => {
  const base = [ready('m1')];
  assert.equal(recoveryEvidence(contact(), [msg('m9', '我先发了', { sender: 'outgoing' })], base, null, null), null,
    '前置：recoveryEvidence 自己就先挡掉出站目标');
  const pending = seeded(base);
  const later = [...base, msg('m9', '我先发了', { sender: 'outgoing' })];
  assert.equal(recoverableIncoming(pending, contact(), later, null), null);
});

test('R14 停止请求不是同一次就不能续发，除非明确要求保留待答', () => {
  const messages = [ready('m1')];
  const pending = seeded(messages, messages, { requestId: 'r-1' });
  assert.equal(recoverableIncoming(pending, contact(), messages, { requestId: 'r-2' }), null);
  assert.equal(recoverableIncoming(pending, contact(), messages, { requestId: 'r-2', preservePending: true })?.length, 1,
    'preservePending 是明确的"我要求保留"，此时不比对 ID');
  assert.equal(recoverableIncoming(pending, contact(), messages, null)?.length, 1, '没有停止请求就不必比对');
});

test('R15 许可会话与当前会话必须是同一个（双向比对）', () => {
  const messages = [ready('m1')];
  const pending = seeded(messages);
  const other = contact({ id: `conv:${h('native:n2')}`, identityHash: h('native:n2') });
  assert.equal(recoverableIncoming(pending, other, messages, null), null, '换了人就不能拿旧证据续发');
});

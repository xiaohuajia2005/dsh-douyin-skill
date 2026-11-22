// 待答清单与对账（迭代 14）。
// 这层决定"人看到的那张待核对清单"，以及它在磁盘上的身份。
// recordId 一漂，历史待答就会在界面里"消失又重现"，所以每条断言都在锁"确定性"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  contentOf, unresolvedManual, autoPendingCount, unansweredReason,
  messageKind, unansweredRecordId, unansweredItems, unansweredSnapshot, unansweredPreview,
} from '../evidence/unanswered-ledger.mjs';
import { messageContent } from '../evidence/fingerprint.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const msg = (id, text = '在吗', extra = {}) => ({ id, sender: 'incoming', kind: 'text', text, ...extra });
const contact = (id, extra = {}) => ({ id, name: `会话-${id}`, isGroup: false, ...extra });

test('U1 contentOf 只投影 id 与指纹，正文一律不外泄', () => {
  const messages = [msg('m1', '这是不该出现在对账记录里的正文'), msg('m2', '第二句')];
  const out = contentOf(messages);
  assert.deepEqual(out.map(item => Object.keys(item)), [['id', 'fingerprint'], ['id', 'fingerprint']]);
  assert.equal(JSON.stringify(out).includes('不该出现'), false, '正文不得进入对账内容');
  assert.ok(out.every(item => /^[a-f0-9]{64}$/.test(item.fingerprint)));
});

test('U2 contentOf 与 fingerprint.messageContent 完全等价（重复定义的一致性护栏）', () => {
  const messages = [msg('m1'), { id: 'm2', sender: 'outgoing', kind: 'image', media: { type: 'image', imageMd5: 'abc' } }];
  assert.equal(JSON.stringify(contentOf(messages)), JSON.stringify(messageContent(messages)),
    '若未来合并这两个函数，本断言会先提醒');
});

test('U3 recordId archive 分支：由 archiveId 决定，其余字段变化不影响', () => {
  const base = { archiveId: 'a-1', phase: 'not-sent', skippedAt: '2026-11-21T10:00:00.000Z', at: '2026-11-21T09:59:00.000Z', incoming: [msg('m1')] };
  const expected = sha(JSON.stringify(['conv-1', ['archive', 'a-1']]));
  assert.equal(unansweredRecordId('conv-1', base), expected);
  assert.equal(unansweredRecordId('conv-1', { ...base, phase: 'delivery-uncertain', skippedAt: '2026-11-22T00:00:00.000Z' }), expected,
    'archiveId 存在时其余字段不参与，同一归档记录 ID 必须稳定');
});

test('U4 recordId legacy 分支：对结构敏感，但正文变化不改 ID', () => {
  const item = { phase: 'not-sent', skippedAt: '2026-11-21T10:00:00.000Z', at: '2026-11-21T09:59:00.000Z', incoming: [msg('m1', '原文')] };
  // 注意 type/media 落成 null 而不是 undefined —— 实现用 `|| null`，
  // 若哪天改成 undefined，键会被 JSON.stringify 丢掉，全部历史 ID 一起漂。
  const key = ['legacy', 'not-sent', '2026-11-21T10:00:00.000Z', '2026-11-21T09:59:00.000Z',
    [{ id: 'm1', kind: 'text', type: null, media: null }]];
  assert.equal(unansweredRecordId('conv-1', item), sha(JSON.stringify(['conv-1', key])));
  assert.equal(unansweredRecordId('conv-1', { ...item, incoming: [msg('m1', '正文被清理或改写过')] }), unansweredRecordId('conv-1', item),
    '正文不参与 ID：清理正文不应让待答记录换身份');
  assert.notEqual(unansweredRecordId('conv-1', { ...item, phase: 'unqualified' }), unansweredRecordId('conv-1', item));
  assert.notEqual(unansweredRecordId('conv-1', { ...item, incoming: [msg('m2')] }), unansweredRecordId('conv-1', item));
});

test('U5 recordId 必须绑定会话，同一份记录不能跨会话复用', () => {
  const item = { phase: 'not-sent', incoming: [msg('m1')] };
  assert.notEqual(unansweredRecordId('conv-1', item), unansweredRecordId('conv-2', item), '否则两个好友的待答会互相顶掉');
});

test('U6 unansweredItems 按 allowlist 顺序展开，跳过无记录的会话', () => {
  const policy = { allowlist: [contact('c1'), contact('c2'), contact('c3')] };
  const watermarks = { contacts: { c1: { unanswered: [{ phase: 'not-sent', incoming: [msg('m1')] }] }, c3: { unanswered: [{ archiveId: 'a-9', phase: 'unqualified', incoming: [] }] } } };
  const items = unansweredItems(watermarks, policy);
  assert.deepEqual(items.map(entry => entry.contact.id), ['c1', 'c3']);
  assert.equal(items[0].recordId, unansweredRecordId('c1', watermarks.contacts.c1.unanswered[0]), '展开时的 ID 必须与单独计算一致');
  assert.deepEqual(unansweredItems({ contacts: {} }, policy), [], '没有任何记录时返回空数组而不是抛错');
});

test('U7 unansweredSnapshot 只统计未关闭项，且与读取顺序无关', () => {
  const open1 = { recordId: 'aa', item: { phase: 'not-sent' } };
  const open2 = { recordId: 'bb', item: { phase: 'unqualified' } };
  const closed = { recordId: 'cc', item: { phase: 'not-sent', handledByUserAt: '2026-11-21T10:00:00.000Z' } };
  const early = unansweredSnapshot([open1, open2]);
  assert.equal(unansweredSnapshot([open2, open1]), early, '排序保证同一批记录得到同一快照');
  assert.equal(unansweredSnapshot([open1, open2, closed]), early, '新增一条已关闭记录不应改变快照');
  assert.notEqual(unansweredSnapshot([open1]), early, '少一条未关闭记录必须改变快照');
  assert.equal(unansweredSnapshot([]), sha(''), '全为空时是空串的哈希，不是抛错');
});

test('U8 autoPendingCount = 未关闭待答 + 尚未取得补答许可的进行中项', () => {
  const twoOpen = { unanswered: [{ phase: 'not-sent' }, { phase: 'unqualified' }, { phase: 'not-sent', handledByUserAt: 'x' }, { phase: 'not-sent', autoHandled: true }] };
  assert.equal(autoPendingCount(twoOpen), 2, '已人工处理与已自动处理都不计入');
  assert.equal(autoPendingCount({ unanswered: [], status: 'inflight', pending: { incoming: [{ id: 'm1' }] } }), 1);
  assert.equal(autoPendingCount({ unanswered: [], status: 'delivery-uncertain', pending: { incoming: [{ id: 'm1' }] } }), 1);
  assert.equal(autoPendingCount({ unanswered: [], status: 'inflight', pending: { incoming: [{ id: 'm1' }], backlogAuthorization: 'x' } }), 0,
    '已取得补答许可就不算待人工处理');
  assert.equal(autoPendingCount({ unanswered: [], status: 'idle', pending: { incoming: [{ id: 'm1' }] } }), 0, '非 inflight/uncertain 不计');
  assert.equal(autoPendingCount({}), 0);
  assert.equal(unresolvedManual({ accountActionRequired: true }), 1);
  assert.equal(unresolvedManual({}), 0);
});

test('U9 unansweredReason 优先用原记录原因，超长截断，空白则按阶段取文案', () => {
  assert.equal(unansweredReason({ reason: '  自定义原因  ' }), '自定义原因');
  assert.equal(unansweredReason({ reason: '甲'.repeat(300) }).length, 200);
  assert.equal(unansweredReason({ reason: '   ', phase: 'delivery-uncertain' }), '上次发送结果未确认，未自动重发。');
  assert.equal(unansweredReason({ phase: 'unsupported-media' }), '消息附件未能可靠读取，未推断内容。');
  assert.equal(unansweredReason({ phase: 'not-sent' }), '发送前检查未通过，未发送。');
  assert.equal(unansweredReason({ phase: 'stopped-before-send' }), '维护或停止前未发送，保留待核对。');
  assert.equal(unansweredReason({ phase: 'unqualified' }), '新消息尚未取得可靠的新到达资格，未自动回复。');
  assert.equal(unansweredReason({ phase: '某个未知阶段' }), '这条消息没有完成自动回复，保留待核对。');
  assert.equal(unansweredReason({}), '这条消息没有完成自动回复，保留待核对。');
});

test('U10 messageKind 只据可见类型命名，未知一律"未知类型"', () => {
  assert.equal(messageKind({ media: { type: 'voice' } }), '语音');
  assert.equal(messageKind({ media: { type: 'image' } }), '图片');
  assert.equal(messageKind({ media: { type: 'emoji' } }), '表情');
  assert.equal(messageKind({ media: { type: 'shared-work' } }), '分享作品');
  assert.equal(messageKind({ unsupported: true }), '不支持的消息');
  assert.equal(messageKind({ text: '你好' }), '文字');
  assert.equal(messageKind({ text: '   ' }), '未知类型');
  assert.equal(messageKind({ media: { type: 'video' } }), '未知类型', '不认识的媒体类型不猜');
  assert.equal(messageKind(null), '未知类型');
});

test('U11 unansweredPreview 有正文取第一条并截断，没正文如实说没有', () => {
  const withText = unansweredPreview({ incoming: [msg('m1', '   '), msg('m2', '  正片  '), msg('m3', '第二条')] });
  assert.deepEqual(withText, { preview: '正片', previewNote: '本地保留的文字预览，仅用于核对；不会自动补发。' });
  assert.equal(unansweredPreview({ incoming: [msg('m1', '甲'.repeat(400))] }).preview.length, 160);
  assert.deepEqual(unansweredPreview({ incoming: [{ id: 'm1', media: { type: 'voice' } }, { id: 'm2', media: { type: 'image' } }] }),
    { preview: null, previewNote: '语音、图片消息没有可显示的文字正文，未做识别或猜测。' });
  assert.deepEqual(unansweredPreview({ incoming: [] }),
    { preview: null, previewNote: '本地没有这条消息的可显示内容，未做识别或猜测。' });
  assert.deepEqual(unansweredPreview(null),
    { preview: null, previewNote: '本地没有这条消息的可显示内容，未做识别或猜测。' });
});

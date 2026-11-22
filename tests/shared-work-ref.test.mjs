// 分享作品引用推断（迭代 16）。
// 对方说"刚才那个视频怎么样"时，消息本身没有指向，只能靠上下文猜——
// 但这层宁可返回空数组，也不去评论一个对方没提的作品。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { referencedSharedWork } from '../evidence/shared-work-ref.mjs';

const member = name => `member:${createHash('sha256').update(name).digest('hex')}`;
const text = (id, body, extra = {}) => ({ id, sender: 'incoming', kind: 'text', text: body, ...extra });
const outgoing = (id, body) => ({ id, sender: 'outgoing', kind: 'text', text: body });
const card = (id, videoId = 'v1', extra = {}) => ({ id, sender: 'incoming', kind: 'shared-work', media: { type: 'shared-work', videoId, title: '猫猫合集' }, ...extra });
const dm = { isGroup: false };
const group = { isGroup: true };

test('W1 待发消息里已有分享卡片时不再额外推断', () => {
  const incoming = [card('c1'), text('t1', '刚才那个视频怎么样')];
  assert.deepEqual(referencedSharedWork(dm, incoming, [], incoming), [], '用户这次就是在说这张卡');
});

test('W2 没有指代或只是泛问，一律不推断', () => {
  const card1 = card('c1');
  const plain = [card1, text('t1', '今天天气不错')];
  assert.deepEqual(referencedSharedWork(dm, [plain[1]], [], plain), []);
  const generic = [card1, text('t1', '你喜欢什么视频')];
  assert.deepEqual(referencedSharedWork(dm, [generic[1]], [], generic), [], '"喜欢什么视频"是泛问，不是指代');
  const types = [card1, text('t1', '你平时看什么类型的作品')];
  assert.deepEqual(referencedSharedWork(dm, [types[1]], [], types), [], '"什么类型"同样是泛问');
  assert.deepEqual(referencedSharedWork(dm, [{ id: 't0', sender: 'incoming', kind: 'text' }], [], [{ id: 't0', sender: 'incoming', kind: 'text' }]), [], '没有 text 字段不崩');
});

test('W3 明确指代时找到前面那张分享卡', () => {
  const messages = [card('c1', 'v1'), text('t1', '刚才那个视频怎么样')];
  const found = referencedSharedWork(dm, [messages[1]], [], messages);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'c1');
});

test('W4 只回溯最近 8 条：第 9 条之前的不算', () => {
  const filler = index => text(`f${index}`, `闲聊${index}`);
  const trigger = text('t1', '刚才那个视频怎么样');
  const within = [filler(0), card('c1'), ...Array.from({ length: 7 }, (_, i) => filler(i + 1)), trigger];
  assert.equal(within.findIndex(item => item.id === 't1'), 9);
  assert.equal(referencedSharedWork(dm, [trigger], [], within)[0].id, 'c1', '索引 1 在 index-8=1 的边界内');
  const beyond = [card('c0'), filler(0), ...Array.from({ length: 7 }, (_, i) => filler(i + 1)), trigger];
  assert.deepEqual(referencedSharedWork(dm, [trigger], [], beyond), [], '索引 0 落在 8 条之外，不得去猜');
});

test('W5 遇到出站消息立刻停止，不跨越自己说过的话', () => {
  const messages = [card('c1'), outgoing('o1', '我刚发了一条'), text('t1', '刚才那个视频怎么样')];
  assert.deepEqual(referencedSharedWork(dm, [messages[2]], [], messages), []);
});

test('W6 跳过不支持解析的分享卡', () => {
  const messages = [card('c1', 'v1', { unsupported: true }), text('t1', '刚才那个视频怎么样')];
  assert.deepEqual(referencedSharedWork(dm, [messages[1]], [], messages), []);
});

test('W7 历史 context 里同 ID 但指纹不同 → 视为被改过，跳过', () => {
  const tampered = card('c1', 'v1');
  const context = [{ ...card('c1', 'v1'), media: { type: 'shared-work', videoId: 'v-other', title: '猫猫合集' } }];
  const messages = [tampered, text('t1', '刚才那个视频怎么样')];
  assert.deepEqual(referencedSharedWork(dm, [messages[1]], context, messages), [], '同一 ID 内容变了就不是同一张卡');
});

test('W8 群聊里必须同一位成员发的卡（无明确指代时）', () => {
  const mine = member('阿甲'), theirs = member('阿乙');
  // 注意用不含指代词的触发语：'那个视频怎么样' 带"那个"，属于 W9 的放行场景
  const messages = [card('c1', 'v1', { memberId: theirs }), text('t1', '评价一下视频', { memberId: mine })];
  assert.deepEqual(referencedSharedWork(group, [messages[1]], [], messages), [], '不同成员不能替人认领');

  const same = [card('c1', 'v1', { memberId: mine }), text('t1', '评价一下视频', { memberId: mine })];
  assert.equal(referencedSharedWork(group, [same[1]], [], same)[0].id, 'c1');
});

test('W9 群聊跨成员但用了明确指代词时放行', () => {
  const mine = member('阿甲'), theirs = member('阿乙');
  const messages = [card('c1', 'v1', { memberId: theirs }), text('t1', '刚才那个视频怎么样', { memberId: mine })];
  assert.equal(referencedSharedWork(group, [messages[1]], [], messages)[0].id, 'c1',
    '明确指代时允许指认别人发的卡');
});

test('W10 群聊里成员 ID 形状不合法（非 member: 哈希）时不猜', () => {
  const messages = [card('c1', 'v1', { memberId: 'member:not-a-hash' }), text('t1', '那个视频怎么样', { memberId: 'member:not-a-hash' })];
  assert.deepEqual(referencedSharedWork(group, [messages[1]], [], messages), []);
});

test('W11 多条触发消息时从最新那条往前找', () => {
  const olderCard = card('c-old', 'v-old');
  const newerCard = card('c-new', 'v-new');
  const messages = [olderCard, text('t-old', '那个视频怎么样'), newerCard, text('t-new', '这个视频好看吗')];
  const found = referencedSharedWork(dm, [messages[1], messages[3]], [], messages);
  assert.equal(found[0].id, 'c-new', '最新的提问对应最近的那张卡');
});

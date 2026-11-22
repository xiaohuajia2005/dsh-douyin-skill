import test from 'node:test';
import assert from 'node:assert/strict';
import { replyContentWindow, REPLY_WINDOW } from '../chat-agent.mjs';

const msg = (id, sender, text = id) => ({ id, sender, text });

test('没有待回边界时退回最后固定窗口', () => {
  const messages = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, i % 2 ? 'incoming' : 'outgoing'));
  const window = replyContentWindow(messages, []);
  assert.equal(window.length, REPLY_WINDOW.fallback);
  assert.equal(window.at(-1).id, 'm19');
});

test('对方连发超过固定条数时，待回消息一条都不能少', () => {
  // 上一条 AI 回复之后对方连发 15 条，旧的 slice(-12) 会吃掉前 3 条。
  const messages = [msg('o0', 'outgoing'), ...Array.from({ length: 15 }, (_, i) => msg(`i${i + 1}`, 'incoming'))];
  const pendingIds = messages.filter(item => item.sender === 'incoming').map(item => item.id);
  const window = replyContentWindow(messages, pendingIds);
  const included = window.filter(item => item.sender === 'incoming').map(item => item.id);
  assert.deepEqual(included, pendingIds);
});

test('从最早一条待回消息往前保留少量上文', () => {
  const messages = [
    ...Array.from({ length: 10 }, (_, i) => msg(`old${i}`, i % 2 ? 'incoming' : 'outgoing')),
    msg('o1', 'outgoing'),
    msg('i1', 'incoming'), msg('i2', 'incoming'), msg('i3', 'incoming'),
  ];
  const window = replyContentWindow(messages, ['i1', 'i2', 'i3']);
  // 最早待回消息下标是 11，往前留 8 条，从 old3 开始。
  assert.equal(window[0].id, 'old3');
  assert.deepEqual(window.slice(-3).map(item => item.id), ['i1', 'i2', 'i3']);
});

test('待回消息过多时只保最后上限，仍带少量上文', () => {
  const messages = Array.from({ length: 60 }, (_, i) => msg(`i${i}`, 'incoming'));
  const window = replyContentWindow(messages, messages.map(item => item.id));
  assert.equal(window.length, REPLY_WINDOW.before + REPLY_WINDOW.maxPending);
  assert.equal(window.at(-1).id, 'i59');
});

test('待回 id 在消息里找不到时回退固定窗口', () => {
  const messages = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, 'incoming'));
  const window = replyContentWindow(messages, ['missing']);
  assert.equal(window.length, REPLY_WINDOW.fallback);
});

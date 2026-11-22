// ============================================================
// 今日问候资格判定特征测试 —— 迭代 11
//
// 这条规则决定"今天要不要主动跟这位好友说话"，两个方向的错都不可接受：
// 该发不发只是少一次互动；不该发却发 = 同一天骚扰两次，或把寒暄插到对话中间。
// 所以默认答案必须是 date-unknown，每条用例都在证明"证据不足时它确实没放行"。
// 时间一律用固定时间戳 + Asia/Shanghai 判定，不依赖运行机器时区。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConversationDay } from '../service/day-decision.mjs';

// 北京时间 2026-11-21 12:00（= UTC 04:00）
const NOW = Date.parse('2026-11-21T12:00:00+08:00');
const iso = ms => new Date(ms).toISOString();
const base = (extra = {}) => ({
  conversation: { id: 'conv:abc', name: '小鱼' },
  messages: [],
  dayEvidence: { latestEndVerified: true, chronology: 'oldest-first', observedAt: iso(NOW - 5_000), emptyTodayVerified: true },
  ...extra,
});
const day = (snapshot, options = { now: NOW }) => analyzeConversationDay(snapshot, options);

test('D1 页面处于阻塞状态时一律 date-unknown', () => {
  for (const key of ['blocked', 'loginRequired', 'verificationRequired'])
    assert.equal(day(base({ [key]: true })).status, 'date-unknown', `${key} 必须拦下主动问候`);
});

test('D2 快照证据不完整就作废：最新端/正序/时效/消息数组缺一不可', () => {
  assert.equal(day(base({ dayEvidence: undefined })).status, 'date-unknown');
  assert.equal(day(base({ messages: undefined })).status, 'date-unknown');
  const evidence = extra => ({ ...base().dayEvidence, ...extra });
  assert.equal(day(base({ dayEvidence: evidence({ latestEndVerified: false }) })).status, 'date-unknown', '最新端未核实');
  assert.equal(day(base({ dayEvidence: evidence({ chronology: 'newest-first' }) })).status, 'date-unknown', '时间轴不是正序');
  assert.equal(day(base({ dayEvidence: evidence({ observedAt: undefined }) })).status, 'date-unknown');
  assert.equal(day(base({ dayEvidence: evidence({ observedAt: 'not-a-date' }) })).status, 'date-unknown');
});

test('D3 快照时效 60 秒是闭区间：正好 60 秒还认，61 秒作废，未来时间也作废', () => {
  const withObservedAt = observedAt => base({ dayEvidence: { ...base().dayEvidence, observedAt } });
  assert.equal(day(withObservedAt(iso(NOW - 60_000))).status, 'eligible', '正好 60 秒仍算新鲜');
  assert.equal(day(withObservedAt(iso(NOW - 60_001))).status, 'date-unknown', '超过 60 秒不算新鲜');
  assert.equal(day(withObservedAt(iso(NOW + 1_000))).status, 'date-unknown', '未来时间戳不可信');
  assert.equal(day(withObservedAt(iso(NOW - 24 * 3600_000))).status, 'date-unknown', '昨天的快照不能用来判断今天');
});

test('D4 共同账本已确认今天发过就绝不重发，账本自身也要合格', () => {
  const entry = extra => ({ confirmed: true, recipientId: 'conv:abc', messageId: 'm1', date: '2026-11-21', at: iso(NOW - 3600_000), ...extra });
  assert.equal(day(base(), { now: NOW, confirmedHistory: [entry()] }).status, 'already-sent');
  assert.equal(day(base(), { now: NOW, confirmedHistory: [entry({ confirmed: false })] }).status, 'eligible', '未确认的记录不算');
  assert.equal(day(base(), { now: NOW, confirmedHistory: [entry({ messageId: '  ' })] }).status, 'eligible', '没有消息 ID 不算');
  assert.equal(day(base(), { now: NOW, confirmedHistory: [entry({ at: iso(NOW - 24 * 3600_000) })] }).status, 'eligible', '实际时间不是今天不算');
  assert.equal(day(base(), { now: NOW, confirmedHistory: [entry({ date: '2026-11-20' })] }).status, 'eligible', '账本日期字段不是今天不算');
  assert.equal(day(base(), { now: NOW, confirmedHistory: [entry({ at: iso(NOW + 60_000) })] }).status, 'eligible', '未来时间不算');
  assert.equal(day(base(), { now: NOW, confirmedHistory: [entry({ recipientId: 'conv:other' })] }).status, 'eligible', '别人的账本不算');
});

test('D5 会话里有一行方向不明 / 发送中 / 失败，整份快照作废', () => {
  const row = extra => ({ sender: 'incoming', dateEvidence: { raw: '今天 09:00' }, ...extra });
  assert.equal(day(base({ messages: [row({ sender: 'system' })] })).status, 'date-unknown');
  assert.equal(day(base({ messages: [row({ pending: true })] })).status, 'date-unknown');
  assert.equal(day(base({ messages: [row({ failed: true })] })).status, 'date-unknown');
  assert.equal(day(base({ messages: [row()] })).status, 'pending-incoming', '正常来消息应走待回复分支');
});

test('D6 今天发过就是 already-sent：三种日期写法都要认，UTC 要按北京时区折算', () => {
  const outgoing = raw => base({ messages: [{ sender: 'outgoing', dateEvidence: { raw } }] });
  assert.equal(day(outgoing('今天 12:30')).status, 'already-sent');
  assert.equal(day(outgoing('今天')).status, 'already-sent', '"今天" 单独出现也算');
  assert.equal(day(outgoing('2026-11-21 12:30')).status, 'already-sent');
  assert.equal(day(outgoing('2026年11月21日 12:30')).status, 'already-sent');
  assert.equal(day(outgoing('2026-11-21T02:30:00Z')).status, 'already-sent', 'UTC 02:30 = 北京 10:30，仍是今天');
  assert.equal(day(outgoing('2026-11-20T17:30:00Z')).status, 'already-sent', 'UTC 前一天 17:30 = 北京今天 01:30');
  assert.equal(day(outgoing('2026-11-21T20:00:00Z')).status, 'date-unknown', 'UTC 20:00 = 北京次日 04:00，日期部分写着 21 号也不能算今天');
});

test('D7 待回复优先于主动问候，但"今天已发"优先级最高', () => {
  const rows = messages => base({ messages });
  assert.equal(day(rows([
    { sender: 'outgoing', dateEvidence: { raw: '2026-11-20 21:00' } },
    { sender: 'incoming', dateEvidence: { raw: '今天 09:00' } },
  ])).status, 'pending-incoming', '对方话没回就别插寒暄');
  assert.equal(day(rows([
    { sender: 'outgoing', dateEvidence: { raw: '今天 09:00' } },
    { sender: 'incoming', dateEvidence: { raw: '今天 09:05' } },
  ])).status, 'already-sent', '今天已发过，不再进入问候流程');
});

test('D8 只有明确证据才 eligible：空会话需 emptyTodayVerified，非空需最近出站日期早于今天', () => {
  assert.equal(day(base()).status, 'eligible');
  assert.equal(day(base({ dayEvidence: { ...base().dayEvidence, emptyTodayVerified: undefined } })).status, 'date-unknown', '空会话没有"今天确实为空"的核实就不算');
  assert.equal(day(base({ messages: [{ sender: 'outgoing', dateEvidence: { raw: '2026-11-20 21:00' } }] })).status, 'eligible');
  assert.equal(day(base({ messages: [{ sender: 'outgoing', dateEvidence: { raw: '2026-11-19 21:00' } }] })).status, 'eligible');
});

test('D9 日期读不出来就是 date-unknown，绝不当成"今天没发过"', () => {
  const outgoing = row => base({ messages: [{ sender: 'outgoing', ...row }] });
  assert.equal(day(outgoing({ dateEvidence: { raw: '昨天 20:00' } })).status, 'date-unknown');
  assert.equal(day(outgoing({ dateEvidence: { raw: '昨天' } })).status, 'date-unknown');
  assert.equal(day(outgoing({ dateEvidence: { kind: 'unknown', raw: '2026-11-20 21:00' } })).status, 'date-unknown', '标记为 unknown 时 raw 再像也不算');
  assert.equal(day(outgoing({ dateEvidence: { raw: '2026-13-45 10:00' } })).status, 'date-unknown', '非法日期');
  assert.equal(day(outgoing({ dateEvidence: { raw: '' } })).status, 'date-unknown');
  assert.equal(day(outgoing({})).status, 'date-unknown');
});

test('D10 "今天下午" 这类模糊写法不被当成今天', () => {
  const outgoing = raw => base({ messages: [{ sender: 'outgoing', dateEvidence: { raw } }] });
  assert.equal(day(outgoing('今天 12:30')).status, 'already-sent');
  assert.equal(day(outgoing('今天下午')).status, 'date-unknown', '只有"今天"后接空白/结尾才算确定今天');
  assert.equal(day(outgoing('今天晚上八点')).status, 'date-unknown');
});

test('D11 日期可来自 sentAt / timestamp 回退字段', () => {
  assert.equal(day(base({ messages: [{ sender: 'outgoing', sentAt: '2026-11-21 09:00' }] })).status, 'already-sent');
  assert.equal(day(base({ messages: [{ sender: 'outgoing', timestamp: '2026-11-20 09:00' }] })).status, 'eligible');
  assert.equal(day(base({ messages: [{ direction: 'outgoing', timestamp: '2026-11-21 09:00' }] })).status, 'already-sent', 'direction 与 sender 等价');
});

test('D12 now 支持传函数或固定值', () => {
  assert.equal(day(base(), { now: () => NOW }).status, 'eligible');
  assert.equal(day(base(), { now: NOW }).status, 'eligible');
  assert.equal(day(base({ dayEvidence: { ...base().dayEvidence, observedAt: iso(NOW - 120_000) } }), { now: () => NOW }).status, 'date-unknown', '函数形式同样按时效判定');
});

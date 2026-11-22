// ============================================================
// reply.timing 埋点特征测试 —— 迭代 4
//
// 锁的是"重构前那一行字面量"的行为：字段名、键序、三个差值的算法。
// 改前代码：
//   { recipientId, modelMs: tModelEnd - tModelStart,
//     rereadMs: tRereadEnd - tModelEnd,
//     totalBeforeSendMs: Date.now() - tModelStart }
// 所以这里给固定时间戳，断言结果与手算完全一致；now 由调用方注入，不读真实时钟。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyTiming } from '../service/reply-timing.mjs';

const base = { recipientId: 'c_1024', tModelStart: 1000, tModelEnd: 1500, tRereadEnd: 1800, now: 2000 };

test('T1 reply.timing 字段与计算 = 重构前字面量（逐字段）', () => {
  assert.deepEqual(buildReplyTiming(base), {
    recipientId: 'c_1024',
    modelMs: 500,
    rereadMs: 300,
    totalBeforeSendMs: 1000,
  });
});

test('T2 字段顺序锁定（决定日志 JSON 的键序）', () => {
  assert.deepEqual(Object.keys(buildReplyTiming(base)),
    ['recipientId', 'modelMs', 'rereadMs', 'totalBeforeSendMs']);
});

test('T3 totalBeforeSendMs 只由 now 与 tModelStart 决定', () => {
  assert.equal(buildReplyTiming({ ...base, now: base.tModelStart + 42 }).totalBeforeSendMs, 42);
  assert.equal(buildReplyTiming({ ...base, tRereadEnd: 999999 }).totalBeforeSendMs, 1000,
    'reread 结束时间不影响 totalBeforeSendMs');
});

test('T4 三个时间点相等时差值全为 0', () => {
  const t = 7777;
  assert.deepEqual(buildReplyTiming({ recipientId: 'x', tModelStart: t, tModelEnd: t, tRereadEnd: t, now: t }),
    { recipientId: 'x', modelMs: 0, rereadMs: 0, totalBeforeSendMs: 0 });
});

test('T5 不修改入参，也不夹带额外字段', () => {
  const input = { ...base };
  const out = buildReplyTiming(input);
  assert.deepEqual(input, base);
  assert.equal(Object.keys(out).length, 4);
});

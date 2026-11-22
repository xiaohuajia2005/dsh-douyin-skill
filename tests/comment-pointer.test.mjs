// R2 抽取出来的采样收敛逻辑：连续 N 次读到同一个点才算通过。
// 这段规则原来埋在 prepareCommentPointer 的 while 循环里，没有任何测试。
// 它决定"能不能点下去"，所以单独锁住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitStableCommentPoint } from '../comment-browser.mjs';

const A = { x: 10, y: 20, width: 100, height: 30, clickX: 26, clickY: 35 };
const B = { ...A, x: 12 };                     // x 差 2px，超过 0.5 容差，视为抖动
const subpixel = { ...A, x: A.x + 0.4 };       // 0.4px 在容差内，应视为同一点
const noop = async () => {};

const scripted = values => {
  let i = 0;
  const calls = { count: 0 };
  const read = async () => { calls.count++; return values[Math.min(i++, values.length - 1)]; };
  return { read, calls };
};

test('R2-1 连续 3 次读到同一个点 → 通过并返回该点', async () => {
  const { read, calls } = scripted([A, A, A, A, A]);
  const point = await awaitStableCommentPoint(read, { check: noop });
  assert.deepEqual(point, A);
  assert.equal(calls.count, 3, '第 3 次稳定即应返回，不必多采');
});

test('R2-2 只连续 2 次就断了 → 超时返回 null（调用方据此拒绝点击）', async () => {
  const { read } = scripted([A, A, null]);
  const point = await awaitStableCommentPoint(read, { check: noop, timeoutMs: 40, sampleMs: 1 });
  assert.equal(point, null);
});

test('R2-3 点位持续抖动 → 永不通过', async () => {
  let i = 0;
  const read = async () => (i++ % 2 ? A : B);
  const point = await awaitStableCommentPoint(read, { check: noop, timeoutMs: 40, sampleMs: 1 });
  assert.equal(point, null);
});

test('R2-4 中途读到 null 会清零计数，必须重新连续 3 次', async () => {
  const { read, calls } = scripted([A, A, null, A, A, A, A]);
  const point = await awaitStableCommentPoint(read, { check: noop });
  assert.deepEqual(point, A);
  assert.equal(calls.count, 6, '第 3 次读到 null 后要重新数满 3 次');
});

test('R2-5 亚像素差异（≤0.5px）算同一个点', async () => {
  const { read } = scripted([A, subpixel, subpixel, subpixel]);
  const point = await awaitStableCommentPoint(read, { check: noop });
  assert.ok(point, '亚像素抖动不应阻止通过');
  assert.equal(point.y, A.y);
});

test('R2-6 每次采样前都会调用 check（用于中止与风控自检）', async () => {
  const { read } = scripted([A, A, A]);
  let checks = 0;
  await awaitStableCommentPoint(read, { check: async () => { checks++; } });
  assert.equal(checks, 3);
});

test('R2-7 check 抛出中止信号时向上抛，不吞异常', async () => {
  const { read } = scripted([A, A, A]);
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(() => awaitStableCommentPoint(read, { check: async () => { throw abort; } }), /aborted/);
});

test('R2-8 requiredSamples 可调，默认值为 3', async () => {
  const { read, calls } = scripted([A, A, A, A, A]);
  await awaitStableCommentPoint(read, { check: noop, requiredSamples: 5 });
  assert.equal(calls.count, 5);
  assert.equal(awaitStableCommentPoint.length, 2, '签名应保持 (readPoint, options)');
});

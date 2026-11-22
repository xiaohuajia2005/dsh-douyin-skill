// ============================================================
// 评论时序常量（R4）的守卫测试
//
// 这个文件守的不是"数字等于多少"，而是三件容易在后续迭代里悄悄退化的事：
//   1. 常量必须是冻结对象，且都是正整数（防止有人塞字符串/负数让定时器静默退化）；
//   2. 降频与节流必须真的生效（postPollMs 不能又回到 40，fullRecheckEvery 不能回到 1）；
//   3. 页内序列化代码里的值必须**注入成功**——这正是本轮最容易翻车的点：
//      toString() 抓不到模块作用域，直接引用模块常量会静默变成 undefined。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMENT_RECEIPT_LIMIT, COMMENT_SCAN_BUDGET, COMMENT_TIMING } from '../comment/timing.mjs';
import { readCommentDom } from '../comment-browser.mjs';

const POSITIVE = value => Number.isSafeInteger(value) && value > 0;

test('T1 三组常量全部冻结且为正整数', () => {
  for (const [name, group] of Object.entries({ COMMENT_TIMING, COMMENT_SCAN_BUDGET, COMMENT_RECEIPT_LIMIT })) {
    assert.equal(Object.isFrozen(group), true, `${name} 必须 Object.freeze`);
    for (const [key, value] of Object.entries(group)) assert.equal(POSITIVE(value), true, `${name}.${key} = ${value} 不是正整数`);
  }
});

test('T2 降频与节流必须生效（不是把重构前的值原样搬一遍）', () => {
  // 40ms 时一次评论约 150–200 次/秒 CDP 往返；低于 100ms 等于没降频。
  assert.ok(COMMENT_TIMING.postPollMs >= 100, `postPollMs=${COMMENT_TIMING.postPollMs} 仍属于高频轮询`);
  // 1 等于"每拍都重跑 findCommentSubmit"，即完全没有节流。
  assert.ok(COMMENT_TIMING.fullRecheckEvery >= 2, `fullRecheckEvery=${COMMENT_TIMING.fullRecheckEvery} 没有节流`);
  // 节流后的全量重查间隔仍应在秒级以内，别把"降频"做成"基本不查"。
  assert.ok(COMMENT_TIMING.postPollMs * COMMENT_TIMING.fullRecheckEvery <= 1000, '全量重查间隔超过 1s，检测延迟过大');
});

test('T3 稳定采样必须是"多次一致"，不能被改成单次即通过', () => {
  assert.ok(COMMENT_TIMING.stableSamples >= 2, 'stableSamples < 2 意味着单次采样就算稳定');
  assert.ok(COMMENT_TIMING.stableTimeoutMs >= COMMENT_TIMING.stableSampleMs * COMMENT_TIMING.stableSamples, '稳定采样超时窗口不足以完成要求的采样次数');
});

test('T4 扫描预算真的注入进了页内源码，没有残留字面量', () => {
  const source = readCommentDom.toString();
  assert.ok(source.includes(`const budget=${JSON.stringify(COMMENT_SCAN_BUDGET)}`), '页内源码没有注入 budget 常量');
  for (const literal of ['<= 512', '> 180', '> 8', 'length > 32']) assert.equal(source.includes(literal), false, `页内源码仍残留字面量 ${literal}`);
  // 注入的东西必须在真正用到，而不是"注入了但函数还在读旧变量"。
  for (const key of ['budget.textLength', 'budget.nodes', 'budget.images', 'budget.altLength']) assert.ok(source.includes(key), `页内源码没有使用 ${key}`);
});

test('T5 事件门禁窗口经 input 传参，且缺省不放宽', () => {
  const file = readFileSync(new URL('../comment-browser.mjs', import.meta.url), 'utf8');
  assert.ok(file.includes('eventGateMs: COMMENT_TIMING.eventGateMs'), '安装几何见证时没有把 eventGateMs 传给页内');
  assert.ok(file.includes('Number.isFinite(input.eventGateMs) ? input.eventGateMs : 1500'), '页内门禁窗口缺少"缺省 1500ms"的兜底，传参缺失时会静默失效');
});

test('T6 定时器与关键等待都引用常量，Node 侧不再留裸数字', () => {
  const file = readFileSync(new URL('../comment-browser.mjs', import.meta.url), 'utf8');
  for (const pattern of [
    /\}, COMMENT_TIMING\.postPollMs\)/,
    /COMMENT_TIMING\.typeDelayMs/,
    /COMMENT_TIMING\.activationTimeoutMs/,
    /COMMENT_TIMING\.enableTimeoutMs/,
    /COMMENT_TIMING\.readbackAttempts/,
    /COMMENT_TIMING\.readbackMs/,
    /COMMENT_TIMING\.stateTickMs/,
  ]) assert.ok(pattern.test(file), `comment-browser.mjs 缺少 ${pattern}`);
  for (const bare of ['}, 40)', 'delay: 10 }', ', check, signal, 3000)', ', check, signal, 1500)']) {
    assert.equal(file.includes(bare), false, `comment-browser.mjs 仍有硬编码 ${bare}`);
  }
});

test('T7 点击前的决策点必须是全量核对（否则节流会削掉最终守卫）', () => {
  const file = readFileSync(new URL('../comment-browser.mjs', import.meta.url), 'utf8');
  const full = file.match(/check\(\{ full: true \}\)/g) || [];
  assert.ok(full.length >= 3, `只找到 ${full.length} 处全量核对；填入后、标记发布控件后、点击前至少各一处`);
  // 最终点击之前必须是全量核对：submitPointer.click() 前最近的一次 check 要带 full。
  const beforeClick = file.slice(0, file.indexOf('await submitPointer.click()'));
  assert.ok(beforeClick.lastIndexOf('check({ full: true })') > beforeClick.lastIndexOf('prepareCommentPointer(page, send'), '最终点击前的核对没有带 full');
});

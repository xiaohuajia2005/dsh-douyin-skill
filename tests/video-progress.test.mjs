// ============================================================
// 播放推进核验特征测试 —— 迭代 12
//
// 这个函数是"视频真的播了 N 秒"的唯一数学依据：返回可采信秒数，或 null 表示这批画面作废。
// 每个用例都在证明它**只认物理一致性**：同一个视频、连续时钟、推进速度对得上倍速。
// 阈值是行为参数（±0.05s 时长、40s 墙钟、0.35s 双时钟、15%/0.2s 偏差、±0.04s 容差），
// 有意留在代码里不进 config —— 见 refactor/PLAN.md 红线。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackProgress } from '../evidence/video-progress.mjs';

// 一次采样的"视频状态 + 双时钟"快照；默认：30s 视频、1x、播放中、已能解码。
const bound = (extra = {}) => ({
  videoId: 'v1', elementToken: 'e1', sourceHash: 's1', documentTimeOrigin: 1000,
  paused: false, seeking: false, readyState: 4, duration: 30, loop: false, playbackRate: 1,
  hostTimeMs: 10_000, pageTimeMs: 5_000, time: 3,
  ...extra,
});
// 2 秒后：宿主与页面时钟各走 2000ms，视频 3s → 5s。
const later = (extra = {}) => bound({ hostTimeMs: 12_000, pageTimeMs: 7_000, time: 5, ...extra });
const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `期望 ${expected}，实际 ${actual}`);

test('V1 1x 播 2 秒：推进等于墙钟，结果就是 2 秒', () => {
  near(playbackProgress(bound(), later()), 2);
});

test('V2 loop 回绕按圈数折算，标记为 loop 时才算', () => {
  const head = bound({ time: 29, duration: 30, loop: true });
  const tail = bound({ time: 1, duration: 30, loop: true, hostTimeMs: 12_000, pageTimeMs: 7_000 });
  near(playbackProgress(head, tail), 2, 1e-9);
  assert.equal(playbackProgress({ ...head, loop: false }, { ...tail, loop: false }), null, '非 loop 下时间倒退就是 seek');
});

test('V3 暂停 / seek / 未就绪一律作废，且要求显式 false', () => {
  assert.equal(playbackProgress(bound({ paused: true }), later()), null);
  assert.equal(playbackProgress(bound(), later({ paused: true })), null);
  assert.equal(playbackProgress(bound({ paused: undefined }), later()), null, '缺字段不等于 false');
  assert.equal(playbackProgress(bound({ seeking: true }), later()), null);
  assert.equal(playbackProgress(bound({ readyState: 1 }), later()), null);
  assert.equal(playbackProgress(bound(), later({ readyState: 1 })), null);
});

test('V4 换视频 / 换元素 / 换源 / 换时间原点都不算同一次播放', () => {
  for (const key of ['videoId', 'elementToken', 'sourceHash', 'documentTimeOrigin'])
    assert.equal(playbackProgress(bound(), later({ [key]: 'other' })), null, `${key} 变化必须作废`);
  assert.equal(playbackProgress(bound(), later({ duration: 30.06 })), null, '时长漂移 0.06s 超限');
  near(playbackProgress(bound(), later({ duration: 30.04 })), 2, 1e-9);
});

test('V5 倍速必须合法且前后一致，推进量按倍速折算', () => {
  const fast = bound({ playbackRate: 2, hostTimeMs: 10_000, pageTimeMs: 5_000, time: 3 });
  const fastLater = bound({ playbackRate: 2, hostTimeMs: 11_000, pageTimeMs: 6_000, time: 5 });
  near(playbackProgress(fast, fastLater), 2);
  assert.equal(playbackProgress(bound({ playbackRate: 0 }), later()), null);
  assert.equal(playbackProgress(bound({ playbackRate: 5 }), later()), null);
  assert.equal(playbackProgress(bound({ playbackRate: 2 }), later()), null, '倍速中途变化不算同一段播放');
  assert.equal(playbackProgress(bound(), later({ loop: true })), null, 'loop 标记中途变化');
});

test('V6 双时钟必须互相印证：不倒退、不超 40 秒、彼此差不超过 0.35 秒', () => {
  assert.equal(playbackProgress(bound({ hostTimeMs: 12_000 }), later({ hostTimeMs: 11_000 })), null, '宿主时钟倒退');
  assert.equal(playbackProgress(bound(), later({ pageTimeMs: 4_000 })), null, '页面时钟倒退');
  assert.equal(playbackProgress(bound(), later({ pageTimeMs: 7_400 })), null, '两钟相差 0.4 秒');
  assert.equal(playbackProgress(bound({ hostTimeMs: NaN }), later()), null);
});

test('V7 推进速度对不上倍速就作废，15%（至少 0.2 秒）是容忍上限', () => {
  assert.equal(playbackProgress(bound(), later({ time: 4 })), null, '墙钟 2 秒但视频只走 1 秒');
  near(playbackProgress(bound(), later({ time: 5.1 })), 2.1, 1e-9);
  const wide = duration => [bound({ duration, hostTimeMs: 10_000, pageTimeMs: 5_000, time: 3 }), bound({ duration, hostTimeMs: 20_000, pageTimeMs: 15_000, time: 11.5 })];
  near(playbackProgress(...wide(100)), 8.5, 1e-9);        // 期望 10 秒，实走 8.5 = 15%，刚好容忍
  const [head, tail] = wide(100);
  assert.equal(playbackProgress(head, { ...tail, time: 11.4 }), null, '16% 偏差必须作废');
});

test('V8 视频时间越界或时长非法一律作废', () => {
  assert.equal(playbackProgress(bound(), later({ time: 30.1 })), null, '超出 duration+0.05');
  assert.equal(playbackProgress(bound({ time: -1 }), later()), null);
  assert.equal(playbackProgress(bound({ duration: 0 }), later()), null);
  assert.equal(playbackProgress(bound({ duration: Infinity }), later()), null);
});

test('V9 极小负推进归零而不是报错，超过 0.04 秒的倒退作废', () => {
  assert.equal(playbackProgress(bound(), bound({ time: 2.97 })), 0, '时钟没走、视频微退 0.03 秒 → 0');
  assert.equal(playbackProgress(bound(), bound({ time: 2.95 })), null, '倒退 0.05 秒超限');
});

test('V10 空输入与未来时间作废', () => {
  assert.equal(playbackProgress(null, later()), null);
  assert.equal(playbackProgress(bound(), undefined), null);
  assert.equal(playbackProgress(bound(), later({ pageTimeMs: 5_000 + 15_000 })), null, '页面时钟跨 15 秒但宿主只走 2 秒');
});

test('V11 40 秒墙钟上限是闭区间', () => {
  const long = bound({ duration: 100, time: 3 });
  const wall40 = bound({ duration: 100, time: 43, hostTimeMs: 50_000, pageTimeMs: 45_000 });
  near(playbackProgress(long, wall40), 40, 1e-9);
  assert.equal(playbackProgress(long, { ...wall40, hostTimeMs: 51_000, pageTimeMs: 46_000 }), null, '41 秒超限');
});

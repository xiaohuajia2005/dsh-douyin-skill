// 分享视频采样核验（迭代 17）。
// 决定"对方分享的视频确实在我这边播放过"——证据不全就不评论，绝不拿模糊证据去夸人。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedSharedVideoSample } from '../evidence/video-sample.mjs';

const frame = (time, videoId = 'v1') => ({ videoId, time });
const sample = (overrides = {}) => ({
  state: { video: { id: 'v1' } },
  observation: { videoId: 'v1', beforeTime: 3, afterTime: 6, beforePaused: false, paused: false },
  frames: [frame(3.2), frame(6.1)],
  ...overrides,
});

test('V1 完整采样通过：ID 一致、前后都在播、时间有推进、两帧落在窗内', () => {
  assert.equal(verifiedSharedVideoSample(sample(), 'v1'), true);
});

test('V2 视频 ID 三处必须同时匹配', () => {
  assert.equal(verifiedSharedVideoSample(sample({ state: { video: { id: 'v2' } } }), 'v1'), false, '当前视频不是它');
  assert.equal(verifiedSharedVideoSample(sample({ observation: { videoId: 'v2', beforeTime: 3, afterTime: 6, beforePaused: false, paused: false } }), 'v1'), false, '观测对象不是它');
  assert.equal(verifiedSharedVideoSample(sample(), 'v2'), false, '调用方问的不是它');
});

test('V3 暂停状态必须显式为 false，缺失不算', () => {
  const pausedNow = sample({ observation: { videoId: 'v1', beforeTime: 3, afterTime: 6, beforePaused: false, paused: true } });
  assert.equal(verifiedSharedVideoSample(pausedNow, 'v1'), false);
  const pausedBefore = sample({ observation: { videoId: 'v1', beforeTime: 3, afterTime: 6, beforePaused: true, paused: false } });
  assert.equal(verifiedSharedVideoSample(pausedBefore, 'v1'), false);
  const missing = sample({ observation: { videoId: 'v1', beforeTime: 3, afterTime: 6 } });
  assert.equal(verifiedSharedVideoSample(missing, 'v1'), false, 'undefined 不等于"没暂停"');
});

test('V4 播放头推进必须超过 0.1 秒，正好 0.1 秒不算', () => {
  const barely = sample({ observation: { videoId: 'v1', beforeTime: 3, afterTime: 3.1, beforePaused: false, paused: false } });
  assert.equal(verifiedSharedVideoSample(barely, 'v1'), false);
  // 帧间隔同样要求严格大于 0.1 秒，所以末帧取 3.2 而不是 3.15（3.15 正好卡在边界上）
  const enough = sample({ observation: { videoId: 'v1', beforeTime: 3, afterTime: 3.11, beforePaused: false, paused: false }, frames: [frame(3.05), frame(3.2)] });
  assert.equal(verifiedSharedVideoSample(enough, 'v1'), true);
  const backwards = sample({ observation: { videoId: 'v1', beforeTime: 6, afterTime: 3, beforePaused: false, paused: false } });
  assert.equal(verifiedSharedVideoSample(backwards, 'v1'), false, '时间倒退（seek 回退）不算推进');
});

test('V5 时间窗是前后各 0.25 秒的闭区间', () => {
  assert.equal(verifiedSharedVideoSample(sample({ frames: [frame(2.75), frame(6.25)] }), 'v1'), true, '正好在边界上通过');
  assert.equal(verifiedSharedVideoSample(sample({ frames: [frame(2.74), frame(6.1)] }), 'v1'), false, '首帧早于窗口 1 毫秒以上，只剩一帧有效');
  assert.equal(verifiedSharedVideoSample(sample({ frames: [frame(3.2), frame(6.26)] }), 'v1'), false, '末帧晚于窗口');
});

test('V6 至少需要两帧', () => {
  assert.equal(verifiedSharedVideoSample(sample({ frames: [frame(3.2)] }), 'v1'), false);
  assert.equal(verifiedSharedVideoSample(sample({ frames: [] }), 'v1'), false);
  assert.equal(verifiedSharedVideoSample(sample({ frames: undefined }), 'v1'), false, '没有 frames 字段不崩，直接不通过');
});

test('V7 末帧必须比首帧晚 0.1 秒以上（两帧同一时刻等于没动）', () => {
  assert.equal(verifiedSharedVideoSample(sample({ frames: [frame(3.2), frame(3.3)] }), 'v1'), false, '正好 0.1 秒不算');
  assert.equal(verifiedSharedVideoSample(sample({ frames: [frame(3.2), frame(3.31)] }), 'v1'), true);
});

test('V8 别的视频的帧混进来不算数', () => {
  assert.equal(verifiedSharedVideoSample(sample({ frames: [frame(3.2, 'v2'), frame(6.1, 'v2')] }), 'v1'), false);
  assert.equal(verifiedSharedVideoSample(sample({ frames: [frame(3.2), frame(6.1, 'v2')] }), 'v1'), false, '只剩一帧有效');
});

test('V9 时间值非有限的帧被丢弃', () => {
  assert.equal(verifiedSharedVideoSample(sample({ frames: [frame(3.2), frame(Number.NaN), frame(Number.POSITIVE_INFINITY)] }), 'v1'), false);
});

test('V10 结构缺失一律不通过（不抛错）', () => {
  assert.equal(verifiedSharedVideoSample(null, 'v1'), false);
  assert.equal(verifiedSharedVideoSample({}, 'v1'), false);
  assert.equal(verifiedSharedVideoSample({ state: { video: { id: 'v1' } } }, 'v1'), false);
  assert.equal(verifiedSharedVideoSample(sample({ state: null }), 'v1'), false);
});

test('V11 首帧是按原数组顺序取，不是按时间排序取', () => {
  // 记录顺序是「晚→早」，frames[0] 为 6.1，later 判定变成 3.2 > 6.1+0.1 → false
  assert.equal(verifiedSharedVideoSample(sample({ frames: [frame(6.1), frame(3.2)] }), 'v1'), false,
    '采集端按时间顺序写入是隐含前提，倒序写入会被判为无效而不是静默修正');
});

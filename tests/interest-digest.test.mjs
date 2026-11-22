// ============================================================
// 月度兴趣总结纯函数测试
//
// 这段代码决定"什么样的话会被写进人格卡"，而人格卡会影响之后每一次选题和开口。
// 所以两个方向都要拦住：把没依据的题材写成喜欢（自我强化），
// 或者把证据不足的作品说成"不感兴趣"（把沉默当否定）。
// 时间一律用固定时间戳 + Asia/Shanghai 判定，不依赖运行机器时区。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthKey, previousMonth, monthRange, isMonthKey,
  collectMonth, composeDigest, dueMonth, upsertDigest, digestLines,
  DIGEST_CARD_LIMIT, DIGEST_LINE_LIMIT, DIGEST_LINES_LIMIT, DIGEST_STORE_LIMIT,
} from '../service/interest-digest.mjs';

const BEIJING = 8 * 3_600_000;
const at = (iso) => Date.parse(iso);
// 2026-11 北京时间：2026-10-31T16:00Z 起，2026-11-30T16:00Z 止（闭开）。
const NOV_START = Date.UTC(2026, 10, 1) - BEIJING;
const NOV_END = Date.UTC(2026, 11, 1) - BEIJING;
const NOV_MID = at('2026-11-10T04:00:00Z');

function observation(videoId, observedAt, extra = {}) {
  return { id: `video:${videoId}`, videoId, url: `https://www.douyin.com/video/${videoId}`, title: '作品', observedAt, ...extra };
}
function viewing(videoId, when) {
  return { sampleId: `s-${videoId}-${when}`, evidenceId: `video:${videoId}`, videoId, at: when };
}
function action(videoId, type, when) {
  return { sampleId: `a-${videoId}-${type}-${when}`, evidenceId: `video:${videoId}`, videoId, action: type, at: when };
}
function summary(signal) {
  return new Map([[signal.videoId, { signal: signal.signal, watchedSeconds: 30, watchRatio: 0.8, actions: { stay: 1, skip: 0, share: 0 } }]]);
}
/** 把多条作品的判定拼成一张 summaries 表。 */
function summariesOf(entries) {
  return new Map(entries.map(([videoId, signal]) => [videoId, { signal, watchedSeconds: 20, watchRatio: 0.5, actions: { stay: 0, skip: 0, share: 0 } }]));
}

test('D1 monthKey 按北京时间折算，月末十六点后算次日', () => {
  assert.equal(monthKey(at('2026-11-10T04:00:00Z')), '2026-11');
  // 北京时间 11-01 00:00 整，UTC 还在 10 月。
  assert.equal(monthKey(NOV_START), '2026-11');
  assert.equal(monthKey(NOV_START - 1), '2026-10');
  // 北京时间 12-01 00:00，UTC 仍是 11-30。
  assert.equal(monthKey(NOV_END), '2026-12');
  assert.equal(monthKey(NOV_END - 1), '2026-11');
});

test('D2 previousMonth 跨年正确', () => {
  assert.equal(previousMonth('2026-11'), '2026-10');
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(previousMonth('2026-12'), '2026-11');
});

test('D3 monthRange 是北京时间的闭开区间', () => {
  const range = monthRange('2026-11');
  assert.equal(range.start, NOV_START);
  assert.equal(range.end, NOV_END);
  assert.equal(range.key, '2026-11');
});

test('D4 isMonthKey 只接受两位月份', () => {
  assert.equal(isMonthKey('2026-01'), true);
  assert.equal(isMonthKey('2026-12'), true);
  assert.equal(isMonthKey('2026-13'), false);
  assert.equal(isMonthKey('2026-1'), false);
  assert.equal(isMonthKey('2026-00'), false);
  assert.equal(isMonthKey('26-01'), false);
  assert.equal(isMonthKey(null), false);
});

test('D5 collectMonth 只统计当月，前后两个月都不算', () => {
  const stats = collectMonth({
    observations: [observation('1', at('2026-10-15T00:00:00Z')), observation('2', NOV_MID), observation('3', at('2026-12-15T00:00:00Z'))],
    viewings: [], actions: [], interests: [], summaries: summariesOf([['1', 'like'], ['2', 'like'], ['3', 'like']]),
  }, '2026-11');
  assert.equal(stats.videos, 1, '只有 11 月那条作品进入统计');
});

test('D6 collectMonth 分别数正向、负向与证据不足', () => {
  const stats = collectMonth({
    observations: [observation('1', NOV_MID), observation('2', NOV_MID), observation('3', NOV_MID)],
    viewings: [], actions: [], interests: [],
    summaries: summariesOf([['1', 'like'], ['2', 'dislike'], ['3', 'neutral']]),
  }, '2026-11');
  assert.deepEqual(stats.counts, { like: 1, dislike: 1, neutral: 1 });
  assert.equal(stats.videos, 3);
});

test('D7 collectMonth 统计互动次数与活跃天数', () => {
  const day2 = at('2026-11-12T04:00:00Z');
  const stats = collectMonth({
    observations: [observation('1', NOV_MID), observation('1', day2)],
    viewings: [viewing('1', NOV_MID), viewing('1', day2)],
    actions: [action('1', 'stay', NOV_MID), action('1', 'skip', day2), action('1', 'share', day2)],
    interests: [], summaries: summariesOf([['1', 'like']]),
  }, '2026-11');
  assert.deepEqual(stats.behavior, { stay: 1, skip: 1, share: 1 });
  assert.equal(stats.activeDays, 2, '两天各算一次，同一作品重复出现不重复计天');
  assert.equal(stats.samples, 2);
});

test('D8 collectMonth 把题材按当月作品归组，不做题材识别式判定', () => {
  const stats = collectMonth({
    observations: [observation('1', NOV_MID), observation('2', NOV_MID), observation('9', at('2026-10-10T00:00:00Z'))],
    viewings: [], actions: [],
    interests: [
      { topic: '美食探店', evidence: [{ videoId: '1' }, { videoId: '2' }, { videoId: '9' }] },
      { topic: '口播带货', evidence: [{ videoId: '2' }] },
      { topic: '只在十月的题材', evidence: [{ videoId: '9' }] },
    ],
    summaries: summariesOf([['1', 'like'], ['2', 'like'], ['9', 'dislike']]),
  }, '2026-11');
  assert.deepEqual(stats.topics.map(item => item.topic), ['美食探店', '口播带货'], '上月证据不进入本月归组');
  assert.deepEqual(stats.topics[0].counts, { like: 2, dislike: 0, neutral: 0 });
  assert.equal(stats.topics[0].videos, 2);
  assert.equal(stats.topics[0].signal, 'like');
});

test('D9 collectMonth 空输入不抛错，返回零值', () => {
  const stats = collectMonth({}, '2026-11');
  assert.equal(stats.videos, 0);
  assert.deepEqual(stats.counts, { like: 0, dislike: 0, neutral: 0 });
  assert.deepEqual(stats.topics, []);
});

test('D10 collectMonth 不改写传入数组', () => {
  const observations = Object.freeze([Object.freeze(observation('1', NOV_MID))]);
  const interests = Object.freeze([Object.freeze({ topic: '美食', evidence: Object.freeze([Object.freeze({ videoId: '1' })]) })]);
  const stats = collectMonth({ observations, viewings: Object.freeze([]), actions: Object.freeze([]), interests, summaries: summariesOf([['1', 'like']]) }, '2026-11');
  assert.equal(stats.videos, 1, '冻结输入下仍能算出结果');
  assert.equal(observations.length, 1);
});

test('D11 composeDigest 空月份不产生总结', () => {
  assert.deepEqual(composeDigest({ videos: 0, counts: { like: 0, dislike: 0, neutral: 0 }, behavior: { stay: 0, skip: 0, share: 0 }, activeDays: 0, topics: [] }), []);
  assert.deepEqual(composeDigest(null), []);
});

test('D12 composeDigest 写清三类计数，且不出现作品链接', () => {
  const stats = collectMonth({
    observations: [observation('1', NOV_MID), observation('2', NOV_MID), observation('3', NOV_MID)],
    viewings: [], actions: [action('1', 'share', NOV_MID)], interests: [],
    summaries: summariesOf([['1', 'like'], ['2', 'dislike'], ['3', 'neutral']]),
  }, '2026-11');
  const lines = composeDigest(stats);
  const text = lines.join('\n');
  assert.ok(lines.length >= 2, '夹具前提：至少有概述行');
  assert.match(text, /看过 3 个作品/);
  assert.match(text, /1 个有停留或分享依据/);
  assert.match(text, /1 个快速跳过/);
  assert.match(text, /1 个证据不足/);
  assert.match(text, /主动分享了 1 次/);
  assert.doesNotMatch(text, /https?:\/\//, '总结里不出现作品链接，人格卡不是观看清单');
  assert.match(text, /不代表用户喜欢/, '必须保留"这是代理自己的倾向"这句边界');
});

test('D13 composeDigest 把题材分成愿意看与不太想看，证据不足的不进任何一边', () => {
  const stats = {
    videos: 6, counts: { like: 3, dislike: 2, neutral: 1 }, behavior: { stay: 3, skip: 2, share: 0 }, activeDays: 4,
    topics: [
      { topic: '美食探店', videos: 3, counts: { like: 3, dislike: 0, neutral: 0 }, signal: 'like' },
      { topic: '口播带货', videos: 2, counts: { like: 0, dislike: 2, neutral: 0 }, signal: 'dislike' },
      { topic: '说不清的题材', videos: 1, counts: { like: 0, dislike: 0, neutral: 1 }, signal: 'neutral' },
    ],
  };
  const text = composeDigest(stats).join('\n');
  assert.match(text, /更愿意看：美食探店（3 个作品里 3 个看完）/);
  assert.match(text, /不太想看：口播带货（2 个作品里 2 个快速跳过）/);
  assert.doesNotMatch(text, /说不清的题材/, '待观察题材不进结论，沉默不算否定');
  assert.doesNotMatch(text, /和上个月比/, '没有上月数据时不硬造环比');
});

test('D13b 有上月数据时，新出现但待观察的题材不写成新的兴趣', () => {
  const previous = { topics: [{ topic: '老题材', videos: 1, counts: { like: 1, dislike: 0, neutral: 0 }, signal: 'like' }] };
  const stats = {
    videos: 3, counts: { like: 1, dislike: 0, neutral: 2 }, behavior: { stay: 0, skip: 0, share: 0 }, activeDays: 1,
    topics: [
      { topic: '老题材', videos: 1, counts: { like: 1, dislike: 0, neutral: 0 }, signal: 'like' },
      { topic: '刚碰到还没判的题材', videos: 1, counts: { like: 0, dislike: 0, neutral: 1 }, signal: 'neutral' },
    ],
  };
  const text = composeDigest(stats, previous).join('\n');
  assert.doesNotMatch(text, /刚碰到还没判的题材/, '证据不足的新题材不能记成兴趣');
});

test('D20 一个作品被跳过不足以判定整个题材不感兴趣', () => {
  const ids = ['1', '2', '3', '4', '5', '6', '7'];
  const stats = collectMonth({
    observations: ids.map(id => observation(id, NOV_MID)),
    viewings: [], actions: [],
    interests: [{ topic: '老虎/猛兽', evidence: ids.map(videoId => ({ videoId })) }],
    summaries: summariesOf([['1', 'dislike'], ['2', 'neutral'], ['3', 'neutral'], ['4', 'neutral'], ['5', 'neutral'], ['6', 'neutral'], ['7', 'neutral']]),
  }, '2026-11');
  assert.equal(stats.topics[0].signal, 'neutral', '七条里只有一条负向依据，不足以成结论');
  const text = composeDigest(stats).join('\n');
  assert.doesNotMatch(text, /不太想看/, '不能因为一个作品就把题材写成人格卡里的回避项');
  assert.match(text, /1 个快速跳过/, '作品级事实仍如实写在概述里');
});

test('D21 正负接近的题材不下结论', () => {
  const stats = collectMonth({
    observations: [observation('1', NOV_MID), observation('2', NOV_MID)],
    viewings: [], actions: [],
    interests: [{ topic: '有争议的题材', evidence: [{ videoId: '1' }, { videoId: '2' }] }],
    summaries: summariesOf([['1', 'like'], ['2', 'dislike']]),
  }, '2026-11');
  assert.equal(stats.topics[0].signal, 'neutral', '一比一不算喜欢也不算不喜欢');
});

test('D22 达到两条同向依据才给结论', () => {
  const stats = collectMonth({
    observations: [observation('1', NOV_MID), observation('2', NOV_MID)],
    viewings: [], actions: [],
    interests: [{ topic: '够格的题材', evidence: [{ videoId: '1' }, { videoId: '2' }] }],
    summaries: summariesOf([['1', 'like'], ['2', 'like']]),
  }, '2026-11');
  assert.equal(stats.topics[0].signal, 'like');
  assert.match(composeDigest(stats).join('\n'), /更愿意看：够格的题材（2 个作品里 2 个看完）/);
});

test('D23 依据退回不足时不写"变成待观察"', () => {
  const previous = { topics: [{ topic: '老题材', videos: 3, counts: { like: 3, dislike: 0, neutral: 0 }, signal: 'like' }] };
  const stats = {
    videos: 6, counts: { like: 1, dislike: 0, neutral: 5 }, behavior: { stay: 1, skip: 0, share: 0 }, activeDays: 2,
    topics: [{ topic: '老题材', videos: 6, counts: { like: 1, dislike: 0, neutral: 5 }, signal: 'neutral' }],
  };
  const text = composeDigest(stats, previous).join('\n');
  assert.doesNotMatch(text, /老题材/, '这个月依据不足，不该写成兴趣倒退');
});

test('D14 composeDigest 与上月比较只写信号发生变化的题材', () => {
  const previous = { topics: [
    { topic: '美食探店', videos: 2, counts: { like: 0, dislike: 0, neutral: 2 }, signal: 'neutral' },
    { topic: '城市夜景', videos: 2, counts: { like: 2, dislike: 0, neutral: 0 }, signal: 'like' },
  ] };
  const stats = {
    videos: 4, counts: { like: 3, dislike: 0, neutral: 1 }, behavior: { stay: 0, skip: 0, share: 0 }, activeDays: 2,
    topics: [
      { topic: '美食探店', videos: 2, counts: { like: 2, dislike: 0, neutral: 0 }, signal: 'like' },
      { topic: '城市夜景', videos: 2, counts: { like: 2, dislike: 0, neutral: 0 }, signal: 'like' },
    ],
  };
  const text = composeDigest(stats, previous).join('\n');
  assert.match(text, /美食探店从待观察变成感兴趣/);
  assert.doesNotMatch(text, /城市夜景从/, '没有变化的题材不重复写一次');
});

test('D15 composeDigest 限制行数与单行长度', () => {
  const topics = Array.from({ length: 30 }, (_, index) => ({ topic: `题材${index}`, videos: 1, counts: { like: 1, dislike: 0, neutral: 0 }, signal: 'like' }));
  const lines = composeDigest({ videos: 30, counts: { like: 30, dislike: 0, neutral: 0 }, behavior: { stay: 0, skip: 0, share: 0 }, activeDays: 5, topics });
  assert.ok(lines.length <= DIGEST_LINES_LIMIT, `行数超过上限：${lines.length}`);
  assert.ok(lines.every(line => line.length <= DIGEST_LINE_LIMIT), '有超长行会撑破人格卡');

  const longTopic = { topic: '很'.repeat(400), videos: 1, counts: { like: 1, dislike: 0, neutral: 0 }, signal: 'like' };
  const truncated = composeDigest({ videos: 1, counts: { like: 1, dislike: 0, neutral: 0 }, behavior: { stay: 0, skip: 0, share: 0 }, activeDays: 1, topics: [longTopic] });
  assert.ok(truncated.every(line => line.length <= DIGEST_LINE_LIMIT));
});

test('D16 dueMonth 只补上一个自然月，已生成过就返回 null', () => {
  assert.equal(dueMonth([], NOV_MID), '2026-10');
  assert.equal(dueMonth([{ key: '2026-10', lines: ['x'] }], NOV_MID), null);
  assert.equal(dueMonth([{ key: '2026-09', lines: ['x'] }], NOV_MID), '2026-10', '上上月不能代替上月');
});

test('D17 dueMonth 在年初指向去年十二月', () => {
  assert.equal(dueMonth([], at('2026-01-15T04:00:00Z')), '2025-12');
});

test('D18 upsertDigest 按月份去重、排序并只留最近十二个月', () => {
  let digests = [];
  for (let index = 1; index <= 15; index++) {
    const month = String((index % 12) + 1).padStart(2, '0');
    const year = 2025 + Math.floor(index / 12);
    digests = upsertDigest(digests, { key: `${year}-${month}`, generatedAt: index, lines: ['x'] });
  }
  assert.equal(digests.length, DIGEST_STORE_LIMIT);
  const keys = digests.map(item => item.key);
  assert.deepEqual([...keys].sort(), keys, '按月份升序');
  assert.equal(new Set(keys).size, keys.length, '同一个月不重复');

  const replaced = upsertDigest([{ key: '2026-10', lines: ['旧'], generatedAt: 1 }], { key: '2026-10', lines: ['新'], generatedAt: 2 });
  assert.equal(replaced.length, 1);
  assert.deepEqual(replaced[0].lines, ['新']);
});

test('D19 digestLines 只渲染最近三个月，新的在上，坏条目不渲染', () => {
  const digests = ['2026-08', '2026-09', '2026-10', '2026-11'].map(key => ({ key, lines: [`${key}总结`], generatedAt: 1 }));
  const lines = digestLines([...digests, { key: '坏月份', lines: ['x'] }, { key: '2026-07', lines: [] }, null]);
  assert.ok(lines.includes('### 2026-11'));
  assert.ok(lines.includes('### 2026-09'));
  assert.ok(!lines.includes('### 2026-08'), `只保留最近 ${DIGEST_CARD_LIMIT} 个月`);
  assert.ok(!lines.includes('### 坏月份'));
  assert.ok(lines.indexOf('### 2026-11') < lines.indexOf('### 2026-10'), '新月份在前');
  assert.ok(lines.includes('- 2026-11总结'));
});

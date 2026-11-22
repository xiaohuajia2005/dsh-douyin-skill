import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AutonomousWatch, WATCH_LIMITS, isRecoverable } from '../autonomous-watch.mjs';

// 这组的主题只有一个：一场自主观看只有「真需要人」才该停。
// 换片没生效、画面没稳定、直播刷到、评论被拒，都只作废当前这一条，
// 继续往下看，直到每日请求轮次自然用尽。

const source = readFileSync(new URL('../autonomous-watch.mjs', import.meta.url), 'utf8');

const videoState = Object.freeze({ pageKind: 'video', livePreview: null, video: { id: '7400000000000000001', readyState: 4, paused: false } });
const liveState = Object.freeze({ pageKind: 'live-preview', livePreview: { recognized: true, source: 'active-feed-live-card', scope: 'recommend-feed', roomId: null }, video: null });

const watcher = (overrides = {}) => ({
  skipStreak: 0,
  now: () => Date.parse('2026-11-22T10:00:00+08:00'),
  abort: { signal: { aborted: false } },
  events: [],
  onEvent(event) { this.events.push(event); },
  save() {},
  async delayImpl() {},
  assertAllowed() {},
  // 直接用生产实现，不复制一份可能漂移的替身。
  settlePage: AutonomousWatch.prototype.settlePage,
  ...overrides,
});

test('R1 可跳过与致命是两类错误，运行故障不会被当成可跳过', () => {
  const skip = Object.assign(new Error('换片没生效'), { recoverable: true, code: 'switch-not-confirmed' });
  assert.equal(isRecoverable(skip), true);
  // 轮次上限、运行锁这类必须一路抛到最外层，否则会绕开每日上限继续烧请求。
  assert.equal(isRecoverable(Object.assign(new Error('今天的观看模型请求次数已用完。'), { watchStatus: 'limited' })), false);
  assert.equal(isRecoverable(Object.assign(new Error('页面需要手动处理'), { watchStatus: 'needs_user' })), false);
  assert.equal(isRecoverable(new Error('普通异常')), false);
});

test('R2 直播可以连续跳过远超原来的三张，直到出现普通作品', async () => {
  const calls = [];
  const subject = watcher({
    async execute(name) {
      calls.push(name);
      return calls.length >= 12 ? { changed: true, state: videoState } : { changed: true, state: liveState };
    },
  });
  const result = await AutonomousWatch.prototype.skipLivePreviews.call(subject, liveState);
  assert.equal(result.state.video.id, '7400000000000000001');
  assert.equal(calls.length, 12, '应该一路跳过去，而不是第三张就停');
  assert.ok(calls.every(name => name === 'douyin_next'), '跳直播只换片，不点直播间入口');
  assert.equal(subject.events.filter(event => event.type === 'watch.live_skip').length, 12);
});

test('R3 推荐流全是直播时重开推荐页继续，而不是停止观看', async () => {
  let nexts = 0, opens = 0;
  const subject = watcher({
    async execute(name) {
      if (name === 'douyin_open') { opens++; return { changed: true, state: videoState }; }
      nexts++;
      return { changed: true, state: liveState };
    },
  });
  const result = await AutonomousWatch.prototype.skipLivePreviews.call(subject, liveState);
  assert.equal(result.state.video.id, '7400000000000000001');
  assert.equal(nexts, WATCH_LIMITS.maxLiveSkips, '先跳满一轮直播');
  assert.equal(opens, 1, '跳满后重开推荐流，而不是停播');
});

test('R4 重开推荐流也回不来直播时才交给主循环跳过，且仍不是致命错误', async () => {
  let opens = 0;
  const subject = watcher({
    async execute(name) {
      if (name === 'douyin_open') { opens++; return { changed: true, state: liveState }; }
      return { changed: true, state: liveState };
    },
  });
  let thrown = null;
  try { await AutonomousWatch.prototype.skipLivePreviews.call(subject, liveState); } catch (error) { thrown = error; }
  assert.ok(thrown, '这种情况必须有界地退出，不能无限循环');
  assert.equal(thrown.recoverable, true, '有界退出的错误仍应可跳过，由主循环决定重开或继续');
  assert.equal(opens, 2, '只允许有界次数的重开');
});

test('R5 跳过之后会换下一条继续，并记录可查原因', async () => {
  const names = [];
  const subject = watcher({
    async execute(name) { names.push(name); return { changed: true, state: videoState }; },
  });
  const error = Object.assign(new Error('未确认切换到另一条就绪作品。'), { recoverable: true, code: 'switch-not-confirmed' });
  const result = await AutonomousWatch.prototype.recoverAfterSkip.call(subject, { state: videoState }, error);
  assert.equal(result.state.video.id, '7400000000000000001');
  assert.equal(subject.skipStreak, 1);
  assert.deepEqual(names, ['douyin_status'], '先回读页面，再决定换片还是重开');
  const skipped = subject.events.find(event => event.type === 'watch.skipped');
  assert.equal(skipped.code, 'switch-not-confirmed');
  assert.match(skipped.message, /未确认切换/);
});

test('R6 连续跳过每满一档就重开推荐流，打破僵局', async () => {
  const names = [];
  const subject = watcher({
    async execute(name) { names.push(name); return { changed: true, state: videoState }; },
  });
  const error = Object.assign(new Error('画面一直没稳定'), { recoverable: true, code: 'state-unstable' });
  for (let index = 0; index < WATCH_LIMITS.reopenAfterSkips; index++) {
    await AutonomousWatch.prototype.recoverAfterSkip.call(subject, { state: videoState }, error);
  }
  assert.equal(subject.skipStreak, WATCH_LIMITS.reopenAfterSkips);
  assert.ok(names.includes('douyin_open'), '累计到阈值应重开推荐流');
});

test('R7 只有连续卡死到上限才停，且提示保留今日用量', async () => {
  const subject = watcher();
  subject.skipStreak = WATCH_LIMITS.maxRecoverableSkips;
  const error = Object.assign(new Error('卡住了'), { recoverable: true, code: 'state-unstable' });
  await assert.rejects(AutonomousWatch.prototype.recoverAfterSkip.call(subject, { state: videoState }, error), /连续多次无法处理/);
});

test('R8 主循环只吞可跳过错误，轮次上限和运行锁照旧上抛', () => {
  assert.match(source, /if \(!isRecoverable\(error\) \|\| this\.abort\?\.signal\.aborted\) throw error;/, '主循环必须先判别再吞');
  assert.match(source, /current = await this\.recoverAfterSkip\(current, error\);/, '可跳过的错误交给统一恢复逻辑');
  // 剩下的致命终止点只应该是：运行锁、时限与轮次、页面需要人工、连续卡死兜底。
  const fatal = [...source.matchAll(/throw failure\(/g)].length;
  assert.equal(fatal, 5, `致命终止点应只剩 5 处，实际 ${fatal} 处`);
  assert.match(source, /每天|今天的观看模型请求次数已用完|time\.reason/, '轮次上限必须仍是终止条件');
});

test('R9 评论的每一种失败都只跳过这一条评论', () => {
  for (const code of ['video-changed', 'suspended', 'generate-failed', 'delivery-rejected', 'delivery-uncertain', 'not-confirmed']) {
    assert.ok(source.includes(`this.skipComment('${code}'`), `评论失败 ${code} 应走跳过而不是停止`);
  }
  assert.match(source, /this\.commentSuspended = true;/, '连续不合规只暂停评论');
});

test('R10 搜索命中后按作品链接直达，不点搜索结果卡片', () => {
  assert.doesNotMatch(source, /douyin_open_video', \{ index: first\.index \}/, '不要再按 index 点卡片，那可能是直播入口');
  assert.equal([...source.matchAll(/douyin_open_video', \{ url: `https:\/\/www\.douyin\.com\/video\/\$\{first\.id\}` \}/g)].length, 2, '启动与搜索两处都要用作品链接');
});

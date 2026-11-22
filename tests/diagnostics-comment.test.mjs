// ============================================================
// F2：评论控件可识别性接入自检
//
// 两层测试：
//   1. commentControlsReport —— 纯映射，覆盖"认不得 = 疑似改版"的每种分支；
//   2. runDiagnostics 集成 —— 这一项真的出现在报告里、失败时不会静默消失，
//      并且没有注入时不会凭空多出一项（向后兼容）。
// 外加一条源码守卫：只读入口里绝不能出现输入/点击/按键原语。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commentControlsReport, runDiagnostics } from '../diagnostics.mjs';

const ok = { targetOpen: true, videoId: '7692267626457763108', editorCount: 1, inputReady: true, submitFound: true, nativeIcon: true, enabled: true };

test('D1 正常识别 → pass，且明确说明"未输入文字、未点击发布"', () => {
  const value = commentControlsReport(ok);
  assert.equal(value.code, 'COMMENT_CONTROLS_OK');
  assert.equal(value.warning, undefined);
  assert.match(value.message, /未输入文字、未点击发布/);
  assert.equal(value.evidence.editorCount, 1);
  assert.equal(value.resolution.kind, 'none');
});

test('D2 有输入框但认不得发布控件 → warning + 明确写"疑似抖音改版"', () => {
  const value = commentControlsReport({ ...ok, submitFound: false, enabled: false, nativeIcon: false });
  assert.equal(value.code, 'COMMENT_SUBMIT_UNRECOGNIZED');
  assert.equal(value.warning, true);
  assert.match(value.message, /疑似抖音改版/);
  assert.equal(value.resolution.kind, 'user');
  assert.ok(value.resolution.steps.length > 0);
});

test('D3 连输入框都没有 → warning + 提示先展开评论面板', () => {
  const value = commentControlsReport({ targetOpen: true, videoId: '1', editorCount: 0, submitFound: false });
  assert.equal(value.code, 'COMMENT_EDITOR_UNRECOGNIZED');
  assert.equal(value.warning, true);
  assert.match(value.message, /疑似抖音改版|评论面板/);
  assert.equal(value.evidence.editorCount, 0);
});

test('D4 多个发布控件 → fail（会让自动评论点错，必须先停）', () => {
  const value = commentControlsReport({ ...ok, submitFound: false, ambiguous: true });
  assert.equal(value.code, 'COMMENT_SUBMIT_AMBIGUOUS');
  assert.equal(value.status, 'fail');
  assert.match(value.message, /疑似抖音改版/);
});

test('D5 控件已识别但不可用 → warning，且不误报改版', () => {
  const value = commentControlsReport({ ...ok, enabled: false });
  assert.equal(value.code, 'COMMENT_SUBMIT_DISABLED');
  assert.equal(value.warning, true);
  assert.doesNotMatch(value.message, /改版/);
});

test('D6 没有作品页 / 浏览器未运行 → warning，且自检不会自己去换片', () => {
  const none = commentControlsReport({ targetOpen: false, reasonCode: 'not-video-page' });
  assert.equal(none.code, 'COMMENT_TARGET_NOT_OPEN');
  assert.equal(none.warning, true);
  assert.match(none.message, /未自动导航或播放视频/);
  const closed = commentControlsReport({ targetOpen: false, reasonCode: 'browser-not-running' });
  assert.equal(closed.code, 'COMMENT_BROWSER_NOT_RUNNING');
  assert.match(closed.message, /未自动启动/);
});

test('D7 空输入（未注入实现却误调用）不抛错，按"没有作品页"处理', () => {
  for (const value of [undefined, null, {}, { targetOpen: false }]) {
    const report = commentControlsReport(value);
    assert.equal(report.warning, true);
    assert.ok(report.code.startsWith('COMMENT_'));
  }
});

const baseOptions = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-comment-'));
  return {
    dir,
    options: {
      source: 'api',
      videoLimits: { state: () => ({ allowed: true }) },
      paths: { stateDir: dir, memoryDir: dir },
      probeNode: async () => ({ stdout: '22.13.0' }),
      probeBrowserInstallation: async () => ({ installed: true, version: '1.2.3.4' }),
    },
  };
};

test('D8 自检报告里真的会出现这一项，并且计入 summary', async t => {
  const { dir, options } = baseOptions();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const report = await runDiagnostics({ ...options, commentComposer: async () => { calls++; return ok; } });
  assert.equal(calls, 1, '注入的实现必须被调用恰好一次');
  const item = report.checks.find(check => check.id === 'comment_controls');
  assert.ok(item, '自检报告缺少 comment_controls 项');
  assert.equal(item.label, '评论控件可识别性');
  assert.equal(item.code, 'COMMENT_CONTROLS_OK');
  assert.equal(item.status, 'pass');
  assert.equal(report.protocol, 'diagnostics-v2');
  assert.match(report.note, /评论控件/);
});

test('D9 未注入实现时不出现这一项（后端与旧入口不受影响）', async t => {
  const { dir, options } = baseOptions();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = await runDiagnostics(options);
  assert.equal(report.checks.some(check => check.id === 'comment_controls'), false);
});

test('D10 实现抛错时变成可见的失败项，而不是静默通过', async t => {
  const { dir, options } = baseOptions();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = await runDiagnostics({ ...options, commentComposer: async () => { throw new Error('boom'); } });
  const item = report.checks.find(check => check.id === 'comment_controls');
  assert.equal(item.status, 'fail');
  assert.equal(item.code, 'COMMENT_CONTROLS_UNAVAILABLE');
  assert.equal(report.ok, false);
});

test('D11 只读入口的源码里没有任何输入/点击/按键原语', () => {
  const source = fs.readFileSync(new URL('../comment-browser.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export async function inspectCommentComposerForDiagnostics');
  assert.ok(start > 0, '找不到只读自检入口');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  for (const forbidden of ['.click(', 'pressSequentially', 'keyboard', '.fill(', '.type(', '.press(', 'mouse.', 'insertText']) {
    assert.equal(body.includes(forbidden), false, `只读自检入口里出现了 ${forbidden}`);
  }
  assert.ok(body.includes('launch: false, create: false'), '必须显式禁止自动启动浏览器与新建标签');
  assert.ok(body.includes('inspectCommentComposer(page'), '必须复用既有的只读检查函数');
});

test('D12 页面不是作品页 → 直接返回，绝不为了自检去导航', async () => {
  const { inspectCommentComposerForDiagnostics } = await import('../comment-browser.mjs');
  const calls = [];
  const result = await inspectCommentComposerForDiagnostics({ withPage: async (callback, options) => { calls.push(options); return callback({ url: () => 'https://www.douyin.com/' }); } });
  assert.deepEqual(result, { targetOpen: false, reasonCode: 'not-video-page' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].launch, false, '自检不得自动启动浏览器');
  assert.equal(calls[0].create, false, '自检不得新建标签');
});

test('D13 作品页地址解析：路径 / modal_id / aweme_id 都能认，非数字一律不认', async () => {
  const { inspectCommentComposerForDiagnostics } = await import('../comment-browser.mjs');
  const run = url => inspectCommentComposerForDiagnostics({ withPage: async callback => callback({ url: () => url, locator: () => ({ filter: () => ({ count: async () => 0 }) }) }) });
  const path_ = await run('https://www.douyin.com/video/7692267626457763108');
  assert.equal(path_.targetOpen, true);
  assert.equal(path_.videoId, '7692267626457763108');
  const modal = await run('https://www.douyin.com/?modal_id=7692267626457763108');
  assert.equal(modal.videoId, '7692267626457763108');
  const bad = await run('https://www.douyin.com/?modal_id=abc');
  assert.equal(bad.targetOpen, false);
});

test('D14 浏览器没开 / 控制器不着调 → 转成 reasonCode，不抛给自检', async () => {
  const { inspectCommentComposerForDiagnostics } = await import('../comment-browser.mjs');
  assert.deepEqual(await inspectCommentComposerForDiagnostics(undefined), { targetOpen: false, reasonCode: 'browser-unavailable' });
  const closed = await inspectCommentComposerForDiagnostics({ withPage: async () => { throw Object.assign(new Error('专用浏览器未运行，未自动打开。'), { code: 'BROWSER_NOT_RUNNING' }); } });
  assert.deepEqual(closed, { targetOpen: false, reasonCode: 'browser-not-running' });
  const broken = await inspectCommentComposerForDiagnostics({ withPage: async () => { throw new Error('x'); } });
  assert.deepEqual(broken, { targetOpen: false, reasonCode: 'browser-unavailable' });
});

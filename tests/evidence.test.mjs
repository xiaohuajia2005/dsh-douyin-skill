// ============================================================
// 特征测试（Characterization Tests）—— 证据对账核心
//
// 目的不是验证"逻辑正确"，而是**锁住当前已验证的行为**：
// 重构前后各跑一遍 `python test_cases.py`，输出必须一致。
// 任何一条断言失败 = 重构改变了行为边界，必须停下来排查。
//
// 覆盖三类核心场景：
//   A. 防误判 —— 消息指纹对展示时间 / 异步封面加载保持稳定
//   B. 对账   —— 水位核对 compareMessageWatermark 的接受/拒绝边界
//   C. 重复   —— 同窗口重复身份抛异常、跨窗口重复不获回复资格
//   D. 准入   —— isReplyableMessage 的可回复边界
//
// 运行：python test_cases.py   （底层执行 node --test tests/）
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  messageFingerprint,
  isReplyableMessage,
  messageWatermark,
  compareMessageWatermark,
} from '../chat-message.mjs';
import { MessageIdentityTracker } from '../message-tracker.mjs';

// ---- 测试数据构造 ------------------------------------------
const baseRow = (overrides = {}) => ({
  id: 'dom-1',
  sender: 'incoming',
  direction: 'incoming',
  kind: 'text',
  text: '你好呀',
  timestamp: '2026-11-21T10:00:00+08:00',
  latestEndVerified: true,
  ...overrides,
});

const sharedWorkMedia = (overrides = {}) => ({
  type: 'shared-work',
  videoId: 'video-001',
  url: 'https://example.com/v/001',
  isPhotoGallery: false,
  // 以下两个字段是异步加载的，指纹必须忽略它们
  imageMd5: 'md5-initial',
  resources: [{ resourceRef: 'r1', label: '封面' }],
  ...overrides,
});

const imageMedia = (overrides = {}) => ({
  type: 'image',
  imageMd5: 'image-md5-a',
  label: '表情包',
  ...overrides,
});

// ============================================================
// A. 防误判：指纹稳定性（这是"会话被误判暂停"的第一道防线）
// ============================================================
test('A1 内容相同 → 指纹相同', () => {
  assert.equal(messageFingerprint(baseRow()), messageFingerprint(baseRow()));
});

test('A2 展示时间变化 → 指纹不变（时间不参与身份）', () => {
  const a = baseRow({ timestamp: '2026-11-21T10:00:00+08:00' });
  const b = baseRow({ timestamp: '2026-11-21T23:59:59+08:00' });
  assert.equal(messageFingerprint(a), messageFingerprint(b));
});

test('A3 分享卡片封面异步加载完成（imageMd5/resources 变化）→ 指纹不变', () => {
  // 背景：2026-11-12 的修复——封面 imageMd5 与 resources 是异步加载的，
  // 若参与指纹，正常加载会被"二次核对"误判为"消息被改动"，进而触发会话暂停。
  const before = baseRow({ media: sharedWorkMedia() });
  const after = baseRow({
    media: sharedWorkMedia({ imageMd5: 'md5-loaded-later', resources: [{ resourceRef: 'r2', label: '封面已加载' }] }),
  });
  assert.equal(messageFingerprint(before), messageFingerprint(after));
});

test('A4 分享卡片身份字段变化（videoId）→ 指纹必须变化', () => {
  const a = baseRow({ media: sharedWorkMedia() });
  const b = baseRow({ media: sharedWorkMedia({ videoId: 'video-002' }) });
  assert.notEqual(messageFingerprint(a), messageFingerprint(b));
});

test('A5 普通图片的 imageMd5 变化 → 指纹必须变化（非卡片不豁免）', () => {
  const a = baseRow({ media: imageMedia() });
  const b = baseRow({ media: imageMedia({ imageMd5: 'image-md5-b' }) });
  assert.notEqual(messageFingerprint(a), messageFingerprint(b));
});

test('A6 文本变化 → 指纹必须变化', () => {
  assert.notEqual(
    messageFingerprint(baseRow({ text: '你好' })),
    messageFingerprint(baseRow({ text: '你好呀' })),
  );
});

// ============================================================
// B. 对账：水位核对的接受 / 拒绝边界
// ============================================================
const mkWindow = () => [baseRow({ id: 'dom-1', nativeId: 'n1', text: '你好呀' }),
  baseRow({ id: 'dom-2', nativeId: 'n2', text: '今天也要加油' })];
const evidenceOk = { chronology: 'oldest-first', latestEndVerified: true };

test('B1 完全相同的水位 → matches=true', () => {
  const window = mkWindow();
  const expected = messageWatermark(window, evidenceOk);
  const result = compareMessageWatermark(expected, window, evidenceOk);
  assert.equal(result.matches, true);
});

test('B2 已核实消息内容被改动 → matches=false 且指纹比对失败', () => {
  const window = mkWindow();
  const expected = messageWatermark(window, evidenceOk);
  const tampered = [window[0], baseRow({ id: 'dom-2', nativeId: 'n2', text: '内容被改了' })];
  const result = compareMessageWatermark(expected, tampered, evidenceOk);
  assert.equal(result.matches, false);
  assert.equal(result.diagnostic.latestAnchorFingerprintMatches, false);
  assert.equal(result.diagnostic.allOverlapContentMatches, false);
});

test('B3 最新锚点丢失（尾部消息消失）→ matches=false', () => {
  const window = mkWindow();
  const expected = messageWatermark(window, evidenceOk);
  const shrunk = [window[0]];
  const result = compareMessageWatermark(expected, shrunk, evidenceOk);
  assert.equal(result.matches, false);
  assert.equal(result.diagnostic.latestAnchorPresent, false);
});

test('B4 锚点之后出现未经核实的新消息 → matches=false（尾部新增必须先过身份核对）', () => {
  const window = mkWindow();
  const expected = messageWatermark(window, evidenceOk);
  const extended = [...window, baseRow({ id: 'dom-3', nativeId: 'n3', text: '新消息' })];
  const result = compareMessageWatermark(expected, extended, evidenceOk);
  assert.equal(result.matches, false);
  assert.equal(result.diagnostic.additionalCount, 1);
  assert.equal(result.diagnostic.latestAnchorAtEnd, false);
});

test('B5 前缀补载历史（old-history，不可回复）→ matches=true（虚拟列表容忍）', () => {
  const window = mkWindow();
  const expected = messageWatermark(window, evidenceOk);
  const withPrefix = [
    baseRow({ id: 'dom-0', nativeId: 'n0', text: '更早的历史', arrivalClassification: 'old-history', eligibleForReply: false }),
    ...window,
  ];
  const result = compareMessageWatermark(expected, withPrefix, evidenceOk);
  assert.equal(result.matches, true);
  assert.equal(result.diagnostic.additionalPrefixCount, 1);
});

test('B6 方向不明的消息 → matches=false（对账拒绝无法核实方向的内容）', () => {
  const window = mkWindow();
  const expected = messageWatermark(window, evidenceOk);
  const unknown = [window[0], baseRow({ id: 'dom-2', nativeId: 'n2', sender: undefined, direction: undefined })];
  const result = compareMessageWatermark(expected, unknown, evidenceOk);
  assert.equal(result.matches, false);
  assert.equal(result.diagnostic.unknownDirectionCount > 0, true);
});

// ============================================================
// C. 重复消息与身份核对（误判水位 = 自动回复事故的根源）
// ============================================================
const relRow = (nativeId, order, text) => ({
  id: `dom-${order}`, nativeId, order, orderMode: 'relative',
  sender: 'incoming', direction: 'incoming', kind: 'text', text,
  latestEndVerified: true,
});

test('C1 同窗口出现重复 nativeId → 必须抛异常（宁可不回，不可误回）', () => {
  const tracker = new MessageIdentityTracker();
  const window = [relRow('n1', 0, '第一条'), relRow('n1', 1, '第二条')]; // 重复的 nativeId
  assert.throws(() => tracker.identify('c-dup', window), /身份重复/);
});

test('C2 相对窗口与绝对窗口混排 → 必须抛异常', () => {
  const tracker = new MessageIdentityTracker();
  const mixed = [relRow('n1', 0, '相对'), baseRow({ id: 'dom-1', nativeId: 'n2', order: 1, orderMode: 'absolute' })];
  assert.throws(() => tracker.identify('c-mixed', mixed), /顺序模式不一致/);
});

test('C3 首次识别 → 全部 baseline，无回复资格', () => {
  const tracker = new MessageIdentityTracker();
  const window = [relRow('n1', 0, '你好'), relRow('n2', 1, '在忙什么')];
  const identified = tracker.identify('c1', window);
  assert.deepEqual(identified.map(row => row.arrivalClassification), ['baseline', 'baseline']);
  assert.ok(identified.every(row => row.eligibleForReply === false));
});

test('C4 同一窗口重复识别 → known-old-window 且 ID 稳定（身份不漂移）', () => {
  const tracker = new MessageIdentityTracker();
  const window = [relRow('n1', 0, '你好'), relRow('n2', 1, '在忙什么')];
  const first = tracker.identify('c1', window);
  const second = tracker.identify('c1', window);
  assert.deepEqual(second.map(row => row.arrivalClassification), ['known-old-window', 'known-old-window']);
  assert.deepEqual(second.map(row => row.id), first.map(row => row.id));
  assert.ok(second.every(row => row.eligibleForReply === false));
});

test('C5 已核实水位之后新增带 nativeId 的消息 → new-tail，获得回复资格', () => {
  const tracker = new MessageIdentityTracker();
  const w1 = [relRow('n1', 0, '你好'), relRow('n2', 1, '在忙什么')];
  tracker.identify('c1', w1); // 建立基线
  const w2 = [...w1, relRow('n3', 2, '今天也要加油鸭')];
  const identified = tracker.identify('c1', w2);
  assert.equal(identified[2].arrivalClassification, 'new-tail');
  assert.equal(identified[2].eligibleForReply, true);
  assert.deepEqual(identified.slice(0, 2).map(row => row.arrivalClassification), ['known-old-window', 'known-old-window']);
});

test('C6 新增消息缺 nativeId 与可靠序号 → ambiguous-new，无回复资格（防误判优先）', () => {
  const tracker = new MessageIdentityTracker();
  const w1 = [relRow('n1', 0, '你好'), relRow('n2', 1, '在忙什么')];
  tracker.identify('c2', w1);
  const unreliable = {
    id: 'dom-2', sender: 'incoming', direction: 'incoming', kind: 'text',
    text: '没有身份凭据的消息', latestEndVerified: true,
    orderMode: 'relative', // 模式标注一致，但缺 nativeId 与可靠序号
  };
  const identified = tracker.identify('c2', [...w1, unreliable]);
  assert.equal(identified[2].arrivalClassification, 'ambiguous-new');
  assert.equal(identified[2].eligibleForReply, false);
});

// ============================================================
// D. 准入边界：isReplyableMessage
// ============================================================
test('D1 普通文本 → 可回复', () => {
  assert.equal(isReplyableMessage(baseRow({ kind: 'text', text: ' 嗨 ' })), true);
});

test('D2 已撤回消息 → 不可回复（撤回不触发回复）', () => {
  assert.equal(isReplyableMessage(baseRow({ kind: 'recalled' })), false);
});

test('D3 系统通知 → 不可回复', () => {
  assert.equal(isReplyableMessage(baseRow({ kind: 'system-notice' })), false);
});

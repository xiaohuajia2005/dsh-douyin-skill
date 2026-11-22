// ============================================================
// 配置接线对照测试 —— 迭代 2（观看决策 / 主动开口 / 说话方式）
//
// fixture 由迁移脚本从重构前 chat-agent.mjs 程序化提取，非人工转写。
// 与 W1/W2 同一纪律：装配结果必须与冻结原文逐字节一致。
// 想改文案 → 改 config/behavior.json，并有意更新 fixture；测试意外失败
// 说明有人动了装配逻辑或 JSON，不是"测试太严"。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildStyleGuide, buildProactiveGuidance, buildProactiveOpening, buildWatchDecisionPrompt,
  buildMemoryExtractPrompts, buildVideoDescribeSystem, buildVideoMetadataPrefix, buildSimplifySystem,
} from '../agent/prompts.mjs';
import { behaviorConfig } from '../config/loader.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const SAMPLE_REPLY = '今天好累啊';
const SAMPLE_GREET = '在吗';

test('W5 说话方式 STYLE_GUIDE = 重构前原文（逐字节）', () => {
  assert.equal(buildStyleGuide(), fixture('original-style-guide.txt'));
});

test('W6 主动开口总规则 PROACTIVE_GUIDANCE = 重构前原文（逐字节）', () => {
  assert.equal(buildProactiveGuidance(), fixture('original-proactive-guidance.txt'));
});

test('W7 观看决策 system = 静态原文 + JSON.stringify(watchContext)', () => {
  for (const ctx of [
    { persona: '', interests: [], previousNote: '', segments: 1, playbackProgressSeconds: null, frames: null, reachedEnd: false },
    { persona: '大肥鱼', interests: [{ topic: '猫', signal: 'like' }], previousNote: '上一批看到水面', segments: 3, playbackProgressSeconds: 12.5, frames: 16, reachedEnd: true },
  ]) {
    assert.equal(buildWatchDecisionPrompt(ctx), fixture('original-watch-system.txt') + JSON.stringify(ctx));
  }
});

test('W8 接话模板（有上一条原文）= 重构前渲染结果', () => {
  assert.equal(buildProactiveOpening('reply-pending', SAMPLE_REPLY),
    fixture('original-proactive-reply-pending.txt'));
});

test('W9 普通问候模板（有上一条原文）= 重构前渲染结果', () => {
  assert.equal(buildProactiveOpening('greet', SAMPLE_GREET),
    fixture('original-proactive-greet.txt'));
});

test('W10 上一条为空时走各自默认值，且与原文一致', () => {
  assert.equal(buildProactiveOpening('reply-pending', ''),
    fixture('original-proactive-reply-pending-empty.txt'));
  assert.equal(buildProactiveOpening('greet', ''),
    fixture('original-proactive-greet-empty.txt'));
});

test('W11 非 reply-pending 一律走问候分支；插值含 $& 时按字面插入', () => {
  // 原三元表达式只有 'reply-pending' 一个特例，其余值（含 undefined）都进 else 分支
  assert.equal(buildProactiveOpening('whatever', SAMPLE_GREET),
    fixture('original-proactive-greet.txt'));
  assert.equal(buildProactiveOpening(undefined, SAMPLE_GREET),
    fixture('original-proactive-greet.txt'));
  // 函数形式替换的回归锁：'价$&格' 不能被 String.replace 解释成匹配串
  const weird = '价$&格';
  const expected = fixture('original-proactive-reply-pending.txt')
    .replace(SAMPLE_REPLY, () => weird);
  assert.equal(buildProactiveOpening('reply-pending', weird), expected);
  assert.ok(expected.includes('「价$&格」'));
});

test('W12 behavior.json v4 字段完整、冻结、占位符唯一', () => {
  const b = behaviorConfig();
  assert.equal(b.version, 4);
  assert.equal(Object.isFrozen(b), true);
  for (const value of [b.styleGuide, b.proactive.guidance, b.watch.systemPrompt]) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0);
  }
  for (const pick of [b.proactive.openings.replyPending, b.proactive.openings.greet]) {
    assert.equal(typeof pick.template, 'string');
    assert.equal(pick.template.split('{{lastText}}').length - 1, 1, '模板里应恰好一个占位符');
    assert.equal(typeof pick.emptyLastText, 'string');
    assert.ok(pick.emptyLastText.length > 0);
  }
  assert.equal(b.proactive.openings.replyPending.emptyLastText, '（无文字，可能是附件）');
  assert.equal(b.proactive.openings.greet.emptyLastText, '（无）');
  assert.ok(b.watch.systemPrompt.endsWith('\n本机共同人格与当前观看进度：'));
  // 迭代 3 新增：memory / video / simplify
  for (const value of [b.memory.extractSystem, b.video.describeSystem, b.video.metadataPrefix, b.simplify.system]) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0);
  }
  assert.equal(typeof b.memory.extractUser.template, 'string');
  assert.equal(b.memory.extractUser.template.split('{{known}}').length - 1, 1);
  assert.equal(b.memory.extractUser.template.split('{{history}}').length - 1, 1);
  assert.equal(b.memory.extractUser.emptyKnown, '（空）');
});

// ---- 迭代 3：子任务 system 与记忆整理模板 ----

const HISTORY = '对方：在吗\n我：在';

test('W13 记忆整理 system = 重构前原文（逐字节）', () => {
  const { system } = buildMemoryExtractPrompts({ known: '', history: HISTORY });
  assert.equal(system, fixture('original-memory-extract-system.txt'));
});

test('W14 记忆整理 user（有历史记忆）= 重构前渲染结果', () => {
  const { user } = buildMemoryExtractPrompts({ known: '喜欢猫', history: HISTORY });
  assert.equal(user, fixture('original-memory-extract-user-known.txt'));
});

test('W15 记忆整理 user（无历史记忆）走「（空）」默认值', () => {
  const { user } = buildMemoryExtractPrompts({ known: '', history: HISTORY });
  assert.equal(user, fixture('original-memory-extract-user-empty.txt'));
  assert.ok(user.includes('（空）'));
});

test('W16 视频描述 system 与元数据前缀 = 重构前原文', () => {
  assert.equal(buildVideoDescribeSystem(), fixture('original-video-describe-system.txt'));
  assert.equal(buildVideoMetadataPrefix(), fixture('original-video-metadata-prefix.txt'));
});

test('W17 简体转换 system = 重构前原文（逐字节）', () => {
  assert.equal(buildSimplifySystem(), fixture('original-simplify-system.txt'));
});

test('W18 记忆模板插值含 $& 时按字面插入', () => {
  const { user } = buildMemoryExtractPrompts({ known: '价$&格', history: HISTORY });
  const expected = fixture('original-memory-extract-user-known.txt').replace('喜欢猫', () => '价$&格');
  assert.equal(user, expected);
  assert.ok(expected.includes('价$&格'));
});

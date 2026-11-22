// ============================================================
// 配置接线对照测试 —— 迭代 1
//
// fixture 是重构前 chat-agent.mjs 硬编码文案的冻结快照（由迁移脚本
// 从源码程序化提取，非人工转写）。装配结果必须与 fixture 逐字节一致：
//  - 想改文案 → 改 config/behavior.json，并**同时有意更新** fixture 与本说明；
//  - 测试意外失败 → 说明有人直接改了装配逻辑或 JSON，不是"测试太严"。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildChatPrompt, buildEmojiGuidance } from '../agent/prompts.mjs';
import { behaviorConfig } from '../config/loader.mjs';

const fixture = name =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('W1 聊天提示词拼装 = 重构前硬编码原文（逐字节）', () => {
  assert.equal(buildChatPrompt(), fixture('original-prompt.txt'));
});

test('W2 表情规则拼装 = 重构前硬编码原文 + 允许列表（逐字节）', () => {
  const allowedEmoji = [{ id: '7211', remark: '鲸鱼表情', kind: 'collected' }];
  assert.equal(buildEmojiGuidance(allowedEmoji),
    fixture('original-emoji-guidance.txt') + JSON.stringify(allowedEmoji));
});

test('W3 表情规则在空列表时输出仍以 JSON 数组结尾', () => {
  const out = buildEmojiGuidance([]);
  assert.ok(out.endsWith('[]'), '结尾必须是 JSON.stringify([])');
  assert.ok(out.startsWith('\n\n'), '开头必须保留 \\n\\n 引导');
});

test('W4 行为配置已冻结且 12 段齐全', () => {
  const behavior = behaviorConfig();
  assert.equal(Object.isFrozen(behavior), true);
  const keys = Object.keys(behavior.chat.promptParagraphs);
  assert.equal(keys.length, 12);
  assert.ok(keys.every(key => typeof behavior.chat.promptParagraphs[key] === 'string' && behavior.chat.promptParagraphs[key].length > 0));
  assert.equal(typeof behavior.emoji.guidance, 'string');
});

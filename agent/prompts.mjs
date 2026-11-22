// agent/prompts.mjs —— 提示词装配（迭代 1/2 从 chat-agent.mjs 抽出）
//
// 职责：从 config/behavior.json 读行为规则文案，拼装成与重构前**逐字节一致**的提示词段。
// 契约：tests/ 下对照测试用 tests/fixtures/ 里冻结的重构前原文做逐字节比对，
//       所以"改文案"只应发生在 config/behavior.json，测试失败 = 文案被无意识改动。
// 注意：chat-agent.mjs 顶层常量在模块加载时求值一次，改配置需重启插件生效。
import { behaviorConfig } from '../config/loader.mjs';

// 段落顺序是提示词语义的一部分，显式声明而不是依赖 JSON 键序。
const PARAGRAPH_ORDER = [
  'boundary', 'personaCard', 'personaCardRole', 'languageStyle', 'rhythm',
  'mediaReaction', 'multiPart', 'metadataScope', 'realWorldActions',
  'noFalseStatus', 'promptInjection', 'outputContract',
];

export function buildChatPrompt() {
  const paragraphs = behaviorConfig().chat.promptParagraphs;
  return PARAGRAPH_ORDER.map(key => {
    const value = paragraphs[key];
    if (typeof value !== 'string') throw new Error(`config/behavior.json 缺少段落 chat.promptParagraphs.${key}`);
    return value;
  }).join('\n');
}

export function buildEmojiGuidance(allowedEmoji) {
  const guidance = behaviorConfig().emoji.guidance;
  if (typeof guidance !== 'string') throw new Error('config/behavior.json 缺少 emoji.guidance');
  return guidance + JSON.stringify(allowedEmoji);
}

// ---- 迭代 2：说话方式 / 主动开口 / 观看决策 ----

export function buildStyleGuide() {
  const value = behaviorConfig().styleGuide;
  if (typeof value !== 'string') throw new Error('config/behavior.json 缺少 styleGuide');
  return value;
}

export function buildProactiveGuidance() {
  const value = behaviorConfig().proactive?.guidance;
  if (typeof value !== 'string') throw new Error('config/behavior.json 缺少 proactive.guidance');
  return value;
}

// kind === 'reply-pending' → 接上对方最后一条；其余值（含 'greet'）→ 全新问候。
// 分支条件与重构前的三元表达式完全一致，不要"顺手"改成枚举校验。
export function buildProactiveOpening(kind, lastText) {
  const openings = behaviorConfig().proactive?.openings;
  const pick = kind === 'reply-pending' ? openings?.replyPending : openings?.greet;
  if (typeof pick?.template !== 'string' || typeof pick?.emptyLastText !== 'string') {
    throw new Error('config/behavior.json 缺少 proactive.openings 模板');
  }
  // 用函数形式替换：lastText 可能含 $& 等 String.replace 特殊序列，必须按字面插入，
  // 与原模板字符串 `${proactiveLastText || '默认值'}` 的语义保持一致。
  const value = lastText || pick.emptyLastText;
  return pick.template.replace('{{lastText}}', () => value);
}

export function buildWatchDecisionPrompt(watchContext) {
  const value = behaviorConfig().watch?.systemPrompt;
  if (typeof value !== 'string') throw new Error('config/behavior.json 缺少 watch.systemPrompt');
  return value + JSON.stringify(watchContext);
}

// ---- 迭代 3：子任务 system 与记忆整理模板 ----

export function buildMemoryExtractPrompts({ known, history } = {}) {
  const conf = behaviorConfig().memory;
  const system = conf?.extractSystem;
  const template = conf?.extractUser?.template;
  const emptyKnown = conf?.extractUser?.emptyKnown;
  if (typeof system !== 'string' || typeof template !== 'string' || typeof emptyKnown !== 'string') {
    throw new Error('config/behavior.json 缺少 memory.extractSystem / extractUser');
  }
  // 与原模板 `${known || '（空）'}` / `${history}` 同义；函数形式替换防止 $& 被当替换模式
  const user = template
    .replace('{{known}}', () => known || emptyKnown)
    .replace('{{history}}', () => history);
  return { system, user };
}

export function buildVideoDescribeSystem() {
  const value = behaviorConfig().video?.describeSystem;
  if (typeof value !== 'string') throw new Error('config/behavior.json 缺少 video.describeSystem');
  return value;
}

export function buildVideoMetadataPrefix() {
  const value = behaviorConfig().video?.metadataPrefix;
  if (typeof value !== 'string') throw new Error('config/behavior.json 缺少 video.metadataPrefix');
  return value;
}

export function buildSimplifySystem() {
  const value = behaviorConfig().simplify?.system;
  if (typeof value !== 'string') throw new Error('config/behavior.json 缺少 simplify.system');
  return value;
}

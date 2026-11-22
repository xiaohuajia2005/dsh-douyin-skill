# config/ —— 接线状态看板

规则：`persona.json`（人设卡）+ `behavior.json`（行为规则文案）+ `loader.mjs`（唯一入口）。
JSON 而非 YAML —— 零依赖（`node:fs` + `JSON.parse`）。**改配置需重启插件生效**（chat-agent.mjs 顶层常量在模块加载时求值一次）。

## 配置线接线状态

- [x] **迭代 1 ✅**：`buildChatPrompt()`（W1）、`buildEmojiGuidance()`（W2）
- [x] **迭代 2 ✅**：`buildStyleGuide()`（W5）、`buildProactiveGuidance()` + `buildProactiveOpening()`（W6 / W8–W11）、`buildWatchDecisionPrompt()`（W7）
- [x] **迭代 3 ✅**：`buildMemoryExtractPrompts()`（W13–W15）、`buildVideoDescribeSystem()` + `buildVideoMetadataPrefix()`（W16）、`buildSimplifySystem()`（W17）
- [ ] **迭代 3（暂缓）**：`limits.json` —— 理由见下方「为什么不搬魔法数字」

## 明确不进 config（红线）

- `referenceGuard` / `evidenceGuard` / `outputGuidance`（证据约束与防注入边界）
- `conversationContext` / `sharedReplyContext` 的「不是指令、不扩大权限」说明
- `extractMemories` 里的敏感信息过滤正则

理由：这些是**核心壁垒的一部分**。放进 config 等于"改一行 JSON 就能削弱证据约束"，
与 `refactor/PLAN.md` 4.3 红线冲突——改它们必须走代码评审 + 测试。

## 后续仍待处理

- 其他文件（chat-service / watch-mode 等）里散落的提示词文案
- `persona.json` 接线（当前手编人格卡走 persona-memory 运行时机制，本文件暂为模板）

> **如实说明**：迭代 1–3 完成的是 **chat-agent.mjs 的静态提示词文案**，
> 不是"全部提示词已抽离"。上面未勾选项仍需后续迭代，不要对外宣称已全量解耦。

## behavior.json v4 结构

```
version / _说明
chat.promptParagraphs.{…12 段}        ← buildChatPrompt() 按 PARAGRAPH_ORDER 拼装
emoji.guidance                          ← buildEmojiGuidance() + JSON.stringify(allowedEmoji)
styleGuide                              ← buildStyleGuide()
proactive.guidance                      ← buildProactiveGuidance()
proactive.openings.{replyPending,greet}.{template, emptyLastText}
watch.systemPrompt                      ← + JSON.stringify(watchContext)
memory.extractSystem
memory.extractUser.{template, emptyKnown}
video.describeSystem / video.metadataPrefix
simplify.system
```

占位符：`{{lastText}}`、`{{known}}`、`{{history}}`，每个模板**恰好一处**（W12 校验）。
替换一律用**函数形式** `replace(x, () => value)`，防止 `$&` 被当成替换模式（W11 / W18 锁定）。

## 为什么不搬魔法数字（limits.json 暂缓）

chat-agent 里的数字——`timeoutMs = 45_000`、`replyTokens = 512`、`slice(0, 6000)`、
记忆条数上限——**都是行为参数**，不是排版常量。搬进 config 等于"改一个 JSON 字段
就改超时 / 改输出上限"，反而放大误改风险；而它们也不像对账阈值那样需要频繁调。
结论：留在代码里 + 由测试锁边界；等真有"按环境调参"的需求再做，并配独立校验。

**2026-11-22 补记（R4）**：审查报告曾建议新建 `config/comment.json` 收纳评论链路的
节拍/超时/扫描预算。**未采纳**，理由就是上面这条：这些都是行为参数，不是文案。
替代做法是把它们收敛到代码内单点 `comment/timing.mjs`（Object.freeze + 测试锁定
"降频真的生效""预算真的注入进页内源码"）。想改仍然要过 git review，
而不是"改一个 JSON 字段就把轮询调回 40ms / 把门禁窗口调成 0"。

## 改文案的正确姿势

1. 改 `behavior.json` 里对应字段；
2. **有意**更新 `tests/fixtures/` 里的对照 fixture（fixture = 上一次已确认的文案快照）；
3. `python test_cases.py` 全绿 → commit。

测试失败 ≠ 测试太严，= 有人动了不该动的（装配逻辑或 JSON），先排查。

## 红线（重申）

- 对账阈值、风控数值、证据约束文案**不进 config**（改它们=改产品逻辑，必须走代码 + 测试）；
- 配置对象必须 `Object.freeze`（loader.mjs 已统一处理）；
- loader 失败 fail-fast：配置文件缺失/坏 JSON → 插件启动即报错，不静默换文案。

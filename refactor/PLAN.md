# 渐进式重构方案 —— 拟人社交代理可靠性打磨

> 版本：2026-11-21 ｜ 基线提交：`0630151`（1.4.6 上游 + 本地二次开发完整快照）
> 原则：**不一次性重写**。每次迭代只动一个关注点，动前有特征测试兜底，动后全绿才算完成。

---

## 0. 三条铁律（先于一切具体方案）

1. **先测试，后拆分。** 任何文件拆动之前，先在 `tests/` 里为它的现有行为补特征测试；
   拆完跑 `python test_cases.py`，输出与拆前完全一致才算通过。
2. **巨型文件先"抽函数"，不"搬文件"。** 在原文件内部把职责块抽成命名函数/常量区，
   内聚边界清晰之后，下一个迭代才把整块搬进子目录，原路径留门面 re-export。
3. **`?v=9` 缓存参数一律不动。** `import ... from './core.mjs?v=9'` 是手工缓存戳，
   旧方案里它兼任"版本管理"；Git 接入后它失去版本语义，但清理它会改动全部 import 行，
   风险与收益不成比例。等仓库稳定运行一个月后单独评估。

---

## 1. 现状盘点（2026-11-21 实测，不是估计）

| 项 | 实测值 | 影响 |
|---|---|---|
| 源文件 | 57 个 `.mjs`，全部平铺在包根目录 | 已有命名边界，但无分层 |
| 巨型文件 | chat-browser 183K / chat-service 146K / core 98K / comment-browser 56K | 四个泥球核心 |
| 手工备份 | 35 个 `.bak*`（11/12～11/21，多轮叠加） | 无 diff、无回滚粒度、易错删 |
| 运行时数据 | `state/` 30MB（真实私信 JSONL、水位、锁） | **绝不能进 Git**（已隔离） |
| 人设硬编码 | PROMPT/STYLE_GUIDE/表情规则/主动开口文案等散在 ≥8 个文件 | 改话术要动业务代码 |
| 模块级可变状态 | 四个巨型文件均为 0（`let/var` 顶层不存在） | ②的"禁全局"已有基础 |
| 配置模块 | task-limits / video-limits 已是 `Object.freeze + validate` 形态 | 抽配置有现成范式可循 |

**核心壁垒代码的位置**（重构时只加测试、不搬家、不改语义）：

| 壁垒 | 文件 | 函数/类 |
|---|---|---|
| 消息指纹（防误判） | chat-message.mjs | `messageFingerprint` |
| 水位对账 | chat-message.mjs | `messageWatermark` / `compareMessageWatermark` |
| 身份核对/重复校验 | message-tracker.mjs | `MessageIdentityTracker` |
| 已读水位持久化 | state/chat-watermarks.json（运行时）+ chat-browser/chat-service 读写 | 水位采集与回写 |
| 回复时序埋点 | chat-service.mjs | `reply.timing` 事件 |

---

## 2. 目标目录结构（①）

**分两步走，不搬家：**

**Phase A（已随基线提交完成）** —— 保持平铺，只新增三个目录：

```text
dsh-douyin-browser-local/
├─ *.mjs                # 57 个现有源文件，位置一律不动
├─ config/              # 【新增】配置层（见第 4 节）
│  ├─ persona.json       #   人设卡（称呼、性格、语言习惯）
│  ├─ behavior.json      #   行为规则文案（提示词里的规则段）
│  └─ _README.md         #   接线状态说明
├─ tests/               # 【新增】特征测试
│  └─ evidence.test.mjs  #   对账/防误判/重复校验，21 条
├─ test_cases.py        # 【新增】测试入口（python test_cases.py）
├─ refactor/            # 【新增】重构文档
│  ├─ PLAN.md            #   本文件
│  └─ git-workflow.md    #   Git 方案与回滚手册
├─ state/               # 运行时数据（.gitignore 已隔离）
└─ docs/                # 上游文档
```

**Phase B（后续迭代逐步发生）** —— 从巨型文件抽出的**新模块**按层落目录，
**原文件原地保留，缩成门面**：

```text
├─ evidence/            # 证据对账层（核心壁垒）
│  ├─ fingerprint.mjs    #   ← 迭代 7 已落地：messageFingerprint / messageContent
│  ├─ watermark.mjs      #   ← 迭代 7 已落地：messageWatermark / compareMessageWatermark
│  ├─ rows.mjs           #   ← 迭代 5 已落地：原始行 → 可对账公开消息（纯映射）
│  ├─ admission.mjs      #   ← 迭代 8 已落地：isMetadataMessage / isReplyableMessage（能不能回）
│  ├─ backlog.mjs        #   ← 迭代 8 已落地：待答资格 / 补答 / 目标映射 / 出站读回
│  ├─ contact-key.mjs    #   ← 迭代 9 已落地：会话身份锚点/conv ID/授权绑定/v2 三元组
│  ├─ authorization.mjs  #   ← 迭代 10 已落地：授权判定 + sameWeakConversation（包根同名文件=门面）
│  ├─ video-progress.mjs #   ← 迭代 12 已落地：playbackProgress（播放推进核验，返回秒数或 null）
│  ├─ unanswered-ledger.mjs # ← 迭代 14 已落地：待答清单/recordId/快照（原 chat-service 内联）
│  ├─ recovery.mjs       #   ← 迭代 15 已落地：recoveryEvidence / recoverableIncoming（重启续发闸门）
│  ├─ shared-work-ref.mjs #  ← 迭代 16 已落地：referencedSharedWork（分享作品引用推断）
│  ├─ video-sample.mjs   #   ← 迭代 17 已落地：verifiedSharedVideoSample（分享视频采样核验）
│  ├─ mentions.mjs       #   ← 迭代 18 已落地：群聊提及判定（包根 group-reply-trigger.mjs=门面）
│  ├─ session-guard.mjs  #   ← 迭代 19 已落地：许可/快照/发送前复核四道闸门
│  └─ identity.mjs       #   ← 迭代 6 已落地：MessageIdentityTracker（包根同名文件=门面）
├─ browser/            # 浏览器驱动层（页面选择器、翻页、发射动作）
├─ agent/              # 人格&记忆层（提示词装配、persona-memory 接线）
│  ├─ prompts.mjs        #   ← 迭代 1–3 已落地：提示词/表情/主动开口装配
│  └─ projection.mjs     #   ← 迭代 8 已落地：chatMessageSummary（给模型看什么）
├─ service/            # 常驻任务层（轮询调度、每日任务、暂停/恢复）
│  ├─ reply-timing.mjs   #   ← 迭代 4 已落地：reply.timing 纯计算
│  ├─ day-decision.mjs   #   ← 迭代 11 已落地：analyzeConversationDay（今天能不能主动问候）
│  └─ host-readiness.mjs #  ← 迭代 13 已落地：dedicatedHostReadiness（宿主就绪四态）
├─ llm/                # LLM 调用层（模型路由、重试、预算）
└─ *.mjs               # 原文件 = 门面：只保留 import + re-export，import 路径不变
```

> 为什么门面而不是直接改 import：全部 import 带 `?v=` 缓存戳，改一行 import
> 就是一次可避免的回归风险。门面模式让"调用方零改动"，拆完的模块换回滚也只是
> 恢复门面文件一行 re-export。

---

## 3. 模块职责与接口约定（②）

### 3.1 分层职责表

| 层 | 职责（唯一） | 现有对应文件 | 依赖方向 |
|---|---|---|---|
| 浏览器驱动层 | DOM 选择器、翻页、截图、发消息的"手" | chat-browser / comment-browser / autonomous-watch | 只被 service 调；**不 import agent** |
| 人格&记忆层 | 提示词装配、人格卡、兴趣记忆 | chat-agent / persona-memory / native-persona-context | 读 config；可调 llm |
| 证据对账层 | 消息身份、指纹、水位、新消息判定 | chat-message / message-tracker / receipt-baseline | 纯函数，**零浏览器依赖** |
| 常驻任务层 | 轮询节奏、暂停/恢复、每日额度 | chat-service / spark-service / watch-mode / daily-report | 编排 browser+agent+evidence |
| LLM 调用层 | 模型调用、超时重试、密钥 | api-agent / native-model-settings / spark-agent | 谁都不 import（最底层） |
| 配置层 | 人设、文案、开关、限额的唯一来源 | config/*.json + task-limits / video-limits | 被读，不读人 |

依赖方向必须单向：`service → agent → llm`，`service → browser → evidence`。
**evidence 不依赖任何层**（这是它能被离线测试的原因，也是壁垒的一部分）。

### 3.2 模块间调用规约

- 只通过函数/方法调用与参数传递；模块间共享数据一律走返回值，不走全局可变量。
  （现状已经满足：四个巨型文件模块级 `let/var` 为 0，保持住。）
- 导出的常量配置必须 `Object.freeze`，与 task-limits / video-limits 的既有形态一致：
  `export const DEFAULT_X_POLICY = Object.freeze({...})` + `export function validateXPolicy()`。
- 新增回归检查：提交前 `grep -nE "^(let|var) " <file>.mjs` 应保持 0 命中。

### 3.3 证据对账层接口规范（⑤，核心壁垒）

这一层**现在不搬家、不改语义**，只把契约写死，防止后续重构踩线。

**输入**（原始窗口行，由浏览器层采集）：

```js
{
  id: 'dom-3',              // 窗口内位置标识（非永久身份）
  nativeId: 'n3',           // 抖音服务端消息 ID（可能缺失）
  sender: 'incoming',       // incoming | outgoing
  kind: 'text',             // text | quote | recalled | system-notice | ...
  text: '今天也要加油鸭',
  order: 2,                 // 相对序号（相对模式必须给）
  orderMode: 'relative',    // relative | absolute，同窗口必须一致
  latestEndVerified: true,  // 窗口末尾是否已核实到最新
  media: { type: 'shared-work', videoId: '...', ... }  // 可选
}
```

**输出**（核对后的行，`MessageIdentityTracker.identify()` 的实际返回）：

```js
{
  id: 'msg:<sha256>',       // 跨窗口稳定的身份 ID
  arrivalClassification:    // 'baseline' | 'known-old-window' | 'old-history'
                           // | 'new-tail' | 'ambiguous-new'
  eligibleForReply: true,   // 仅 new-tail 为 true —— 自动回复的唯一闸门
  identitySource: 'dom-message-id' | 'chronological-window-overlap',
  sentAt: row.timestamp,
}
```

**行为不变量**（已在 `tests/evidence.test.mjs` 锁定，改任何一条前先改测试）：

| # | 不变量 | 锁定用例 |
|---|---|---|
| I1 | 同窗口 nativeId 重复 → 抛异常停止回复，宁可不回不可误回 | C1 |
| I2 | 同窗口顺序模式混排 → 抛异常 | C2 |
| I3 | 首次识别只建 baseline，不产生回复资格 | C3 |
| I4 | 同窗口重复识别 → ID 必须稳定复用（known-old-window） | C4 |
| I5 | 只有"已核实水位之后 + 带身份凭据"的新消息才 eligibleForReply | C5 / C6 |
| I6 | 展示时间不参与指纹（A2）；分享卡片异步封面不参与指纹（A3） | A2 / A3 |
| I7 | 分享卡片的身份字段（videoId 等）变化必须换指纹 | A4 |
| I8 | 水位核对：前缀补载可容忍（B5），锚点丢失/内容改动/未经核实尾部一律拒绝 | B2–B5 |
| I9 | 撤回/系统消息不可回复 | D2 / D3 |

**搬迁（Phase B）的唯一允许方式**（迭代 6 已按此执行，可作为后续模板）：
`git mv <实现>.mjs evidence/<层>.mjs` 保留历史 → 只改被搬文件的相对 import →
原路径留门面 `export { X } from './evidence/<层>.mjs'` → 跑 `python test_cases.py` 全绿 →
`diff` 断言函数体逐字节一致。一次迭代只搬一个文件。

---

## 4. 配置抽离（③）

### 4.1 文件与职责

| 文件 | 放什么 | 不放什么 |
|---|---|---|
| `config/persona.json` | 称呼、性格、语言习惯、句长、表情偏好 | 行为边界规则 |
| `config/behavior.json` | 提示词里的规则文案（接话规则、表情协议、主动开口话术、观看决策输出格式） | 人设本身 |
| `config/limits.json`（迭代 3） | 散落的魔法数字（冷却、窗口、阈值） | —— task-limits/video-limits 已管的不重复 |

模板已放在 `config/`，字段值取自当前 chat-agent.mjs 的硬编码原文（见 `_README.md`）。

### 4.2 接线方式（迭代 1 执行，一处一处来）

```js
// config/loader.mjs —— 迭代1新增，唯一的配置入口
import { readFileSync } from 'node:fs';
const load = name => {
  const raw = JSON.parse(readFileSync(new URL(`../config/${name}.json`, import.meta.url), 'utf8'));
  return Object.freeze(raw);   // 沿用 freeze 纪律
};
export const personaConfig = () => load('persona');
export const behaviorConfig = () => load('behavior');
```

- 迭代 1 接 **PROMPT 12 段 + 表情规则两处**；迭代 2 用同一套迁移脚本接
  **styleGuide / proactive / watch 三组**。每次 diff 应只包含"字符串字面量 → 装配函数调用"；
- 每接一个关注点提交一次：`refactor(iter-N): ...`，提交前 `python test_cases.py` 全绿；
- 接线状态记在 `config/_README.md`，接完一处划掉一处；**未勾选项不要对外宣称已完成**。

### 4.3 红线

- 配置只放"改了不用过脑子"的内容；**对账阈值、风控数值不进 config**（改它们=改产品逻辑，必须走代码评审 + 测试）。
- JSON 而非 YAML：零依赖（`node:fs` + `JSON.parse`），与本地 Demo 定位一致。

---

## 5. 执行节奏（⑦）

| 迭代 | 线 | 内容 | 验收 | 风险 |
|---|---|---|---|---|
| **0 ✅** | 基建 | Git 基线 + state/隔离 + 特征测试 21 条 + 本方案 | `python test_cases.py` 全绿；`git status` 干净 | 无（纯新增） |
| **1 ✅** | 配置 | PROMPT 12 段 + 表情规则接线；.bak 退役（35 个入库 bak-archive 后删除） | 25 条全绿；import ok；fixture 逐字节一致 | 低（diff 仅 3 处） |
| **2 ✅** | 配置 | 观看决策输出格式 + 主动开口文案 + STYLE_GUIDE 接线（behavior.json v3） | 33 条全绿；import ok；新增 8 条逐字节对照 | 低（diff 仅 5 处） |
| **3 ✅** | 配置 | 子任务 system + 记忆整理模板（memory / video / simplify）；`limits.json` 评估后暂缓 | 39 条全绿；逐字节对照 | 低 |
| **4 ✅** | 结构 | reply.timing 纯计算抽 `service/reply-timing.mjs`，采集时机留在原处 | 44 条全绿；字段/键序/算法不变 | 低（diff 2 行） |
| **5 ✅** | 结构 | 采集层：chat-browser `publicMessages()` 的行正规化抽到 `evidence/rows.mjs`；语音资源登记与 `identities.identify()` 留在原处 | 54 条全绿；R1–R8 锁字段/键序/哈希口径，R9–R10 与旧实现逐字节等价 | 低（diff 1 段） |
| **6 ✅** | 结构 | message-tracker.mjs → evidence/identity.mjs 搬迁（第一个真搬家，从最小的开始） | 54 条全绿；函数体 199 行逐字节一致；门面 re-export，调用方零改动 | 中 |
| **7 ✅** | 结构 | `chat-message.mjs` 拆指纹族（fingerprint.mjs）与水位族（watermark.mjs）进 evidence/；`identity.mjs` 改同层导入 | 62 条全绿；4 段函数体逐字节一致；导出面 12 个不变 | 中 |
| **8 ✅** | 结构 | `chat-message.mjs` 剩下三块全部搬走：准入→`evidence/admission.mjs`、backlog 族→`evidence/backlog.mjs`、投影→`agent/projection.mjs` | 62 条全绿；三段逐字节一致；`chat-message.mjs` 只剩 19 行门面 | 中 |
| **9 ✅** | 结构 | 会话身份派生 7 个纯函数 → `evidence/contact-key.mjs`（chat-browser 首次缩小） | 72 条全绿；搬家块逐字节一致；chat-browser 1969→1961 行 | 中（身份错误=发错人，故新增 10 条特征测试兜底） |
| **10 ✅** | 结构 | `contact-authorization.mjs` → `evidence/authorization.mjs`，`sameWeakConversation` 一并搬入（身份 + 授权同层闭环） | 83 条全绿；7 个调用方零改动；授权层首次有测试 | 中（授权错=发给陌生人，本轮新增 11 条 fail-closed 特征测试） |
| **11 ✅** | 结构 | `analyzeConversationDay` 抽 `service/day-decision.mjs`（今天能不能主动问候） | 95 条全绿；搬家块逐字节一致；chat-browser 1954→1924 行 | 中（该函数此前零覆盖，新增 12 条状态机特征测试） |
| **12 ✅** | 结构 | `core.mjs` 的 `sharedProgress` → `evidence/video-progress.mjs`（播放推进核验，5 处调用） | 106 条全绿；函数体逐字节一致（仅改名 playbackProgress） | 中（"视频真的播了"的唯一数学依据，此前零覆盖） |
| **13 ✅** | 结构 | `core.mjs` 的 `dedicatedHostReadiness` → `service/host-readiness.mjs`（四态 + 注入式 processAlive） | 114 条全绿；core 导出面 7 个不变；函数体逐字节一致 | 低（7 行，但判错会连错浏览器或干等超时） |
| **14 ✅** | 结构 | `chat-service.mjs` 的待答清单九函数 → `evidence/unanswered-ledger.mjs`（recordId/快照/计数/预览） | 125 条全绿；15 行逐字节一致；chat-service 1538→1527 | 中（recordId 一漂，历史待答在界面里"消失又重现"） |
| **15 ✅** | 结构 | `chat-service.mjs` 的 `recoveryEvidence`/`recoverableIncoming` → `evidence/recovery.mjs`（重启续发闸门） | 140 条全绿；15 行逐字节一致（时钟也未动）；chat-service 1527→1513 | 高（判错=重发一条可能已发出的消息） |
| **16 ✅** | 结构 | `chat-service.mjs` 的 `referencedSharedWork` → `evidence/shared-work-ref.mjs`（分享作品引用推断） | 151 条全绿；18 行逐字节一致；chat-service 1513→1495 | 中（猜错就是评论一个对方没提的作品） |
| **17 ✅** | 结构 | `chat-service.mjs` 的 `verifiedSharedVideoSample` → `evidence/video-sample.mjs`（采样结构完整性） | 162 条全绿；7 行逐字节一致；chat-service 1495→1488 | 中（证据不全却去夸人 = 睁眼说瞎话） |
| **18 ✅** | 结构 | `group-reply-trigger.mjs` → `evidence/mentions.mjs`（群聊提及判定，包根留门面） | 174 条全绿；12 行逐字节一致（纯搬迁，连 export 都不用改） | 中（误判会在群里对无关发言插嘴） |
| **19 ✅** | 结构 | `validatePolicy`/`messagesOf`/`assertConversationSnapshot`/`verifiedAuthorizedContact` → `evidence/session-guard.mjs` | 188 条全绿；27 行逐字节一致；chat-service 1488→1464 | 高（四道闸门全 fail-closed，判错=发给不该发的人） |
| **20+** | 结构 | chat-service 纯函数已清空，剩余为 I/O 与状态机；下一步需给 `chat-browser` 发送/截图区补 DOM 可测点，或转回功能迭代 | — | 高 |

> **迭代 4 的执行偏离**：原计划在 chat-service.mjs（1537 行、依赖浏览器运行时）内部
> 内聚成命名函数，但该文件无法离线导入，内部函数拿不到测试覆盖，违背铁律 1。
> 改为把**纯计算**抽到 `service/reply-timing.mjs` 并单测，三处 `Date.now()` 的采集
> 时机仍留在原位置（"何时取时间戳"本身是埋点语义）。这是 Phase B 的第一个新模块。

> **迭代 5 的执行偏离**：计划写的是"抽水位采集/回写函数区"，但水位文件 I/O
> （`chat-watermarks.json` 的 load/save/persist）在 chat-service.mjs，且与
> 锁所有权、inflight 状态机耦合，动它要连 `delivery-uncertain` 的恢复语义一起改，
> 不是纯抽取。真正可离线测试的"采集口"是 `publicMessages()` 里的行正规化，
> 于是只把这一段抽到 `evidence/rows.mjs`：**纯映射、零浏览器依赖**，
> 语音资源登记（要实例状态）、`identities.identify()`（要身份状态）、
> `markMessages()` 的 DOM 回写（要页面）都留在原位。
> 水位文件格式本次**一行未动**，因此无需"改前后结构一致"这项验收。

> **limits.json 暂缓的理由**：见 `config/_README.md`「为什么不搬魔法数字」——
> 那些数字是行为参数，进 config 会变成"改 JSON 就改行为"，与 4.3 红线冲突。

> **打包白名单（迭代 5 顺带修的既有缺陷）**：`package.json` 的 `files` 是白名单，
> 但新增的 `config/`、`evidence/`、`service/` 以及早就存在的 `meme-wiki.mjs`、
> `memory-star.mjs` 都没登记。本机 `node_modules` 就地运行一切正常，一旦
> `npm pack` 或重新安装就会缺文件、启动即崩。已补齐并用 `tests/package-files.test.mjs`
> （P1–P4）守住：**以后新增目录必须登记 files，否则测试先红**。
> 迭代 8 又抓出同类第三例：整个 `agent/` 目录从未登记（`chat-agent.mjs` 直接
> import `agent/prompts.mjs`），已补 `"agent/"` 并把 P1 的扫描范围扩到 agent/。
> 教训一致：**白名单不会自己长大，落地新目录时必须同步 P1 的扫描范围**。
| **远期** | — | 评估清理 `?v=` 缓存戳；core.mjs 拆工具层 | 一次性专门迭代 + 全量手测 | 中 |

> **编号修订说明（迭代 2）**：原表把"迭代 2"写成 `replyTimingRecord()` 内聚，
> 与 `config/_README.md` 的迭代 2（配置接线）撞号——两条线各自编号所致。
> 现统一为**配置线优先、结构线顺延**：配置接线到迭代 3 收尾，结构拆分从迭代 4 起。
> 配置线的准绳是 `config/_README.md` 看板，本表是总节奏的准绳。

**禁止清单**（任何时候都不做）：

- ❌ 一次性新建全部 Phase B 目录并批量搬文件；
- ❌ 在没有对应特征测试的情况下改 evidence 相关任何函数；
- ❌ 为拆分而拆分：当月不打算动的文件不拆；
- ❌ 微服务/容器/打包器——这是本地 Windows + Edge 常驻服务，进程内模块化就是终点。

**回滚**：任何迭代出问题，`git log --oneline` 找到上一个绿色提交 → `git revert`（已推送历史时）或 `git reset --hard`（未推送时）。详见 `refactor/git-workflow.md`。

---

## 6. 测试运行方式（⑥）

```bash
python test_cases.py     # 唯一入口：调 node --test，解析 TAP，中文摘要
python test_cases.py -v  # 完整 TAP 输出
```

- 用例本体：`tests/*.test.mjs`（零第三方依赖，node:test 内置），当前 **188 条**；
- `evidence.test.mjs` 21 条：防误判（A1–A6）、对账（B1–B6）、重复与身份（C1–C6）、准入（D1–D3）——**核心壁垒，永不因重构改动**；
- `config-wiring.test.mjs` 4 条（W1–W4，迭代 1）、`prompts-config.test.mjs` 14 条（W5–W18，迭代 2–3）：装配结果与 `tests/fixtures/` 冻结原文逐字节对照；
- `reply-timing.test.mjs` 5 条（T1–T5，迭代 4）：reply.timing 的字段名、键序、三个差值算法；
- `layer-hygiene.test.mjs` 4 条（L1–L4，迭代 7）：新层必须 LF、无模块级 let/var、evidence 层不得 import 上层、门面行数上限；
- `contact-key.test.mjs` 10 条（K1–K10，迭代 9）：会话身份锚点优先级、conv 落盘 ID、授权绑定、v2 三元组、`identityHash === conv ID` 不变量、跨模块契约（派生结果必须通过 `hasStableConversationIdentity`）、未知前缀安全失败；
- `session-guard.test.mjs` 14 条（S1–S14，迭代 19）：四道闸门 fail-closed —— 许可记录损坏/名单重复（同 id 换名字也算）/一条失效即整体拒绝、通过时强制 `dailyReplyLimit: null` 并归一昵称、账号需登录或验证时保留队列（含 `code` 与 `needsUserAction`）、消息缺稳定 ID 或方向不明即整份作废、`direction` 补 `sender` 且返回深拷贝、快照身份/会话 ID/类型三处不一致都暂停、类型未知时不擅自判断、人工授权允许改名但换人即拒、老许可必须稳定身份才能升级、升级不能换 id 或类型、连绑定都没有时升不了级；
- `mentions.test.mjs` 12 条（M1–M12，迭代 18）：群聊提及判定 —— 默认昵称、NFKC 全角归一、去零宽字符、只去一层 `@`、归一后去重、1–10 个与 40 字上限（39/40/41 三档）、控制字符与纯空白拒绝、`@`/`@@@` 归一后为空即拒、`mentionedSelf` 直通、正文命中不受大小写与全角影响、自定义列表、正文缺失不误判；
- `video-sample.test.mjs` 11 条（V1–V11，迭代 17）：分享视频采样核验 —— ID 三处同时匹配、暂停状态必须显式 false、推进严格大于 0.1 秒、时间窗 ±0.25 秒闭区间（边界帧通过 / 差 1 毫秒作废）、至少两帧、帧间隔严格大于 0.1 秒、异视频帧不计、非有限时间丢弃、结构缺失不抛错、**首帧按数组顺序而非时间排序**（采集端倒序写入会被判无效而不是静默修正）；
- `shared-work-ref.test.mjs` 11 条（W1–W11，迭代 16）：分享引用推断 —— 已有卡片不再推断、泛问（"喜欢什么视频"/"什么类型"）不算指代、明确指代才回收、只回溯最近 8 条（索引 1 通过 / 索引 0 拒绝的边界）、遇出站即停、跳过 unsupported、context 指纹不符即跳过、群聊同成员才认领（无指代时）、跨成员但有指代放行、memberId 形状不合法不猜、多触发时以最新为准；
- `recovery.test.mjs` 15 条（R1–R15，迭代 15）：重启续发闸门 —— 待发集合混出站即拒、未取得资格即拒、历史合格可继承但指纹不符不继承、`qualifiedAt`/`stopRequestId` 沿用旧值、窗口内容必须逐字节相同、方向不明/指纹不符即拒、最后目标之后已有出站即拒、停止请求 ID 不符即拒（`preservePending` 例外）、双向身份比对；**每条恢复用例先断言证据建立成功**，避免 null 被误当通过；
- `unanswered-ledger.test.mjs` 11 条（U1–U11，迭代 14）：待答清单的确定性 —— recordId 两条分支（archiveId 优先 / legacy 由 phase+时间+incoming 结构决定，**正文不参与**）、跨会话不串号、快照只算未关闭项且与读取顺序无关、autoPendingCount 的四类边界、原因截断 200、消息类型与预览的"不猜测"口径；
- `host-readiness.test.mjs` 8 条（H1–H8，迭代 13）：宿主就绪四态与判定顺序 —— pid 非法不查进程表、死进程立即 failed、旧记录残留只算 pending、归属不符优先 foreign、ready 须严格 true、默认 processAlive 走真实进程表；
- `video-progress.test.mjs` 11 条（V1–V11，迭代 12）：`playbackProgress` 的物理一致性 —— 1x/2x 折算、loop 回绕按圈数、暂停/seek/未就绪作废（要求显式 false）、换视频/元素/源/时间原点作废、双时钟互证（0.35s / 40s 闭区间）、15%（至少 0.2s）偏差上限、微负推进归零；
- `day-decision.test.mjs` 12 条（D1–D12，迭代 11）：`analyzeConversationDay` 四状态机 —— 阻塞态、快照证据（最新端/正序/60 秒闭区间/未来时间戳）、共同账本自身合格性、方向不明即作废、三种日期写法、UTC 与北京时区折算、待回复优先、只认明确证据、"昨天/今天下午/非法日期"不得当成今天；
- `authorization.test.mjs` 11 条（T1–T11，迭代 10）：授权判定全链 fail-closed —— 已核对身份的四个证据、稳定身份的 kind 白名单与 group/user 不互冒充、四条许可路径、许可失效（缺 verifiedAt / 三元组残缺 / 未知类型）、**同名不同人必须拒绝**、following 取关即失效、旧许可只能原地升级、弱比较仅限老许可、群名人数后缀唯一边界；
- `package-files.test.mjs` 4 条（P1–P4，迭代 5 顺带修）：`package.json` 的 `files` 白名单必须覆盖包根/config/evidence/service 全部运行时文件，且不得混入 tests/refactor；
- `rows.test.mjs` 10 条（R1–R10，迭代 5）：字段透传、clientId/member 哈希口径、媒体计数与 resourceRef 取值规则；**R9–R10 是等价性 oracle**——把重构前行内实现原样抄进测试，10 组真实形态逐字节比对；
- 加新用例：在 `tests/` 新建 `*.test.mjs` 即被自动发现；
- **提交前必跑**，全绿再 `git commit`。
